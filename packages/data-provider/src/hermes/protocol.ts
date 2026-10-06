import { z } from 'zod';
import type { HermesMessage } from '../hermes';

/**
 * The consented continuation turn. Framed so every client (Cuate macOS,
 * Android, this web client) renders it as a marker, not as text the user
 * typed; the unframed English/Spanish/Russian prompts of older clients are
 * still recognized. Contract: Cuate shared/fixtures/service-notices.json.
 */
export const hermesContinuationPrompt =
  '<cuate-continuation>\nContinue the original task using the background results already received in this session and prepare the answer. Do not repeat completed work.\n</cuate-continuation>';
const legacyContinuationPrompts = new Set([
  'Continue the original task using the background results already received in this session and prepare the answer. Do not repeat completed work.',
  'Continúa la tarea original con los resultados en segundo plano ya recibidos en esta sesión y prepara la respuesta. No repitas el trabajo completado.',
  'Продолжи исходную задачу с учётом фоновых результатов, уже полученных в этой сессии, и подготовь ответ. Не повторяй завершённую работу.',
]);
export function hermesIsContinuation(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith('<cuate-continuation>') || legacyContinuationPrompts.has(trimmed);
}
export const hermesRunActive = (status?: string): boolean =>
  ['running', 'queued', 'waiting_for_approval', 'stopping'].includes(status ?? '');
export const hermesRunTerminal = (status?: string): boolean =>
  ['completed', 'failed', 'cancelled', 'canceled', 'gone'].includes(status ?? '');
export function hermesText(message: HermesMessage): string {
  if (typeof message.content === 'string') {
    return message.content;
  }
  return (
    message.content
      ?.map((part) => part.text ?? (part.type === 'image_url' ? '[image]' : ''))
      .join('\n') ?? ''
  );
}
/**
 * Gateway reports written as user rows: delegation results (including the
 * early TASK FAILED warning), process reports and, since Hermes 0.21.5, the
 * gateway's consolidated batches of either.
 */
