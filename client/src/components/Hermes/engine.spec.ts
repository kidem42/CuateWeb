import { HermesEngine } from './engine';
import type { HermesEngineDependencies } from './engine';
import type { HermesLive, SessionState } from './state';
import { hermesConfigSchema } from 'librechat-data-provider';
import type {
  HermesAccess,
  HermesFrame,
  HermesRequest,
  HermesHistory,
  HermesRun,
} from 'librechat-data-provider';

const binding = { userId: 'u', connectionId: 'c', scope: 'host-a', sessionId: 's' };
const notice = { id: 9, role: 'user', content: '[ASYNC DELEGATION COMPLETE deleg_a]\nDone' };
const access: HermesAccess = {
  ...hermesConfigSchema.parse({}),
  id: 'c',
  label: 'Local',
  scope: 'host-a',
  files: true,
};
function fixture(initial: Partial<SessionState> = {}) {
  let state: SessionState = { binding, ...initial };
  let live: HermesLive = {};
  const request = jest.fn(
    async (_connection: string, input: HermesRequest): Promise<HermesRun | HermesHistory> =>
      input.operation === 'run' ? { status: 'completed' } : { data: [notice], truncated: false },
  );
  const stream = jest.fn(
    async (
      _connection: string,
      _input: unknown,
      _signal: AbortSignal,
      frame: (value: HermesFrame) => void,
    ) => {
      frame({ event: 'run.started', data: { run_id: 'r2' } });
      frame({ event: 'run.completed', data: {} });
    },
  );
  const deps: HermesEngineDependencies = {
    get: () => state,
    patch: (_key, value) => {
      state = { ...state, ...value };
    },
    live: (_key, value) => {
      live = { ...live, ...value };
    },
    answer: async (_connection, input) => ({
      run_id: input.runId,
      request_id: input.requestId,
      choice: input.choice,
      resolved: 1,
    }),
    request: request as HermesEngineDependencies['request'],
    stream,
    now: () => 100000,
    refresh: () => {},
  };
  return {
    engine: new HermesEngine(deps),
    state: () => state,
    live: () => live,
    patch: (value: Partial<SessionState>) => deps.patch('k', value),
    request,
    stream,
  };
}
describe('Hermes session lifecycle', () => {
  it('claims one delivery before POST and prevents concurrent continuation', async () => {
    const f = fixture({ automatic: true, runId: 'r1', status: 'completed' });
    await Promise.all([f.engine.continue('k', [9], true), f.engine.continue('k', [9], true)]);
    expect(f.stream).toHaveBeenCalledTimes(1);
    expect(f.state().handled).toEqual([9]);
    await f.engine.continue('k', [9], true);
    expect(f.stream).toHaveBeenCalledTimes(1);
  });
  it('does not repeat a paid call after an ambiguous failure or reload', async () => {
    const f = fixture({ automatic: true });
    f.stream.mockRejectedValue(new Error('lost response'));
    await expect(f.engine.continue('k', [9], true)).rejects.toThrow();
    expect(f.state()).toMatchObject({ handled: [9], automatic: false, status: 'unconfirmed' });
    const reload = fixture(f.state());
    await reload.engine.continue('k', [9]);
    expect(reload.stream).not.toHaveBeenCalled();
  });
  it('rejects a delivery superseded by another device', async () => {
    const f = fixture();
    f.request.mockResolvedValue({
      data: [notice, { id: 10, role: 'assistant', content: 'Already done' }],
      truncated: false,
    });
    await f.engine.continue('k', [9]);
    expect(f.stream).not.toHaveBeenCalled();
  });
  it('rechecks consent after the asynchronous preflight', async () => {
    const f = fixture({ automatic: true });
    f.request.mockImplementation(async () => {
      f.patch({ automatic: false });
      return { data: [notice], truncated: false };
    });
    await f.engine.continue('k', [9], true);
    expect(f.stream).not.toHaveBeenCalled();
  });
  it('blocks continuation when run state is unavailable', async () => {
    const f = fixture({ runId: 'r1', status: 'completed' });
    f.request.mockRejectedValue(new Error('offline'));
    await expect(f.engine.continue('k', [9])).rejects.toThrow();
    expect(f.stream).not.toHaveBeenCalled();
  });
  it('keeps tool approval separate from continuation consent and preserves the other card', async () => {
    const f = fixture({
      runId: 'r1',
      automatic: true,
      approvals: {
        a: { request_id: 'a', command: 'cmd' },
        b: { request_id: 'b', command: 'other' },
      },
    });
    f.request.mockImplementation(async () => ({
      status: 'waiting_for_approval',
      approvals: [
        { request_id: 'a', command: 'cmd' },
        { request_id: 'b', command: 'other' },
      ],
    }));
    await f.engine.approve('k', 'r1', 'a', 'deny');
    expect(Object.keys(f.state().approvals!)).toEqual(['a', 'b']);
    expect(f.state().approvalPhases?.['["r1","a"]']).toBe('accepted');
    expect(f.stream).not.toHaveBeenCalled();
  });
  it('Stop revokes consent immediately even if the stop response is lost', async () => {
    const f = fixture({ runId: 'r1', automatic: true });
    f.request.mockRejectedValue(new Error('offline'));
    await expect(f.engine.stop('k')).rejects.toThrow();
    expect(f.state()).toMatchObject({
      automatic: false,
      followupBlocked: true,
      status: 'stopping',
    });
  });
  it('restores a pending approval by polling a known run', async () => {
    const f = fixture({ runId: 'r1', status: 'running' });
    f.request.mockImplementation(async (_c, input) =>
      input.operation === 'run'
        ? { status: 'waiting_for_approval', approval: { request_id: 'a', command: 'cmd' } }
        : { data: [], truncated: false },
    );
    await f.engine.tick('k', access);
    expect(f.state().approvals?.a.command).toBe('cmd');
    expect(f.stream).not.toHaveBeenCalled();
  });
  it('releases held sends only after stop is confirmed', async () => {
    const f = fixture({ runId: 'r1', status: 'stopping', held: ['next'], followupBlocked: true });
    f.request.mockImplementation(async (_c, input) =>
      input.operation === 'run' ? { status: 'running' } : { data: [], truncated: false },
    );
    await f.engine.tick('k', access);
    expect(f.stream).not.toHaveBeenCalled();
    f.request.mockImplementation(async (_c, input) =>
      input.operation === 'run' ? { status: 'cancelled' } : { data: [], truncated: false },
    );
    await f.engine.tick('k', access);
    expect(f.stream).toHaveBeenCalledTimes(1);
    expect(f.state().held).toEqual([]);
  });
  it('does not keep the stopped turn busy because its user message has no answer', async () => {
    const f = fixture({ runId: 'r1', status: 'stopping', stoppingAt: 100000 });
    f.request.mockImplementation(async (_c, input) =>
      input.operation === 'run'
        ? { status: 'cancelled' }
        : { data: [{ id: 1, role: 'user', content: 'request', timestamp: 90 }], truncated: false },
    );
    await f.engine.tick('k', access);
    expect(f.state()).toMatchObject({ status: 'cancelled', externalBusy: false });
  });
  it('accumulates deltas and does not cancel when the conversation view changes', async () => {
    const f = fixture();
    f.stream.mockImplementation(async (_c, _input, signal, frame) => {
      frame({ event: 'assistant.delta', data: { delta: 'hello' } });
      expect(f.live().text).toBe('hello');
      expect(signal.aborted).toBe(false);
      frame({ event: 'run.completed', data: {} });
    });
    await f.engine.send('k', 'hello');
    expect(f.live().streaming).toBe(false);
  });
});

