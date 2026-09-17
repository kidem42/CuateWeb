import type { HermesMessage } from '../hermes';
import { hermesServiceNotice, hermesText } from './protocol';

const summaryEnd =
  '--- END OF CONTEXT SUMMARY — respond to the message below, not the summary above ---';
const summaryJoin = '[END OF PRIOR CONTEXT — COMPACTION SUMMARY BELOW]';
const prior = '[PRIOR CONTEXT — for reference only; not a new message]';
const summary = (text: string) => /^\[CONTEXT COMPACTION|^\[CONTEXT SUMMARY\]:/.test(text);
const continuations = new Set([
  'Continue from the compressed conversation context above. This marker exists because no human user turn was available.',
  'Continue from the compressed conversation context above. This marker exists because the compacted transcript contained no preserved user turn.',
]);

export function hermesVisibleUserText(raw: string): string | null {
  const text = raw.trimStart();
  if (summary(text)) {
    const end = text.indexOf(summaryEnd);
    return end < 0 ? null : text.slice(end + summaryEnd.length).trim() || null;
  }
  const join = text.indexOf(summaryJoin);
  if (join >= 0 && summary(text.slice(join + summaryJoin.length).trimStart())) {
    return text.slice(0, join).replace(prior, '').trim() || null;
  }
  if (
    continuations.has(text.trim()) ||
    text.startsWith('[Your active task list was preserved across context compression]')
  )
    return null;
  return raw;
}

export function hermesSteerFrame(text: string): string {
  return (
    '<cuate-addendum>\nThe user is adding to the request you are working on right now: take the addition below into account in the current cycle.\n</cuate-addendum>\n\n' +
    text
  );
}

/** Strip only complete native delivery envelopes; retain incomplete/literal content. */
export function hermesExtractSteers(text: string): { output: string; messages: string[] } {
  const messages: string[] = [];
  const output = text.replace(
    /\[OUT-OF-BAND USER MESSAGE[^\]\n]*\]([\s\S]*?)\[\/OUT-OF-BAND USER MESSAGE\]/g,
    (_whole, body: string) => {
      const pieces = body
        .split(/<cuate-addendum>[\s\S]*?<\/cuate-addendum>/g)
        .map((piece) => piece.trim())
        .filter(Boolean);
      messages.push(...pieces);
      return '';
    },
  );
  return { output: messages.length ? output.trim() : text, messages };
}

export type HermesDisplayRow = HermesMessage & { displaySuffix?: string };
export function hermesDisplayRows(rows: HermesMessage[]): HermesDisplayRow[] {
  const result: HermesDisplayRow[] = [];
  const seen = new Set<number>();
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    if (row.role === 'tool') {
      if (row.tool_name === '_thinking') continue;
      const { output, messages } = hermesExtractSteers(hermesText(row));
      result.push(messages.length ? { ...row, content: output } : row);
      messages.forEach((content, index) =>
        result.push({
          id: row.id,
          role: 'user',
          content,
          timestamp: row.timestamp,
          displaySuffix: `.steer.${index}`,
        }),
      );
      continue;
    }
    if (row.role !== 'user' && row.role !== 'assistant') continue;
    if (row.role !== 'user' || hermesServiceNotice(hermesText(row))) {
      result.push(row);
      continue;
    }
    if (typeof row.content === 'string') {
      const visible = hermesVisibleUserText(row.content);
      if (visible !== null) result.push({ ...row, content: visible });
      continue;
    }
    const content = (row.content ?? []).flatMap((part) => {
      if (part.type !== 'text') return [part];
      const visible = hermesVisibleUserText(part.text ?? '');
      return visible === null ? [] : [{ ...part, text: visible }];
    });
    if (content.length) result.push({ ...row, content });
  }
  return result;
}

/** A stock Wakeup-compatible display, with no invented durable thread identities. */
export function hermesNoticeDisplay(text: string): {
  native: true;
  kind: 'subagent' | 'background_tool';
  tasks: {
    taskId: string;
    status: 'completed' | 'error';
    result: string;
    subagentType?: string;
    toolName?: string;
  }[];
} | null {
  if (!hermesServiceNotice(text)) return null;
  const delegation = text.trimStart().startsWith('[ASYNC DELEGATION');
  const headers = Array.from(text.matchAll(/^--- ([✓✗]) TASK ([^\n]+?) ---[ \t]*$/gm));
  const tasks = headers.map((match, index) => ({
    taskId: `native-task-${index}`,
    status: match[1] === '✗' ? ('error' as const) : ('completed' as const),
    subagentType: match[2],
    result: text
      .slice((match.index ?? 0) + match[0].length, headers[index + 1]?.index ?? text.length)
      .trim(),
  }));
  // Keep the entire delivery available even if Hermes adds an unknown report format.
  const failed =
    /(?:exit code\s+-?[1-9]\d*|failed to start|--- ERROR ---|^Status:\s*(?:failed|error))/m.test(
      text,
    );
  return {
    native: true,
    kind: delegation ? 'subagent' : 'background_tool',
    tasks: tasks.length
      ? tasks.map((task, index) => ({
          ...task,
          result:
            index === 0
              ? text.slice(0, headers[0].index).trim() + '\n\n' + task.result
              : task.result,
        }))
      : [
          {
            taskId: 'native-report',
            status: failed ? 'error' : 'completed',
            result: text,
            ...(delegation ? { subagentType: 'delegate_task' } : { toolName: 'process' }),
          },
        ],
  };
}
