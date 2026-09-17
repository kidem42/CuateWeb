import { hermesPendingApprovals } from '../hermes';
import { answerHermesApproval } from '../data-service';

describe('Approval snapshots and one-shot transport', () => {
  afterEach(() => jest.restoreAllMocks());
  it('prefers an authoritative empty array over an obsolete singular request', () => {
    expect(
      hermesPendingApprovals(
        {
          status: 'waiting_for_approval',
          approvals: [],
          approval: { request_id: 'old', command: 'old' },
        },
        'r',
      ),
    ).toEqual({});
  });
  it('rejects incomplete v6 snapshots and filters foreign run requests', () => {
    expect(() =>
      hermesPendingApprovals({ status: 'waiting_for_approval', cuate_approval_version: 1 }, 'r'),
    ).toThrow();
    expect(
      hermesPendingApprovals(
        {
          status: 'waiting_for_approval',
          approvals: [{ request_id: 'a', command: 'cmd', run_id: 'other' }],
        },
        'r',
      ),
    ).toEqual({});
  });
  it('does not interpret object prototype properties as pending requests', () => {
    const rows = hermesPendingApprovals({ status: 'waiting_for_approval', approvals: [] }, 'r');
    expect(rows['__proto__']).toBeUndefined();
    expect(rows['constructor']).toBeUndefined();
  });
  it('makes one fetch attempt with redirects refused when the response is lost', async () => {
    const fetcher = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('connection reset'));
    await expect(
      answerHermesApproval(
        'c',
        {
          operation: 'approval',
          scope: 'host',
          sessionId: 's',
          runId: 'r',
          requestId: 'a',
          choice: 'once',
        },
        'token',
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      redirect: 'error',
      body: JSON.stringify({
        operation: 'approval',
        scope: 'host',
        sessionId: 's',
        runId: 'r',
        requestId: 'a',
        choice: 'once',
      }),
    });
  });
});