it('never polls or continues a confirmed deleted native session', async () => {
  const f = fixture({ deleted: true, automatic: true, runId: 'r', status: 'running' });
  await f.engine.tick('k', access);
  await f.engine.continue('k', [9], true);
  await expect(f.engine.send('k', 'Again')).rejects.toThrow('session_busy');
  expect(f.request).not.toHaveBeenCalled();
  expect(f.stream).not.toHaveBeenCalled();
});

describe('Formatting briefing acceptance', () => {
  it('briefs only the first accepted turn and keeps the visible draft unchanged', async () => {
    const f = fixture();
    await f.engine.send('k', 'Hello', [], undefined, true);
    expect(f.stream.mock.calls[0][1]).toMatchObject({
      input: expect.stringContaining('<cuate-briefing>'),
    });
    expect(f.state().briefed).toBe(true);
    await f.engine.send('k', 'Again', [], undefined, true);
    expect(f.stream.mock.calls[1][1]).toMatchObject({ input: 'Again' });
  });
  it('does not mark unacknowledged delivery or replace the recoverable draft', async () => {
    const f = fixture();
    f.stream.mockRejectedValue(new Error('offline'));
    await expect(f.engine.send('k', 'Hello', [], undefined, true)).rejects.toThrow('offline');
    expect(f.state().briefed).not.toBe(true);
    expect(f.live().sent).toBe('Hello');
    expect(f.stream).toHaveBeenCalledTimes(1);
  });
  it('keeps slash commands unchanged and briefs a later multimodal turn', async () => {
    const f = fixture();
    await f.engine.send('k', '/help', [], undefined, true);
    expect(f.state().briefed).not.toBe(true);
    await f.engine.send('k', 'Image', ['data:image/png;base64,AA=='], undefined, true);
    expect(f.stream.mock.calls[1][1]).toMatchObject({
      input: [
        { type: 'text', text: expect.stringContaining('<cuate-briefing>') },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
      ],
    });
  });
  it('respects a restored or cross-client briefing marker', async () => {
    const f = fixture({ briefed: true });
    await f.engine.send('k', 'Hello', [], undefined, true);
    expect(f.stream.mock.calls[0][1]).toMatchObject({ input: 'Hello' });
  });
});

