// Exercise the current source contract without requiring a distribution build.
jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  hermesRequestSchema: jest.requireActual('../../../data-provider/src/hermes').hermesRequestSchema,
}));
import multer from 'multer';
import { createHash } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { createHermesRouter } from './router';

const scope = createHash('sha256').update('http://127.0.0.1:8642').digest('hex');
const connection = {
  id: 'main',
  label: 'Local Hermes',
  apiURL: 'http://127.0.0.1:8642',
  apiKeyEnv: 'HERMES_KEY',
  dashboardURL: 'http://127.0.0.1:9119',
  dashboardKeyEnv: 'DASH_KEY',
  userIds: ['owner'],
};
function setup(user = 'owner', tenantId?: string, extra = {}) {
  const fetcher = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
  const app = express();
  app.use(express.json());
  app.use(
    createHermesRouter({
      fetch: fetcher,
      multer,
      environment: { HERMES_KEY: 'api-secret', DASH_KEY: 'dashboard-secret' },
      context: () => ({
        principal: user ? { id: user, tenantId } : undefined,
        config: { connections: [connection], ...extra },
      }),
    }),
  );
  return { app, fetcher };
}
const json = (value: object, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

describe('Hermes authenticated adapter', () => {
  it.each([
    ['other', undefined, 404],
    ['owner', 'other-tenant', 404],
    ['', undefined, 401],
  ])('denies principal %s / tenant %s before upstream access', async (user, tenant, status) => {
    const { app, fetcher } = setup(user, tenant);
    await request(app).post('/main/request').send({ operation: 'sessions' }).expect(status);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('returns only public connection metadata', async () => {
    const { app } = setup();
    const response = await request(app).get('/').expect(200);
    expect(response.body[0]).toMatchObject({ id: 'main', files: true });
    expect(JSON.stringify(response.body)).not.toMatch(/secret|127\.0\.0\.1|userIds|KeyEnv/);
  });
  it('reads all oldest-first history pages without confusing SSE seq with row IDs', async () => {
    const { app, fetcher } = setup('owner', undefined, { historyPageSize: 2 });
    fetcher.mockResolvedValueOnce(
      json({
        data: [
          { id: 7, role: 'user' },
          { id: 9, role: 'assistant' },
        ],
        pagination: {},
      }),
    );
    fetcher.mockResolvedValueOnce(json({ data: [{ id: 12, role: 'tool' }], pagination: {} }));
    const response = await request(app)
      .post('/main/request')
      .send({ operation: 'messages', sessionId: 'session-1' })
      .expect(200);
    expect(response.body.data.map((row: { id: number }) => row.id)).toEqual([7, 9, 12]);
    expect(fetcher.mock.calls[1][0]).toBe(
      'http://127.0.0.1:8642/api/sessions/session-1/messages?order=oldest&limit=2&offset=2',
    );
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      redirect: 'error',
      headers: { Authorization: 'Bearer api-secret' },
    });
  });
  it('stops after one response on older gateways without pagination metadata', async () => {
    const { app, fetcher } = setup('owner', undefined, { historyPageSize: 1 });
    fetcher.mockResolvedValue(json({ data: [{ id: 1, role: 'user' }] }));
    await request(app)
      .post('/main/request')
      .send({ operation: 'messages', sessionId: 's' })
      .expect(200);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('reports truncation instead of silently claiming complete history', async () => {
    const { app, fetcher } = setup('owner', undefined, { historyPageSize: 1, maxHistoryPages: 1 });
    fetcher.mockResolvedValue(json({ data: [{ id: 1, role: 'user' }], pagination: {} }));
    const response = await request(app)
      .post('/main/request')
      .send({ operation: 'messages', sessionId: 's' });
    expect(response.body.truncated).toBe(true);
  });
  it('reads a native session without creating a web conversation', async () => {
    const { app, fetcher } = setup();
    fetcher.mockResolvedValueOnce(json({ session: { id: 's', title: 'Existing' } }));
    const response = await request(app)
      .post('/main/request')
      .send({ operation: 'session', sessionId: 's' })
      .expect(200);
    expect(response.body.session.id).toBe('s');
    expect(String(fetcher.mock.calls[0][0])).toContain('/api/sessions/s');
  });
  it('rejects an obsolete stream endpoint scope before upstream access', async () => {
    const { app, fetcher } = setup();
    await request(app)
      .post('/main/stream')
      .send({ sessionId: 's', scope: 'obsolete', input: 'Hello' })
      .expect(409);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('confirms the chosen native model when creating a session', async () => {
    const { app, fetcher } = setup();
    fetcher.mockResolvedValueOnce(json({ session: { id: 's' } }));
    await request(app)
      .post('/main/request')
      .send({ operation: 'create', title: 'New', provider: 'p', model: 'm' })
      .expect(200);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
      title: 'New',
      provider: 'p',
      model: 'm',
      require_model_lock: true,
    });
  });
  it('preserves the Gateway default when creating without an explicit model', async () => {
    const { app, fetcher } = setup();
    fetcher.mockResolvedValueOnce(json({ session: { id: 's' } }));
    await request(app)
      .post('/main/request')
      .send({ operation: 'create', title: 'New' })
      .expect(200);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ title: 'New' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not retry creation or fall back when the selected model cannot be locked', async () => {
    const { app, fetcher } = setup();
    fetcher.mockResolvedValueOnce(json({ error: { code: 'model_lock_unavailable' } }, 409));
    await request(app)
      .post('/main/request')
      .send({ operation: 'create', title: 'New', provider: 'p', model: 'm' })
      .expect(409);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('sends steer with text, not input, and preserves the returned model lock', async () => {
    const { app, fetcher } = setup();
    fetcher.mockResolvedValueOnce(json({ accepted: true }));
    await request(app)
      .post('/main/request')
      .send({ operation: 'steer', runId: 'r', text: 'Add a table' })
      .expect(200);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
      text: expect.stringContaining('</cuate-addendum>\n\nAdd a table'),
    });
    fetcher.mockResolvedValueOnce(
      json({ runtime: { provider: 'routed-provider', model: 'routed-model' } }),
    );
    const result = await request(app)
      .post('/main/request')
      .send({ operation: 'model', sessionId: 's', provider: 'requested', model: 'alias' });
    expect(result.body.runtime.provider).toBe('routed-provider');
  });
  it('uses separate Dashboard credentials for uploads and refuses oversized files', async () => {
    const { app, fetcher } = setup('owner', undefined, { maxUploadBytes: 8 });
    fetcher.mockResolvedValueOnce(json({ path: '/root/cuate-uploads/file.txt' }));
    await request(app)
      .post('/main/upload')
      .attach('file', Buffer.from('hello'), 'file.txt')
      .expect(200);
    expect(fetcher.mock.calls[0][0]).toBe('http://127.0.0.1:9119/api/files/upload-stream');
    expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({
      Authorization: 'Bearer dashboard-secret',
    });
    await request(app)
      .post('/main/upload')
      .attach('file', Buffer.from('too much content'), 'file.txt')
      .expect(413);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('keeps upstream error contents and tokens out of client errors', async () => {
    const { app, fetcher } = setup();
    fetcher.mockResolvedValue(json({ error: 'sensitive internal details' }, 500));
    const result = await request(app)
      .post('/main/request')
      .send({ operation: 'models' })
      .expect(502);
    expect(result.body).toEqual({ error: 'hermes_request_failed' });
  });
  it('forwards terminal context fields without replacing them with cost counters', async () => {
    const { app, fetcher } = setup();
    const body =
      'event: run.completed\ndata: {"usage":{"context_used":35000,"context_max":272000,"total_tokens":2000000}}\n\nevent: done\ndata: {}\n\n';
    fetcher.mockResolvedValue(
      new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }),
    );
    const result = await request(app)
      .post('/main/stream')
      .send({ sessionId: 's', input: 'hello' })
      .expect(200);
    expect(result.text).toBe(body);
    expect(fetcher.mock.calls[0][0]).toContain('/api/sessions/s/chat/stream');
  });
});

describe('Hermes files and approvals', () => {
  it('forwards only an explicit request_id and choice for approval', async () => {
    const { app, fetcher } = setup();
    fetcher
      .mockResolvedValueOnce(
        json({
          status: 'waiting_for_approval',
          session_id: 's',
          approvals: [{ request_id: 'specific', command: 'cmd' }],
        }),
      )
      .mockResolvedValueOnce(
        json({ run_id: 'r', request_id: 'specific', choice: 'once', resolved: 1 }),
      );
    await request(app)
      .post('/main/request')
      .send({
        operation: 'approval',
        scope,
        sessionId: 's',
        runId: 'r',
        requestId: 'specific',
        choice: 'once',
      })
      .expect(200);
    expect(fetcher.mock.calls[1][0]).toBe('http://127.0.0.1:8642/v1/runs/r/approval');
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({
      request_id: 'specific',
      choice: 'once',
    });
    await request(app)
      .post('/main/request')
      .send({
        operation: 'approval',
        scope,
        sessionId: 's',
        runId: 'r',
        requestId: '',
        choice: 'always',
      })
      .expect(400);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('does not retry expired approval requests', async () => {
    const { app, fetcher } = setup();
    fetcher.mockResolvedValue(json({}, 409));
    await request(app)
      .post('/main/request')
      .send({
        operation: 'approval',
        scope,
        sessionId: 's',
        runId: 'r',
        requestId: 'old',
        choice: 'deny',
      })
      .expect(409);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('previews HTML as escaped text and authenticates through Dashboard', async () => {
    const { app, fetcher } = setup();
    fetcher.mockResolvedValue(new Response('<script>bad()</script>'));
    const response = await request(app)
      .post('/main/request')
      .send({ operation: 'preview', path: '/tmp/a.html' })
      .expect(200);
    expect(response.body).toMatchObject({ kind: 'text', text: '<script>bad()</script>' });
    expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({
      Authorization: 'Bearer dashboard-secret',
    });
    expect(response.headers['cache-control']).toBe('no-store');
  });
  it('bounds preview bytes even without Content-Length', async () => {
    const { app, fetcher } = setup('owner', undefined, { previewMaxBytes: 3 });
    fetcher.mockResolvedValue(new Response('too large'));
    expect(fetcher).not.toHaveBeenCalled();
    await request(app)
      .post('/main/request')
      .send({ operation: 'preview', path: '/tmp/a.txt' })
      .expect(502);
  });
  it('does not expose previews to another user', async () => {
    const { app, fetcher } = setup('other');
    await request(app)
      .post('/main/request')
      .send({ operation: 'preview', path: '/tmp/a.pdf' })
      .expect(404);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('Approval identity boundary', () => {
  const input = {
    operation: 'approval',
    scope,
    sessionId: 's',
    runId: 'r',
    requestId: 'a',
    choice: 'once',
  };
  it('rejects a changed configured server before any gateway request', async () => {
    const { app, fetcher } = setup();
    await request(app)
      .post('/main/request')
      .send({ ...input, scope: 'previous-server' })
      .expect(409);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects a different session and a stale request without posting a decision', async () => {
    const { app, fetcher } = setup();
    fetcher.mockResolvedValueOnce(
      json({
        status: 'waiting_for_approval',
        session_id: 'other',
        approvals: [{ request_id: 'a', command: 'cmd' }],
      }),
    );
    await request(app).post('/main/request').send(input).expect(409);
    fetcher.mockResolvedValueOnce(
      json({
        status: 'waiting_for_approval',
        session_id: 's',
        approvals: [{ request_id: 'b', command: 'next' }],
      }),
    );
    await request(app).post('/main/request').send(input).expect(409);
    expect(fetcher.mock.calls.every((call) => call[1]?.method === 'GET')).toBe(true);
  });
  it('requires an exact acknowledgment and never retries a decision', async () => {
    const { app, fetcher } = setup();
    fetcher.mockResolvedValueOnce(
      json({
        status: 'waiting_for_approval',
        session_id: 's',
        approvals: [{ request_id: 'a', command: 'cmd' }],
      }),
    );
    fetcher.mockResolvedValueOnce(
      json({ run_id: 'r', request_id: 'b', choice: 'once', resolved: 1 }),
    );
    await request(app).post('/main/request').send(input).expect(502);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1][1]?.redirect).toBe('error');
  });
  it('preserves only the verified missing-run error, not a generic 404', async () => {
    const { app, fetcher } = setup();
    fetcher.mockResolvedValueOnce(
      json({ error: { code: 'run_not_found', message: 'private detail' } }, 404),
    );
    const missing = await request(app)
      .post('/main/request')
      .send({ operation: 'run', runId: 'r' })
      .expect(404);
    expect(missing.body).toEqual({ error: 'run_not_found' });
    fetcher.mockResolvedValueOnce(
      json({ error: { code: 'other', message: 'private detail' } }, 404),
    );
    const unknown = await request(app)
      .post('/main/request')
      .send({ operation: 'run', runId: 'r' })
      .expect(404);
    expect(unknown.body).toEqual({ error: 'hermes_request_failed' });
  });
});

it('loads full skill content through the authenticated Dashboard read route', async () => {
  const { app, fetcher } = setup();
  fetcher.mockResolvedValueOnce(json({ name: 'category/a b', content: '# Full skill' }));
  const result = await request(app)
    .post('/main/request')
    .send({ operation: 'skills', name: 'category/a b' })
    .expect(200);
  expect(String(fetcher.mock.calls[0][0])).toBe(
    'http://127.0.0.1:9119/api/skills/content?name=category%2Fa%20b',
  );
  expect(result.body.content).toBe('# Full skill');
});
it('does not read skill content for another owner', async () => {
  const { app, fetcher } = setup('other');
  await request(app)
    .post('/main/request')
    .send({ operation: 'skills', name: 'computer-use' })
    .expect(404);
  expect(fetcher).not.toHaveBeenCalled();
});
