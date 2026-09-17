import { z } from 'zod';

export const hermesIdentifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/);
const sessionTitle = z
  .string()
  .trim()
  .min(1)
  .refine((value) => Array.from(value).length <= 100);
const serverURL = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  });
export const hermesConfigSchema = z.object({
  connections: z
    .array(
      z.object({
        id: hermesIdentifier,
        label: z.string().min(1),
        apiURL: serverURL,
        apiKeyEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
        dashboardURL: serverURL.optional(),
        dashboardKeyEnv: z
          .string()
          .regex(/^[A-Z_][A-Z0-9_]*$/)
          .optional(),
        userIds: z.array(z.string().min(1)).min(1),
        tenantId: z.string().optional(),
      }),
    )
    .default([])
    .refine((items) => new Set(items.map((item) => item.id)).size === items.length),
  formattingInstructions: z.boolean().default(false),
  previewMaxBytes: z.number().int().positive().default(32_000_000),
  liveStaleMs: z.number().int().positive().default(1_200_000),
  growthHoldMs: z.number().int().positive().default(300_000),
  stopConfirmMs: z.number().int().positive().default(20_000),
  requestTimeoutMs: z.number().int().positive().default(30_000),
  streamTimeoutMs: z.number().int().positive().default(600_000),
  pollIntervalMs: z.number().int().min(1000).default(3000),
  sessionPageSize: z.number().int().min(1).max(500).default(50),
  historyPageSize: z.number().int().min(1).max(500).default(500),
  maxHistoryPages: z.number().int().positive().default(40),
  maxChatBytes: z.number().int().positive().max(2_500_000).default(2_500_000),
  maxInlineImageBytes: z.number().int().positive().default(384_000),
  imageMaxDimension: z.number().int().positive().default(1280),
  maxUploadBytes: z.number().int().positive().max(20_000_000).default(10_000_000),
});
export type HermesConfig = z.infer<typeof hermesConfigSchema>;
export type HermesConnection = HermesConfig['connections'][number];
export type HermesAccess = Pick<HermesConnection, 'id' | 'label'> & {
  files: boolean;
  formattingInstructions?: boolean;
  scope: string;
  sessionPageSize: number;
  previewMaxBytes: number;
  liveStaleMs: number;
  growthHoldMs: number;
  stopConfirmMs: number;
  pollIntervalMs: number;
  requestTimeoutMs: number;
  maxUploadBytes: number;
  maxChatBytes: number;
  maxInlineImageBytes: number;
  imageMaxDimension: number;
};

export const hermesPartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('image_url'),
    image_url: z.object({
      url: z.string().regex(/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/),
    }),
  }),
]);
export const hermesChatSchema = z
  .object({
    sessionId: hermesIdentifier,
    scope: z.string().optional(),
    input: z.union([z.string().min(1), z.array(hermesPartSchema).min(1)]),
    model_options: z.object({ reasoning_effort: z.string() }).optional(),
  })
  .strict();
export type HermesChat = z.infer<typeof hermesChatSchema>;
export const hermesRequestSchema = z
  .discriminatedUnion('operation', [
    z.object({ operation: z.literal('capabilities') }),
    z.object({ operation: z.literal('models') }),
    z.object({ operation: z.literal('modelInfo') }),
    z.object({ operation: z.literal('skills'), name: z.string().min(1).max(512).optional() }),
    z.object({ operation: z.literal('toolsets') }),
    z.object({
      operation: z.literal('sessions'),
      offset: z.number().int().nonnegative().default(0),
    }),
    z.object({
      operation: z.literal('create'),
      title: sessionTitle,
      provider: z.string().min(1).optional(),
      model: z.string().min(1).optional(),
    }),
    z.object({ operation: z.literal('messages'), sessionId: hermesIdentifier }),
    z.object({ operation: z.literal('session'), sessionId: hermesIdentifier }),
    z.object({
      operation: z.literal('rename'),
      sessionId: hermesIdentifier,
      title: sessionTitle,
    }),
    z.object({ operation: z.literal('pin'), sessionId: hermesIdentifier, pinned: z.boolean() }),
    z.object({ operation: z.literal('delete'), sessionId: hermesIdentifier }),
    z.object({
      operation: z.literal('model'),
      sessionId: hermesIdentifier,
      provider: z.string().min(1),
      model: z.string().min(1),
    }),
    z.object({
      operation: z.literal('run'),
      runId: hermesIdentifier,
      scope: z.string().optional(),
    }),
    z.object({
      operation: z.literal('stop'),
      runId: hermesIdentifier,
      scope: z.string().optional(),
    }),
    z.object({
      operation: z.literal('steer'),
      runId: hermesIdentifier,
      text: z.string().trim().min(1),
    }),
    z.object({
      operation: z.literal('sessionSteer'),
      sessionId: hermesIdentifier,
      text: z.string().trim().min(1),
    }),
    z.object({
      operation: z.literal('approval'),
      scope: z.string().min(1),
      sessionId: hermesIdentifier,
      runId: hermesIdentifier,
      requestId: z.string().trim().min(1).max(256),
      choice: z.enum(['once', 'deny']),
    }),
    z.object({ operation: z.literal('files'), path: z.string().min(1) }),
    z.object({ operation: z.literal('preview'), path: z.string().min(1) }),
    z.object({ operation: z.literal('download'), path: z.string().min(1) }),
  ])
  .and(z.object({ scope: z.string().optional() }));