it('treats native error/done as a failed run and releases model selection without replay', async () => {
  const f = fixture({ automatic: true, held: ['Do not auto-send'] });
  f.stream.mockImplementation(async (_connection, _input, _signal, frame) => {
    frame({ event: 'run.started', data: { run_id: 'r2' } });
    frame({ event: 'error', data: { message: '404: model example does not exist' } });
    frame({ event: 'done', data: {} });
  });
  const accepted = jest.fn();
  await f.engine.send('k', 'Saved request', [], accepted);
  expect(accepted).toHaveBeenCalledTimes(1);
  expect(f.state()).toMatchObject({
    status: 'failed',
    failureReason: 'model_unavailable',
    externalBusy: false,
    automatic: false,
  });
  expect(f.live()).toMatchObject({ streaming: false, sent: '', error: true });
  f.request.mockResolvedValue({
    data: [{ id: 10, role: 'user', content: 'Saved request', timestamp: 99 }],
    truncated: false,
  });
  await f.engine.tick('k', access);
  expect(f.state().externalBusy).toBe(false);
  expect(f.stream).toHaveBeenCalledTimes(1);
  expect(f.state().held).toEqual(['Do not auto-send']);
});
it('recovers an already failed run saved by the older client without waiting for stale-tail expiry', async () => {
  const f = fixture({ runId: 'r1', status: 'failed', externalBusy: true });
  f.request.mockImplementation(async (_connection, input) =>
    input.operation === 'run'
      ? { status: 'failed', error: 'model example not found' }
      : {
          data: [{ id: 10, role: 'user', content: 'Saved request', timestamp: 99 }],
          truncated: false,
        },
  );
  await f.engine.tick('k', access);
  expect(f.state()).toMatchObject({
    failureReason: 'model_unavailable',
    externalBusy: false,
    failedAt: 100000,
  });
  expect(f.stream).not.toHaveBeenCalled();
});
it('does not conceal newer external activity after a confirmed failure', async () => {
  const f = fixture({ status: 'failed', failedAt: 98000, failureReason: 'run_failed' });
  f.request.mockResolvedValue({
    data: [{ id: 11, role: 'user', content: 'New turn', timestamp: 99 }],
    truncated: false,
  });
  await f.engine.tick('k', access);
  expect(f.state().externalBusy).toBe(true);
});

it('clears an ambiguous transport warning only after the known run confirms completion', async () => {
  const f = fixture();
  f.stream.mockImplementation(async (_connection, _input, _signal, frame) => {
    frame({ event: 'run.started', data: { run_id: 'r2' } });
    throw new Error('connection lost');
  });
  await expect(f.engine.send('k', 'Already accepted')).rejects.toThrow('connection lost');
  expect(f.live().error).toBe(true);
  f.request.mockImplementation(async (_connection, input) =>
    input.operation === 'run'
      ? { status: 'completed' }
      : { data: [{ id: 11, role: 'assistant', content: 'Done' }], truncated: false },
  );
  await f.engine.tick('k', access);
  expect(f.live()).toMatchObject({ error: false, sent: '' });
  expect(f.stream).toHaveBeenCalledTimes(1);
});

describe('External client completion', () => {
  const question = { id: 21, role: 'user', content: 'Question', timestamp: 95 };
  const answer = { id: 22, role: 'assistant', content: 'Answer', timestamp: 96 };
  const earlier = { id: 20, role: 'assistant', content: 'Earlier', timestamp: 90 };
  it.each([false, true])(
    'clears busy when the question was already observed: %s',
    async (observed) => {
      const f = fixture();
      f.request.mockResolvedValue({
        truncated: false,
        data: observed ? [earlier, question] : [earlier],
      });
      await f.engine.tick('k', access);
      f.request.mockResolvedValue({ truncated: false, data: [earlier, question, answer] });
      await f.engine.tick('k', access);
      expect(f.state().externalBusy).toBe(false);
      await f.engine.tick('k', access);
      expect(f.state().externalBusy).toBe(false);
      expect(f.stream).not.toHaveBeenCalled();
    },
  );
  it('reconciles persisted external busy after reloading a completed exchange', async () => {
    const f = fixture({ externalBusy: true });
    f.request.mockResolvedValue({ truncated: false, data: [question, answer] });
    await f.engine.tick('k', access);
    expect(f.state().externalBusy).toBe(false);
    expect(f.stream).not.toHaveBeenCalled();
  });
  it('retains authoritative active runs despite an assistant progress message', async () => {
    const f = fixture({ runId: 'r1', status: 'running' });
    f.request.mockImplementation(async (_c, input) =>
      input.operation === 'run'
        ? { status: 'running' }
        : { truncated: false, data: [question, answer] },
    );
    await f.engine.tick('k', access);
    expect(f.state().status).toBe('running');
    expect(f.stream).not.toHaveBeenCalled();
  });
  it('retains the growth grace period for assistant-only progress', async () => {
    const f = fixture();
    f.request.mockResolvedValue({ truncated: false, data: [earlier] });
    await f.engine.tick('k', access);
    f.request.mockResolvedValue({ truncated: false, data: [earlier, answer] });
    await f.engine.tick('k', access);
    expect(f.state().externalBusy).toBe(true);
  });
});
