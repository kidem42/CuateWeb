import { z } from 'zod';
import { Router } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import {
  hermesChatSchema,
  hermesConfigSchema,
  hermesRequestSchema,
  hermesPendingApprovals,
} from 'librechat-data-provider';
import type { HermesConfig, HermesConnection, HermesRun } from 'librechat-data-provider';
import type { Request, RequestHandler, Response } from 'express';
import type multer from 'multer';
import { previewHermesFile } from './preview';

type Principal = { id: string; tenantId?: string };
export type HermesDependencies = {
  fetch: (
    input: string | URL | globalThis.Request,
    init?: RequestInit,
  ) => Promise<globalThis.Response>;
  multer: typeof multer;
  environment: Readonly<Record<string, string | undefined>>;
  context: (request: Request) => { principal?: Principal; config?: object };
};
class GatewayError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
const pageSchema = z.object({
  data: z.array(z.object({ id: z.number(), role: z.string() }).passthrough()),
  pagination: z.object({}).passthrough().nullish(),
});
const connectionScope = (item: HermesConnection) =>
  createHash('sha256').update(item.apiURL.replace(/\/$/, '')).digest('hex');
const frame =
  '<cuate-addendum>\nThe user is adding to the request you are working on right now: take the addition below into account in the current cycle.\n</cuate-addendum>';