export type HermesRequest = z.input<typeof hermesRequestSchema>;
export type HermesSession = {
  id: string;
  title?: string;
  model?: string;
  pinned?: boolean;
  last_active?: number;
};
export type HermesMessage = {
  id: number;
  role: string;
  content: string | { type: string; text?: string; image_url?: { url: string } }[] | null;
  timestamp?: number;
  tool_call_id?: string;
  tool_name?: string;
  tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
};
export type HermesHistory = { data: HermesMessage[]; truncated: boolean };
export type HermesModels = {
  provider?: string;
  model?: string;
  providers: { slug: string; name?: string; models: string[] }[];
};
export type HermesRun = {
  run_id?: string;
  session_id?: string;
  cuate_approval_version?: number;
  approvals?: HermesApproval[];
  status: string;
  pending_steer?: string;
  usage?: HermesUsage;
  approval?: HermesApproval;
};
export type HermesApproval = {
  run_id?: string;
  request_id: string;
  command?: string;
  description?: string;
  choices?: string[];
  tool_name?: string;
};
export type HermesPreview = {
  kind: 'image' | 'pdf' | 'audio' | 'video' | 'html' | 'text' | 'unsupported';
  mime: string;
  text?: string;
  data?: string;
};
export type HermesFiles = {
  path?: string;
  entries: { name: string; is_directory?: boolean }[];
};
export type HermesCapabilities = {
  features?: {
    run_steer?: boolean;
    session_steer?: boolean;
    approval_events?: boolean;
    run_approval_response?: boolean;
  };
};
export type HermesUsage = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  context_used?: number;
  context_max?: number;
  context_source?: string;
  context_estimated?: boolean;
  context_tokens?: number;
  context_window?: number;
};
export const hermesFrameSchema = z
  .object({
    run_id: z
      .string()
      .nullish()
      .transform((value) => value ?? undefined),
    request_id: z
      .string()
      .nullish()
      .transform((value) => value ?? undefined),
    command: z
      .string()
      .nullish()
      .transform((value) => value ?? undefined),
    description: z
      .string()
      .nullish()
      .transform((value) => value ?? undefined),
    choices: z
      .array(z.string())
      .nullish()
      .transform((value) => value ?? undefined),
    args: z
      .record(z.unknown())
      .nullish()
      .transform((value) => value ?? undefined),
    delta: z
      .string()
      .nullish()
      .transform((value) => value ?? undefined),
    content: z
      .string()
      .nullish()
      .transform((value) => value ?? undefined),
    tool_name: z
      .string()
      .nullish()
      .transform((value) => value ?? undefined),
    preview: z
      .string()
      .nullish()
      .transform((value) => value ?? undefined),
    status: z
      .string()
      .nullish()
      .transform((value) => value ?? undefined),
    pending_steer: z
      .string()
      .nullish()
      .transform((value) => value ?? undefined),
    runtime: z
      .object({
        provider: z
          .string()
          .nullish()
          .transform((value) => value ?? undefined),
        model: z
          .string()
          .nullish()
          .transform((value) => value ?? undefined),
      })
      .nullish()
      .transform((value) => value ?? undefined),
    usage: z
      .object({
        input_tokens: z
          .number()
          .nullish()
          .transform((value) => value ?? undefined),
        output_tokens: z
          .number()
          .nullish()
          .transform((value) => value ?? undefined),
        total_tokens: z
          .number()
          .nullish()
          .transform((value) => value ?? undefined),
        context_used: z
          .number()
          .nullish()
          .transform((value) => value ?? undefined),
        context_max: z
          .number()
          .nullish()
          .transform((value) => value ?? undefined),
        context_source: z
          .string()
          .nullish()
          .transform((value) => value ?? undefined),
        context_estimated: z
          .boolean()
          .nullish()
          .transform((value) => value ?? undefined),
        context_tokens: z
          .number()
          .nullish()
          .transform((value) => value ?? undefined),
        context_window: z
          .number()
          .nullish()
          .transform((value) => value ?? undefined),
      })
      .nullish()
      .transform((value) => value ?? undefined),
  })
  .passthrough();