export function hermesServiceNotice(text: string): boolean {
  return /^\s*\[(ASYNC DELEGATION |(?:IMPORTANT: )?Background process|IMPORTANT: \d+ background (?:subagent delegations|processes) completed)/.test(
    text,
  );
}
export function hermesContinuationRows(rows: HermesMessage[]): number[] {
  let index = rows.length;
  while (
    index > 0 &&
    rows[index - 1].role === 'user' &&
    hermesServiceNotice(hermesText(rows[index - 1]))
  ) {
    index--;
  }
  return rows.slice(index).map((row) => row.id);
}
export function hermesNeedsContinuation(rows: number[], handled: number[] = []): boolean {
  const seen = new Set(handled);
  return rows.some((id) => !seen.has(id));
}
export function hermesSameDelivery(expected: number[], actual: number[]): boolean {
  return (
    expected.length > 0 &&
    expected.length === actual.length &&
    expected.every((id, index) => id === actual[index])
  );
}
export function hermesLiveTail(rows: HermesMessage[], now: number, staleMs: number): boolean {
  if (!rows.length || hermesContinuationRows(rows).length) {
    return false;
  }
  const last = rows[rows.length - 1];
  const stamp = [...rows].reverse().find((row) => row.timestamp != null)?.timestamp;
  if (stamp != null && now - stamp * 1000 >= staleMs) {
    return false;
  }
  return !(last.role === 'assistant' && hermesText(last).trim());
}
const dispatchSchema = z.object({
  status: z.literal('dispatched'),
  mode: z.literal('background'),
  delegation_id: z.string().min(1),
  count: z.number().int().positive(),
  units: z
    .array(z.object({ delegation_id: z.string().min(1), task_indexes: z.array(z.number()).min(1) }))
    .optional(),
});
export function hermesBackgroundWork(
  rows: HermesMessage[],
): { id: string; count: number; timestamp?: number }[] {
  const pending = new Map<string, { id: string; count: number; timestamp?: number }>();
  const delivered = new Set<string>();
  for (const row of rows) {
    const text = hermesText(row);
    // A unit is delivered by its COMPLETE / BATCH COMPLETE report, which may
    // sit inside a consolidated row; TASK FAILED is an early warning only.
    if (row.role === 'user' && hermesServiceNotice(text)) {
      for (const line of text.split('\n')) {
        if (!/^\[ASYNC DELEGATION (?:BATCH )?COMPLETE/.test(line)) {
          continue;
        }
        const id = line.match(/deleg_[A-Za-z0-9_-]+/)?.[0];
        if (id) {
          delivered.add(id);
        }
      }
    }
    if (row.role !== 'tool' || row.tool_name !== 'delegate_task') {
      continue;
    }
    try {
      const parsed = dispatchSchema.safeParse(JSON.parse(text));
      if (!parsed.success) {
        continue;
      }
      const value = parsed.data;
      const units = value.units?.length
        ? value.units.map((unit) => ({ id: unit.delegation_id, count: unit.task_indexes.length }))
        : [{ id: value.delegation_id, count: value.count }];
      for (const unit of units) {
        pending.set(unit.id, { ...unit, timestamp: row.timestamp });
      }
    } catch {
      continue;
    }
  }
  return Array.from(pending.values())
    .filter((item) => !delivered.has(item.id))
    .sort((a, b) => a.id.localeCompare(b.id));
}
const attachHeaders = new Set([
  'Attached file (read it from your host):',
  'Attached files (read them from your host):',
  'Archivo adjunto (léelo desde tu host):',
  'Archivos adjuntos (léelos desde tu host):',
  'Приложен файл (прочитай его со своей машины):',
  'Приложены файлы (прочитай их со своей машины):',
  'The user attached a file, available at this path on your host:',
  'The user attached files, available at these paths on your host:',
]);
export function hermesSplitAttachments(text: string): { text: string; paths: string[] } {
  const raw = text.replace(/\r\n?/g, '\n').split('\n');
  const lines = raw.map((line) => line.trim());
  let index = lines.length - 1;
  while (index >= 0 && (!lines[index] || /^\[[^\]\n[]{1,40}\]$/.test(lines[index]))) {
    index--;
  }
  const paths: string[] = [];
  while (index >= 0 && lines[index].startsWith('- ')) {
    paths.unshift(lines[index--].slice(2));
  }
  if (!paths.length || !attachHeaders.has(lines[index])) {
    return { text, paths: [] };
  }
  return { text: raw.slice(0, index).join('\n').trim(), paths };
}

/** Arguments are external JSON. Treat document bodies as content, not filenames. */
export function hermesToolPaths(value: unknown): string[] {
  const found = new Set<string>();
  function visit(item: unknown, key: string, depth: number) {
    if (depth > 3 || found.size >= 8) {
      return;
    }
    if (typeof item === 'string') {
      const path = item.trim();
      if (
        !path ||
        path.length > 1024 ||
        /[\r\n\0]|:\/\//.test(path) ||
        ['.', '/', '~', './'].includes(path)
      ) {
        return;
      }
      if (
        /^(\/|~\/)/.test(path) ||
        (/path|file|dir|dest|target|output|source/i.test(key) && /[/.]/.test(path))
      ) {
        found.add(path);
      }
      return;
    }
    if (Array.isArray(item)) {
      for (const child of item) {
        visit(child, key, depth + 1);
      }
      return;
    }
    if (item && typeof item === 'object') {
      for (const [name, child] of Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) {
        visit(child, name, depth + 1);
      }
    }
  }
  visit(value, '', 0);
  return Array.from(found);
}
export function hermesMessagePaths(message: HermesMessage): string[] {
  const text = hermesText(message);
  const found = new Set(hermesSplitAttachments(text).paths);
  for (const call of message.tool_calls ?? []) {
    try {
      for (const path of hermesToolPaths(JSON.parse(call.function?.arguments ?? '{}'))) {
        found.add(path);
      }
    } catch {
      continue;
    }
  }
  for (const match of Array.from(
    text.matchAll(/\]\((?:sandbox:|file:\/\/)?((?:\/|~\/)[^\n)]+)\)|`((?:\/|~\/)[^`\n]+)`/g),
  )) {
    const path = match[1] ?? match[2];
    try {
      found.add(decodeURIComponent(path));
    } catch {
      found.add(path);
    }
  }
  for (const match of Array.from(
    text.matchAll(/(?:^|\s)((?:\/|~\/)[^\s<>"`]+\.[a-zA-Z0-9]{1,10})\b/g),
  )) {
    found.add(match[1]);
  }
  return Array.from(found);
}
