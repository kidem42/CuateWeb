import { sendHermesSteer } from './steer';
import type { SessionState } from './state';
const state: SessionState = {
  binding: { userId: 'u', connectionId: 'c', scope: 'host', sessionId: 's' },
  runId: 'r',
  status: 'running',
};
const capabilities = { features: { run_steer: true, session_steer: true } };
const input = () => ({
  state,
  streaming: false,
  capabilities: { features: { ...capabilities.features } },
  text: 'Add a table',
  request: jest.fn().mockResolvedValue({ accepted: true }),
});
describe('native Hermes Steer', () => {
  it('targets the known run and endpoint', async () => {
    const deps = input();
    await sendHermesSteer(deps);
    expect(deps.request).toHaveBeenCalledWith('c', {
      operation: 'steer',
      runId: 'r',
      scope: 'host',
      text: deps.text,
    });
  });
  it('uses session steer only when advertised and no run steer is available', async () => {
    const deps = input();
    deps.capabilities.features.run_steer = false;
    await sendHermesSteer(deps);
    expect(deps.request).toHaveBeenCalledWith('c', {
      operation: 'sessionSteer',
      sessionId: 's',
      scope: 'host',
      text: deps.text,
    });
  });
  it.each(['completed', 'cancelled', 'stopping', 'unconfirmed'])(
    'refuses %s without starting a new turn',
    async (status) => {
      const deps = { ...input(), state: { ...state, status } };
      await expect(sendHermesSteer(deps)).rejects.toThrow('session_not_steerable');
      expect(deps.request).not.toHaveBeenCalled();
    },
  );
  it('does not retry or switch endpoints on a lost reply', async () => {
    const deps = input();
    deps.request.mockRejectedValue(new Error('lost reply'));
    await expect(sendHermesSteer(deps)).rejects.toThrow('lost reply');
    expect(deps.request).toHaveBeenCalledTimes(1);
  });
  it('accepts the native queued status', async () => {
    const deps = input();
    deps.request.mockResolvedValue({ status: 'queued' });
    await expect(sendHermesSteer(deps)).resolves.toBeUndefined();
  });
  it('requires a positive acknowledgement', async () => {
    const deps = input();
    deps.request.mockResolvedValue({ accepted: false });
    await expect(sendHermesSteer(deps)).rejects.toThrow('steer_unconfirmed');
  });
});
