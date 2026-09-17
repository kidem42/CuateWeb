import { hermesRunActive } from 'librechat-data-provider';
import type { HermesCapabilities, HermesRequest } from 'librechat-data-provider';
import type { SessionState } from './state';

/** Explicit Steer cannot fall through to creating a turn when a run ends. */
export async function sendHermesSteer(options: {
  state: SessionState;
  streaming: boolean;
  capabilities?: HermesCapabilities;
  text: string;
  request: <T>(connection: string, input: HermesRequest) => Promise<T>;
}) {
  const { state, text, capabilities, streaming, request } = options;
  if (
    state.deleted ||
    !state.binding ||
    !text.trim() ||
    state.status === 'stopping' ||
    state.status === 'unconfirmed' ||
    !(hermesRunActive(state.status) || streaming || state.externalBusy)
  ) {
    throw new Error('session_not_steerable');
  }
  const { connectionId, scope, sessionId } = state.binding;
  let input: HermesRequest;
  if (state.runId && hermesRunActive(state.status) && capabilities?.features?.run_steer) {
    input = { operation: 'steer', runId: state.runId, scope, text };
  } else if (capabilities?.features?.session_steer) {
    input = { operation: 'sessionSteer', sessionId, scope, text };
  } else throw new Error('steer_unsupported');
  const result = await request<{ accepted?: boolean; queued?: boolean; status?: string }>(
    connectionId,
    input,
  );
  if (result.accepted !== true && result.queued !== true && result.status !== 'queued')
    throw new Error('steer_unconfirmed');
}
