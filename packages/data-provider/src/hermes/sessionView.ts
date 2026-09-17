import { hermesDisplayRows } from './presentation';
import { hermesServiceNotice, hermesText } from './protocol';
import { hermesStripBriefing } from './briefing';
import { EModelEndpoint } from '../schemas';
import { ContentTypes, ToolCallTypes } from '../types/runs';
import type { TConversation, TMessage } from '../schemas';
import type { HermesAccess, HermesHistory, HermesSession } from '../hermes';

/** A UI identity, never an upstream session ID or a Mongo conversation ID. */
export type HermesChatIdentity = { connectionId: string; scope: string; sessionId: string };
const dateFromSeconds = (value?: number) => {
  if (value == null || !Number.isFinite(value) || value < 0 || value > 8.64e12) return undefined;
  return new Date(value * 1000).toISOString();
};
const segment = /^[a-zA-Z0-9_-]+$/;
export function hermesConversationId(identity: HermesChatIdentity): string {
  const parts = [identity.connectionId, identity.scope, identity.sessionId];
  if (parts.some((part) => !part || !segment.test(part))) {
    throw new Error('invalid_hermes_identity');
  }
  return ['hermes', ...parts].join('.');
}
export function parseHermesConversationId(value?: string | null): HermesChatIdentity | undefined {
  const parts = value?.split('.');
  if (
    !parts ||
    parts.length !== 4 ||
    parts[0] !== 'hermes' ||
    parts.slice(1).some((part) => !part || !segment.test(part))
  )
    return undefined;
  return { connectionId: parts[1], scope: parts[2], sessionId: parts[3] };
}
export function hermesSessionView(
  connection: Pick<HermesAccess, 'id' | 'scope'>,
  session: HermesSession,
): TConversation {
  const conversationId = hermesConversationId({
    connectionId: connection.id,
    scope: connection.scope,
    sessionId: session.id,
  });
  const date = dateFromSeconds(session.last_active) ?? new Date(0).toISOString();
  return {
    conversationId,
    title: session.title || session.id,
    endpoint: EModelEndpoint.hermes,
    model: session.model,
    pinned: session.pinned,
    createdAt: date,
    updatedAt: date,
  };
}