export function createHermesRouter(deps: HermesDependencies): Router {
  const router = Router();
  function settings(req: Request) {
    const { principal, config } = deps.context(req);
    if (!principal) {
      throw new GatewayError(401, 'authentication_required');
    }
    const parsed = hermesConfigSchema.parse(config ?? {});
    const connections = parsed.connections.filter(
      (item) => item.userIds.includes(principal.id) && item.tenantId === principal.tenantId,
    );
    return { ...parsed, connections };
  }
  function connection(req: Request) {
    const config = settings(req);
    const item = config.connections.find((entry) => entry.id === req.params.connection);
    if (!item) {
      throw new GatewayError(404, 'connection_not_found');
    }
    return { config, item };
  }
  async function upstream(
    item: HermesConnection,
    config: HermesConfig,
    path: string,
    init: RequestInit = {},
    dashboard = false,
    stream = false,
  ) {
    const base = dashboard ? item.dashboardURL : item.apiURL;
    const keyName = dashboard ? item.dashboardKeyEnv : item.apiKeyEnv;
    const key = keyName ? deps.environment[keyName] : undefined;
    if (!base || !key) {
      throw new GatewayError(503, 'connection_not_configured');
    }
    const response = await deps.fetch(`${base.replace(/\/$/, '')}/${path}`, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${key}`, 'User-Agent': 'CuateWeb/0.1' },
      redirect: 'error',
      signal: AbortSignal.timeout(stream ? config.streamTimeoutMs : config.requestTimeoutMs),
    });
    if (!response.ok) {
      if (response.status === 404) {
        try {
          const body = await response.json();
          if (body?.error?.code === 'run_not_found') {
            throw new GatewayError(404, 'run_not_found');
          }
        } catch (error) {
          if (error instanceof GatewayError) {
            throw error;
          }
        }
      } else {
        await response.body?.cancel();
      }
      throw new GatewayError(
        response.status >= 500 ? 502 : response.status,
        'hermes_request_failed',
      );
    }
    return response;
  }
  const handle =
    (callback: (req: Request, res: Response) => Promise<void>): RequestHandler =>
    async (req, res) => {
      try {
        await callback(req, res);
      } catch (error) {
        if (res.headersSent) {
          res.end();
          return;
        }
        if (error instanceof GatewayError) {
          res.status(error.status).json({ error: error.message });
          return;
        }
        if (error instanceof z.ZodError) {
          res.status(400).json({ error: 'invalid_request' });
          return;
        }
        res.status(502).json({ error: 'hermes_unavailable' });
      }
    };
  router.get(
    '/',
    handle(async (req, res) => {
      const config = settings(req);
      res.json(
        config.connections.map((item) => ({
          id: item.id,
          label: item.label,
          scope: connectionScope(item),
          sessionPageSize: config.sessionPageSize,
          previewMaxBytes: config.previewMaxBytes,
          liveStaleMs: config.liveStaleMs,
          growthHoldMs: config.growthHoldMs,
          stopConfirmMs: config.stopConfirmMs,
          files: Boolean(
            item.dashboardURL && item.dashboardKeyEnv && deps.environment[item.dashboardKeyEnv],
          ),
          pollIntervalMs: config.pollIntervalMs,
          requestTimeoutMs: config.requestTimeoutMs,
          maxUploadBytes: config.maxUploadBytes,
          maxChatBytes: config.maxChatBytes,
          formattingInstructions: config.formattingInstructions,
          maxInlineImageBytes: config.maxInlineImageBytes,
          imageMaxDimension: config.imageMaxDimension,
        })),
      );
    }),
  );
  router.post(
    '/:connection/request',
    handle(async (req, res) => {
      const { config, item } = connection(req);
      const input = hermesRequestSchema.parse(req.body);
      if ('scope' in input && input.scope && input.scope !== connectionScope(item)) {
        throw new GatewayError(409, 'connection_changed');
      }
      const json = async (path: string, method = 'GET', body?: object) => {
        const response = await upstream(item, config, path, {
          method,
          ...(body
            ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }
            : {}),
        });
        return response.status === 204 ? {} : response.json();
      };
      const sessionPath =
        'sessionId' in input ? `api/sessions/${encodeURIComponent(input.sessionId)}` : '';
      const runPath = 'runId' in input ? `v1/runs/${encodeURIComponent(input.runId)}` : '';
      switch (input.operation) {
        case 'capabilities':
          res.json(await json('v1/capabilities'));
          return;
        case 'models':
          res.json(await json('api/model/options'));
          return;
        case 'modelInfo':
          res.json(await (await upstream(item, config, 'api/model/info', {}, true)).json());
          return;
        case 'skills':
          if (input.name) {
            const response = await upstream(
              item,
              config,
              `api/skills/content?name=${encodeURIComponent(input.name)}`,
              {},
              true,
            );
            res.setHeader('Cache-Control', 'no-store');
            res.json(await response.json());
            return;
          }
          res.json(await json('v1/skills'));
          return;
        case 'toolsets':
          res.json(await json('v1/toolsets'));
          return;
        case 'sessions':
          res.json(
            await json(`api/sessions?limit=${config.sessionPageSize}&offset=${input.offset}`),
          );
          return;
        case 'create':
          res.json(
            await json('api/sessions', 'POST', {
              title: input.title,
              ...(input.provider ? { provider: input.provider } : {}),
              ...(input.model ? { model: input.model } : {}),
              ...(input.provider || input.model ? { require_model_lock: true } : {}),
            }),
          );
          return;
        case 'session':
          res.json(await json(sessionPath));
          return;
        case 'rename':
          res.json(await json(sessionPath, 'PATCH', { title: input.title }));
          return;
        case 'pin':
          res.json(await json(sessionPath, 'PATCH', { pinned: input.pinned }));
          return;
        case 'delete':
          res.json(await json(sessionPath, 'DELETE'));
          return;
        case 'model':
          res.json(
            await json(`${sessionPath}/model`, 'POST', {
              provider: input.provider,
              model: input.model,
            }),
          );
          return;
        case 'run':
          res.json(await json(runPath));
          return;
        case 'approval': {
          const run = (await json(runPath)) as HermesRun;
          if (
            run.session_id !== input.sessionId ||
            !hermesPendingApprovals(run, input.runId)[input.requestId]
          ) {
            throw new GatewayError(409, 'approval_expired');
          }
          const reply = await json(`${runPath}/approval`, 'POST', {
            request_id: input.requestId,
            choice: input.choice,
          });
          if (
            reply.run_id !== input.runId ||
            reply.request_id !== input.requestId ||
            reply.choice !== input.choice ||
            reply.resolved !== 1
          ) {
            throw new GatewayError(502, 'approval_response_unconfirmed');
          }
          res.json(reply);
          return;
        }
        case 'files':
          res.json(
            await (
              await upstream(
                item,
                config,
                `api/files?path=${encodeURIComponent(input.path)}`,
                {},
                true,
              )
            ).json(),
          );
          return;
        case 'preview': {
          const response = await upstream(
            item,
            config,
            `api/files/download?path=${encodeURIComponent(input.path)}`,
            {},
            true,
          );
          res.setHeader('Cache-Control', 'no-store');
          res.json(await previewHermesFile(response, input.path, config.previewMaxBytes));
          return;
        }
        case 'stop':
          res.json(await json(`${runPath}/stop`, 'POST'));
          return;
        case 'steer':
          res.json(await json(`${runPath}/steer`, 'POST', { text: `${frame}\n\n${input.text}` }));
          return;
        case 'sessionSteer':
          res.json(
            await json(`${sessionPath}/steer`, 'POST', { text: `${frame}\n\n${input.text}` }),
          );
          return;
        case 'messages': {
          const data: z.infer<typeof pageSchema>['data'] = [];
          for (let page = 0; page < config.maxHistoryPages; page++) {
            const result = pageSchema.parse(
              await json(
                `${sessionPath}/messages?order=oldest&limit=${config.historyPageSize}&offset=${data.length}`,
              ),
            );
            data.push(...result.data);
            if (result.data.length < config.historyPageSize || !result.pagination) {
              res.json({ data, truncated: false });
              return;
            }
          }
          res.json({ data, truncated: true });
          return;
        }
        case 'download': {
          const response = await upstream(
            item,
            config,
            `api/files/download?path=${encodeURIComponent(input.path)}`,
            {},
            true,
          );
          res.setHeader('Content-Type', 'application/octet-stream');
          res.setHeader('Content-Disposition', 'attachment');
          res.setHeader('X-Content-Type-Options', 'nosniff');
          res.setHeader('Cache-Control', 'no-store');
          await forward(response, res);
          return;
        }
      }
    }),
  );
  router.post(
    '/:connection/upload',
    handle(async (req, res) => {
      const { config, item } = connection(req);
      const upload = deps
        .multer({
          storage: deps.multer.memoryStorage(),
          limits: { fileSize: config.maxUploadBytes, files: 1 },
        })
        .single('file');
      await new Promise<void>((resolve, reject) =>
        upload(req, res, (error?: unknown) =>
          error ? reject(new GatewayError(413, 'upload_rejected')) : resolve(),
        ),
      );
      if (req.body?.scope && req.body.scope !== connectionScope(item))
        throw new GatewayError(409, 'connection_changed');
      if (!req.file) {
        throw new GatewayError(400, 'file_required');
      }
      const name = `${randomUUID()}-${req.file.originalname.replace(/[^\p{L}\p{N}._-]/gu, '_')}`;
      const path = `~/cuate-uploads/${name}`;
      const form = new FormData();
      form.set('path', path);
      form.set('overwrite', 'true');
      form.set(
        'file',
        new Blob([new Uint8Array(req.file.buffer)], { type: req.file.mimetype }),
        name,
      );
      const response = await upstream(
        item,
        config,
        'api/files/upload-stream',
        { method: 'POST', body: form },
        true,
      );
      const result = z.object({ path: z.string().optional() }).parse(await response.json());
      res.json({ path: result.path ?? path });
    }),
  );
  router.post(
    '/:connection/stream',
    handle(async (req, res) => {
      const { config, item } = connection(req);
      const { sessionId, scope, ...body } = hermesChatSchema.parse(req.body);
      if (scope && scope !== connectionScope(item))
        throw new GatewayError(409, 'connection_changed');
      if (Buffer.byteLength(JSON.stringify(body)) > config.maxChatBytes) {
        throw new GatewayError(413, 'message_too_large');
      }
      const response = await upstream(
        item,
        config,
        `api/sessions/${encodeURIComponent(sessionId)}/chat/stream`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          body: JSON.stringify(body),
        },
        false,
        true,
      );
      if (!response.headers.get('content-type')?.includes('text/event-stream')) {
        await response.body?.cancel();
        throw new GatewayError(502, 'invalid_stream');
      }
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();
      await forward(response, res);
    }),
  );
  return router;
}

/** Drain upstream after a browser disconnect; only an explicit stop cancels a Hermes run. */
async function forward(response: globalThis.Response, res: Response) {
  const reader = response.body?.getReader();
  if (!reader) {
    res.end();
    return;
  }
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      if (res.destroyed || res.writableEnded) {
        continue;
      }
      if (!res.write(value)) {
        await new Promise<void>((resolve) => {
          const finish = () => {
            res.off('drain', finish);
            res.off('close', finish);
            resolve();
          };
          res.once('drain', finish);
          res.once('close', finish);
        });
      }
    }
  } finally {
    reader.releaseLock();
    if (!res.destroyed) {
      res.end();
    }
  }
}