export type HermesFrame = { event: string; data: z.infer<typeof hermesFrameSchema> };

/** Throughput is deliberately excluded: a tool loop can spend several context windows. */
export function hermesOccupancy(usage?: HermesUsage) {
  const native = usage?.context_used != null && usage?.context_max != null;
  const used = native ? usage.context_used : usage?.context_tokens;
  const max = native ? usage.context_max : usage?.context_window;
  if (
    used == null ||
    max == null ||
    !Number.isFinite(used) ||
    !Number.isFinite(max) ||
    used < 0 ||
    max <= 0
  ) {
    return undefined;
  }
  return {
    used,
    max,
    percent: Math.min(100, Math.max(0, (used / max) * 100)),
    estimated: native ? usage?.context_estimated === true : false,
    source: native ? usage?.context_source : 'cuate_patch',
  };
}

export function hermesAttachmentNote(paths: string[]) {
  if (!paths.length) {
    return '';
  }
  return `${paths.length === 1 ? 'Attached file (read it from your host):' : 'Attached files (read them from your host):'}\n${paths.map((path) => `- ${path}`).join('\n')}`;
}

export function hermesUnframe(text: string) {
  return text.replace(/<cuate-addendum>[\s\S]*?<\/cuate-addendum>/g, '').trim();
}

/** Incremental SSE parser: UTF-8 decoding belongs to the caller, framing survives chunk boundaries. */
export function createHermesDecoder(onFrame: (frame: HermesFrame) => void) {
  let buffer = '';
  let event = '';
  let data: string[] = [];
  const dispatch = () => {
    if (event && data.length && data.join('\n') !== '[DONE]') {
      onFrame({ event, data: hermesFrameSchema.parse(JSON.parse(data.join('\n'))) });
    }
    event = '';
    data = [];
  };
  return (chunk: string, final = false) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (!line) {
        dispatch();
      } else if (line.startsWith('event:')) {
        event = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        data.push(line.slice(5).replace(/^ /, ''));
      }
      newline = buffer.indexOf('\n');
    }
    if (final) {
      dispatch();
    }
  };
}

export * from './hermes/protocol';

/** A queue snapshot replaces previous cards; the singular legacy field is only a fallback. */
export function hermesPendingApprovals(
  run: HermesRun,
  runId: string,
): Record<string, HermesApproval> {
  if (run.run_id && run.run_id !== runId) {
    throw new Error('run_identity_changed');
  }
  if (!['running', 'queued', 'waiting_for_approval'].includes(run.status)) {
    return {};
  }
  if (run.cuate_approval_version && !Array.isArray(run.approvals)) {
    throw new Error('invalid_approval_snapshot');
  }
  const rows = run.approvals ?? (run.approval ? [run.approval] : []);
  if (!Array.isArray(rows)) {
    throw new Error('invalid_approval_snapshot');
  }
  const result: Record<string, HermesApproval> = Object.create(null);
  for (const row of rows) {
    if (
      !row ||
      typeof row.request_id !== 'string' ||
      !row.request_id.trim() ||
      row.request_id !== row.request_id.trim() ||
      row.request_id.length > 256 ||
      typeof row.command !== 'string' ||
      !row.command ||
      (row.run_id && row.run_id !== runId)
    ) {
      continue;
    }
    Object.defineProperty(result, row.request_id, {
      value: { ...row, run_id: runId },
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

export * from './hermes/sessionView';
export * from './hermes/briefing';

export * from './hermes/presentation';