/** Render the server's ordered transcript without rewriting or persisting its history. */
export function hermesMessageViews(conversationId: string, history: HermesHistory): TMessage[] {
  if (!parseHermesConversationId(conversationId)) throw new Error('invalid_hermes_identity');
  const seen = new Set<string>();
  let parentMessageId: string | null = null;
  const messages: TMessage[] = [];
  type ToolPart = Extract<
    NonNullable<TMessage['content']>[number],
    { type: ContentTypes.TOOL_CALL }
  >;
  const pending = new Map<string, ToolPart>();
  for (const row of hermesDisplayRows(history.data)) {
    const identity = `${row.id}${row.displaySuffix ?? ''}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const notice = row.role === 'user' && hermesServiceNotice(hermesText(row));
    if (row.role === 'user') pending.clear();
    const messageId = `${conversationId}.message.${identity}${notice ? '.notice' : ''}`;
    const display = (value: string) => (row.role === 'user' ? hermesStripBriefing(value) : value);
    const text = display(
      typeof row.content === 'string'
        ? row.content
        : (row.content ?? [])
            .filter((part) => part.type === 'text')
            .map((part) => part.text ?? '')
            .join('\n'),
    );
    const firstTextIndex = Array.isArray(row.content)
      ? row.content.findIndex((part) => part.type === 'text')
      : -1;
    const content: NonNullable<TMessage['content']> = [];
    if (typeof row.content === 'string')
      content.push({ type: ContentTypes.TEXT, text: display(row.content) });
    else
      (row.content ?? []).forEach((part, index) => {
        if (part.type === 'text')
          content.push({
            type: ContentTypes.TEXT,
            text: index === firstTextIndex ? display(part.text ?? '') : (part.text ?? ''),
          });
        if (part.type === 'image_url' && part.image_url?.url)
          content.push({
            type: ContentTypes.IMAGE_FILE,
            image_file: {
              file_id: `${messageId}.image.${index}`,
              filepath: part.image_url.url,
              filename: 'image',
              user: '',
              bytes: 0,
              embedded: false,
              object: 'file',
              type: 'image/*',
              usage: 0,
              height: 0,
              width: 0,
            },
          });
      });
    if (row.role === 'tool') {
      const call = row.tool_call_id ? pending.get(row.tool_call_id) : undefined;
      if (call && 'args' in call.tool_call) {
        call.tool_call.output = text;
        call.tool_call.progress = 1;
        if (row.tool_call_id) pending.delete(row.tool_call_id);
        continue;
      }
      // Truncated history can start with a result whose original call is absent.
      content.splice(0, content.length, {
        type: ContentTypes.TOOL_CALL,
        tool_call: {
          id: row.tool_call_id ?? `${messageId}.result`,
          type: ToolCallTypes.TOOL_CALL,
          name: row.tool_name ?? 'tool',
          args: '',
          output: text,
          progress: 1,
        },
      });
    } else {
      row.tool_calls?.forEach((call, index) => {
        if (call.function?.name === '_thinking') return;
        const part: ToolPart = {
          type: ContentTypes.TOOL_CALL,
          tool_call: {
            id: call.id ?? `${messageId}.tool.${index}`,
            type: ToolCallTypes.TOOL_CALL,
            name: call.function?.name ?? 'tool',
            args: call.function?.arguments ?? '',
          },
        };
        content.push(part);
        if (call.id) pending.set(call.id, part);
      });
    }
    if (
      row.role === 'assistant' &&
      !text.trim() &&
      content.every((part) => part.type === ContentTypes.TEXT)
    )
      continue;
    const message: TMessage = {
      conversationId,
      messageId,
      parentMessageId,
      text: row.role === 'tool' ? '' : text,
      content,
      endpoint: EModelEndpoint.hermes,
      sender: row.role === 'user' && !notice ? 'User' : 'Hermes',
      isCreatedByUser: row.role === 'user' && !notice,
      createdAt: dateFromSeconds(row.timestamp),
    };
    parentMessageId = messageId;
    messages.push(message);
  }
  return hermesGroupToolMessages(messages);
}

/** One reply shell per native assistant stretch; one accumulated stock tool group. */
export function hermesGroupToolMessages(messages: TMessage[]): TMessage[] {
  const grouped: TMessage[] = [];
  let active: TMessage | undefined;
  let tools: NonNullable<TMessage['content']> = [];
  const flush = () => {
    if (active) active.content?.push(...tools);
    tools = [];
    active = undefined;
  };
  for (const message of messages) {
    const boundary = message.isCreatedByUser || hermesServiceNotice(message.text);
    if (boundary) {
      flush();
      grouped.push({ ...message, parentMessageId: grouped[grouped.length - 1]?.messageId ?? null });
      continue;
    }
    if (!active) {
      active = {
        ...message,
        text: '',
        content: [],
        parentMessageId: grouped[grouped.length - 1]?.messageId ?? null,
      };
      grouped.push(active);
    }
    if (message.text.trim()) active.text = [active.text, message.text].filter(Boolean).join('\n\n');
    for (const part of message.content ?? [{ type: ContentTypes.TEXT, text: message.text }]) {
      if (part.type === ContentTypes.TOOL_CALL) tools.push(part);
      else if (
        part.type !== ContentTypes.TEXT ||
        (typeof part.text === 'string' && part.text.trim())
      )
        active.content?.push(part);
    }
  }
  flush();
  return grouped;
}

export type HermesSessionPage = {
  data: HermesSession[];
  offset: number;
  limit: number;
  has_more: boolean;
};
/** Pins are backfilled beyond the recency window and must not advance its offset. */
export function hermesNextSessionOffset(page: HermesSessionPage): number | undefined {
  if (page.has_more !== true) return undefined;
  if (
    !Number.isSafeInteger(page.offset) ||
    page.offset < 0 ||
    !Number.isSafeInteger(page.limit) ||
    page.limit <= 0
  ) {
    throw new Error('invalid_hermes_pagination');
  }
  return page.offset + page.limit;
}
