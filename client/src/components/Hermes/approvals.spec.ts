import { HermesEngine } from './engine';
import type { HermesEngineDependencies } from './engine';
import type { SessionState } from './state';
import type { HermesApproval, HermesRun } from 'librechat-data-provider';

function fixture() {
  let pending: HermesApproval[] = [
    { request_id: 'a', run_id: 'r', command: 'first' },
    { request_id: 'b', run_id: 'r', command: 'second' },
  ];
  let state: SessionState = {
    binding: { userId: 'u', connectionId: 'c', scope: 'host', sessionId: 's' },
    runId: 'r',
    status: 'waiting_for_approval',
    approvals: Object.fromEntries(pending.map((item) => [item.request_id, item])),
  };
  const request = jest.fn(
    async () =>
      ({
        run_id: 'r',
        session_id: 's',
        status: 'waiting_for_approval',
        cuate_approval_version: 1,
        approvals: pending,
      }) as HermesRun,
  );
  const answer = jest.fn(
    async (_connection: string, input: Parameters<HermesEngineDependencies['answer']>[1]) => {
      pending = pending.filter((item) => item.request_id !== input.requestId);
      return {
        run_id: input.runId,
        request_id: input.requestId,
        choice: input.choice,
        resolved: 1,
      };
    },
  );
  const deps: HermesEngineDependencies = {
    get: () => state,
    patch: (_key, value) => {
      state = { ...state, ...value };
    },
    live: () => {},
    request: request as HermesEngineDependencies['request'],
    answer,
    stream: async () => {},
    refresh: () => {},
    now: () => 1,
  };
  return {
    engine: new HermesEngine(deps),
    reload: () => new HermesEngine(deps),
    state: () => state,
    patch: (value: Partial<SessionState>) => deps.patch('k', value),
    pending: (value: HermesApproval[]) => {
      pending = value;
    },
    request,
    answer,
  };
}
describe('Scoped Hermes action decisions', () => {
  it('restores all pending cards and removes ones answered by another device', async () => {
    const f = fixture();
    f.patch({ approvals: {} });
    await f.engine.readApprovals('k', 'r');
    expect(Object.keys(f.state().approvals!)).toEqual(['a', 'b']);
    f.pending([{ request_id: 'b', command: 'second' }]);
    await f.engine.readApprovals('k', 'r');
    expect(Object.keys(f.state().approvals!)).toEqual(['b']);
  });
  it('sends one exact scoped decision, leaving the other request pending', async () => {
    const f = fixture();
    await f.engine.approve('k', 'r', 'a', 'once');
    expect(f.answer).toHaveBeenCalledTimes(1);
    expect(f.answer).toHaveBeenCalledWith('c', {
      operation: 'approval',
      scope: 'host',
      sessionId: 's',
      runId: 'r',
      requestId: 'a',
      choice: 'once',
    });
    await f.engine.readApprovals('k', 'r');
    expect(Object.keys(f.state().approvals!)).toEqual(['b']);
  });
  it('never lets a stale card select the next request or a new run', async () => {
    const f = fixture();
    f.pending([{ request_id: 'b', command: 'second' }]);
    await expect(f.engine.approve('k', 'r', 'a', 'once')).rejects.toThrow();
    f.patch({ runId: 'new-run' });
    await expect(f.engine.approve('k', 'r', 'b', 'once')).rejects.toThrow();
    expect(f.answer).not.toHaveBeenCalled();
  });
  it('retains uncertainty across polling and reload, requiring an explicit refresh', async () => {
    const f = fixture();
    f.answer.mockRejectedValue(new Error('lost response'));
    await expect(f.engine.approve('k', 'r', 'a', 'once')).rejects.toThrow();
    const reload = f.reload();
    await reload.readApprovals('k', 'r');
    expect(f.state().approvalPhases?.['["r","a"]']).toBe('uncertain');
    await expect(reload.approve('k', 'r', 'a', 'once')).rejects.toThrow();
    expect(f.answer).toHaveBeenCalledTimes(1);
    await reload.readApprovals('k', 'r', true);
    expect(f.state().approvalPhases?.['["r","a"]']).toBeUndefined();
  });
  it('treats a persisted in-flight decision as uncertain after reload', async () => {
    const f = fixture();
    f.patch({ approvalPhases: { '["r","a"]': 'sending' } });
    await f.reload().readApprovals('k', 'r');
    expect(f.state().approvalPhases?.['["r","a"]']).toBe('uncertain');
    expect(f.answer).not.toHaveBeenCalled();
  });
  it('rejects a mismatched acknowledgment without retrying the POST', async () => {
    const f = fixture();
    f.answer.mockResolvedValue({ run_id: 'r', request_id: 'b', choice: 'once', resolved: 1 });
    await expect(f.engine.approve('k', 'r', 'a', 'once')).rejects.toThrow();
    expect(f.answer).toHaveBeenCalledTimes(1);
    expect(f.state().approvalPhases?.['["r","a"]']).toBe('uncertain');
  });
  it('blocks duplicate taps and an approval racing with Stop', async () => {
    const f = fixture();
    const snapshot = await f.request();
    let complete!: (value: HermesRun) => void;
    f.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const first = f.engine.approve('k', 'r', 'a', 'once');
    await expect(f.engine.approve('k', 'r', 'a', 'once')).rejects.toThrow();
    f.patch({ status: 'stopping' });
    complete(snapshot);
    await expect(first).rejects.toThrow();
    expect(f.answer).not.toHaveBeenCalled();
  });
  it('blocks a connection change during preflight', async () => {
    const f = fixture();
    const snapshot = await f.request();
    f.request.mockImplementationOnce(async () => {
      f.patch({ binding: { ...f.state().binding!, scope: 'other-host' } });
      return snapshot;
    });
    await expect(f.engine.approve('k', 'r', 'a', 'once')).rejects.toThrow();
    expect(f.answer).not.toHaveBeenCalled();
  });
  it('does not treat a generic 404 as a confirmed missing run', async () => {
    const f = fixture();
    f.request.mockRejectedValue({
      isAxiosError: true,
      response: { status: 404, data: { error: 'hermes_request_failed' } },
    });
    await expect(f.engine.readApprovals('k', 'r', true)).rejects.toBeDefined();
    expect(f.state().status).toBe('waiting_for_approval');
    expect(Object.keys(f.state().approvals!)).toEqual(['a', 'b']);
  });
});
