import { isAxiosError } from 'axios';
import {
  hermesWithBriefing,
  hermesHasBriefing,
  hermesContinuationRows,
  hermesContinuationPrompt,
  hermesNeedsContinuation,
  hermesSameDelivery,
  hermesRunActive,
  hermesRunTerminal,
  hermesLiveTail,
  hermesText,
  hermesServiceNotice,
  hermesUnframe,
  hermesPendingApprovals,
} from 'librechat-data-provider';
import type {
  HermesAccess,
  HermesChat,
  HermesFrame,
  HermesHistory,
  HermesRequest,
  HermesRun,
} from 'librechat-data-provider';
import type { HermesBinding, HermesLive, SessionState } from './state';

export type HermesEngineDependencies = {
  get: (key: string) => SessionState;
  patch: (key: string, value: Partial<SessionState>) => void;
  live: (key: string, value: Partial<HermesLive>) => void;
  answer: (
    connection: string,
    input: Extract<HermesRequest, { operation: 'approval' }>,
  ) => Promise<{ run_id: string; request_id: string; choice: string; resolved: number }>;
  request: <T>(connection: string, input: HermesRequest) => Promise<T>;
  stream: (
    connection: string,
    input: HermesChat,
    signal: AbortSignal,
    frame: (value: HermesFrame) => void,
  ) => Promise<void>;
  refresh: (binding: HermesBinding) => void;
  now: () => number;
  exclusive?: (key: string, action: () => Promise<void>) => Promise<void>;
};
/** Browser lifecycle only. Hermes remains authoritative for runs and messages. */
export class HermesEngine {
  private streams = new Map<string, AbortController>();
  private checking = new Set<string>();
  private claims = new Set<string>();
  private tails = new Map<string, { id?: number; growthUntil: number; owned: boolean }>();
  private disposed = false;
  private decisions = new Set<string>();
  private approvalEpoch = new Map<string, number>();
  constructor(private deps: HermesEngineDependencies) {}
  activate() {
    this.disposed = false;
  }

  dispose() {
    this.disposed = true;
    for (const controller of this.streams.values()) {
      controller.abort();
    }
    this.streams.clear();
  }

  detach(key: string) {
    this.streams.get(key)?.abort();
    this.streams.delete(key);
    this.tails.delete(key);
  }

  async send(
    key: string,
    message: string,
    images: string[] = [],
    accepted?: () => void,
    formatting = false,
  ) {
    const state = this.deps.get(key);
    if (state.deleted || !state.binding || this.streams.has(key) || this.disposed) {
      throw new Error('session_busy');
    }
    const wireMessage = formatting && !state.briefed ? hermesWithBriefing(message) : message;
    const briefed = wireMessage !== message;
    const binding = state.binding;
    const controller = new AbortController();
    this.streams.set(key, controller);
    this.deps.patch(key, {
      runId: undefined,
      status: 'queued',
      pending: undefined,
      approvals: {},
      approvalPhases: {},
      stoppingAt: undefined,
      failedAt: undefined,
      failureReason: undefined,
    });
    this.deps.live(key, { text: '', tool: '', sent: message, error: false, streaming: true });
    let finished = false;
    let accumulated = '';
    let observedRun: string | undefined;
    try {
      await this.deps.stream(
        binding.connectionId,
        {
          sessionId: binding.sessionId,
          scope: binding.scope,
          input: images.length
            ? [
                { type: 'text', text: wireMessage },
                ...images.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
              ]
            : wireMessage,
        },
        controller.signal,
        ({ event, data }) => {
          if (this.disposed || this.deps.get(key).deleted) {
            return;
          }
          if (event === 'run.started' && data.run_id) {
            observedRun = data.run_id;
            this.deps.patch(key, {
              runId: observedRun,
              status: 'running',
              ...(briefed ? { briefed: true } : {}),
            });
            accepted?.();
            accepted = undefined;
          }
          if (event === 'error') {
            finished = true;
            this.failRun(key, data.message);
          }
          if (event === 'assistant.delta') {
            accumulated += data.delta ?? '';
            this.deps.live(key, { text: accumulated });
          }
          if (event === 'message.started') {
            accumulated = '';
            this.deps.live(key, { text: '' });
          }
          if (event === 'assistant.completed') {
            accumulated = data.content ?? accumulated;
            this.deps.live(key, { text: accumulated });
            if (data.runtime) {
              this.deps.patch(key, data.runtime);
            }
          }
          if (event === 'tool.started' || event === 'tool.progress') {
            this.deps.live(key, { tool: data.tool_name ?? '' });
          }
          if (event === 'tool.completed') {
            this.deps.live(key, { tool: '' });
          }
          if (
            ['approval.request', 'approval.responded', 'approval.changed'].includes(event) &&
            observedRun
          ) {
            const runId = observedRun;
            this.approvalEpoch.set(key, (this.approvalEpoch.get(key) ?? 0) + 1);
            void this.readApprovals(key, runId).catch(() => this.deps.live(key, { error: true }));
          }
          if (['run.completed', 'run.failed', 'run.cancelled'].includes(event)) {
            finished = true;
            if (event === 'run.failed' || data.status === 'failed') {
              this.failRun(key, data.error);
            }
            this.deps.patch(key, {
              status: data.status ?? event.slice(4),
              usage: data.usage,
              pending: data.pending_steer ? hermesUnframe(data.pending_steer) : undefined,
              approvals: {},
            });
          }
        },
      );
      if (!finished) {
        throw new Error('stream_disconnected');
      }
      this.deps.live(key, {
        sent: '',
        text: '',
        tool: '',
        error: this.deps.get(key).status === 'failed',
      });
    } catch (error) {
      if (finished && this.deps.get(key).status === 'failed') return;
      if (!this.disposed) {
        this.deps.live(key, { error: true });
        if (!observedRun) {
          this.deps.patch(key, { status: 'unconfirmed', automatic: false });
        }
      }
      throw error;
    } finally {
      this.streams.delete(key);
      this.deps.live(key, { streaming: false });
      if (!this.disposed) {
        this.deps.refresh(binding);
      }
    }
  }

  private reconcileApprovals(key: string, runId: string, run: HermesRun, manual = false) {
    const state = this.deps.get(key);
    if (this.disposed || state.runId !== runId || !state.binding) {
      return;
    }
    if (run.session_id && run.session_id !== state.binding.sessionId) {
      throw new Error('session_identity_changed');
    }
    const approvals = hermesPendingApprovals(run, runId);
    const phases: NonNullable<SessionState['approvalPhases']> = {};
    for (const id of Object.keys(approvals)) {
      const identity = JSON.stringify([runId, id]);
      let phase = state.approvalPhases?.[identity];
      if (phase === 'sending' && !this.decisions.has(key + identity)) {
        phase = 'uncertain';
      }
      if (phase && !(manual && phase === 'uncertain')) {
        phases[identity] = phase;
      }
    }
    this.deps.patch(key, { approvals, approvalPhases: phases });
  }

  private failRun(key: string, error?: unknown) {
    const modelUnavailable =
      typeof error === 'string' &&
      /model/i.test(error) &&
      /not found|not exist|not available|model_not_found/i.test(error);
    this.deps.patch(key, {
      status: 'failed',
      failedAt: this.deps.now(),
      failureReason: modelUnavailable ? 'model_unavailable' : 'run_failed',
      externalBusy: false,
      automatic: false,
      followupBlocked: true,
      pending: undefined,
      approvals: {},
    });
    this.deps.live(key, { error: true, sent: '', tool: '' });
  }

  async readApprovals(key: string, runId: string, manual = false): Promise<HermesRun> {
    const state = this.deps.get(key);
    if (!state.binding || state.runId !== runId || this.disposed) {
      throw new Error('approval_expired');
    }
    const epoch = this.approvalEpoch.get(key) ?? 0;
    const run = await this.deps.request<HermesRun>(state.binding.connectionId, {
      operation: 'run',
      runId,
      scope: state.binding.scope,
    });
    if (epoch !== (this.approvalEpoch.get(key) ?? 0)) {
      throw new Error('approval_snapshot_superseded');
    }
    this.reconcileApprovals(key, runId, run, manual);
    return run;
  }

  async approve(key: string, runId: string, requestId: string, choice: 'once' | 'deny') {
    const state = this.deps.get(key);
    const identity = JSON.stringify([runId, requestId]);
    const lock = key + identity;
    const original = state.approvals?.[requestId];
    if (
      !state.binding ||
      state.runId !== runId ||
      !original ||
      state.approvalPhases?.[identity] ||
      this.decisions.has(lock) ||
      state.status === 'stopping'
    ) {
      throw new Error('approval_expired');
    }
    const binding = state.binding;
    this.decisions.add(lock);
    this.approvalEpoch.set(key, (this.approvalEpoch.get(key) ?? 0) + 1);
    const phase = (value: 'sending' | 'uncertain' | 'accepted') => {
      const current = this.deps.get(key);
      if (current.runId === runId && current.approvals?.[requestId]) {
        this.deps.patch(key, { approvalPhases: { ...current.approvalPhases, [identity]: value } });
      }
    };
    phase('sending');
    try {
      const fresh = await this.readApprovals(key, runId);
      const current = this.deps.get(key);
      if (
        this.disposed ||
        current.runId !== runId ||
        current.binding?.scope !== binding.scope ||
        current.status === 'stopping' ||
        hermesPendingApprovals(fresh, runId)[requestId]?.command !== original.command
      ) {
        throw new Error('approval_expired');
      }
      const reply = await this.deps.answer(binding.connectionId, {
        operation: 'approval',
        scope: binding.scope,
        sessionId: binding.sessionId,
        runId,
        requestId,
        choice,
      });
      if (
        reply.run_id !== runId ||
        reply.request_id !== requestId ||
        reply.choice !== choice ||
        reply.resolved !== 1
      ) {
        throw new Error('approval_response_unconfirmed');
      }
      phase('accepted');
    } catch (error) {
      phase('uncertain');
      throw error;
    } finally {
      this.decisions.delete(lock);
      this.approvalEpoch.set(key, (this.approvalEpoch.get(key) ?? 0) + 1);
      void this.readApprovals(key, runId).catch(() => this.deps.live(key, { error: true }));
    }
  }

  async stop(key: string) {
    const state = this.deps.get(key);
    this.deps.patch(key, { automatic: false, followupBlocked: true });
    if (!state.binding || !state.runId) {
      return;
    }
    this.deps.patch(key, { status: 'stopping', stoppingAt: this.deps.now() });
    try {
      await this.deps.request(state.binding.connectionId, {
        operation: 'stop',
        scope: state.binding.scope,
        runId: state.runId,
      });
    } catch (error) {
      if (missingRun(error)) {
        this.deps.patch(key, { status: 'gone' });
      } else {
        throw error;
      }
    }
  }

  async continue(key: string, expected: number[], automatic = false) {
    const action = () => this.continueLocked(key, expected, automatic);
    return this.deps.exclusive ? this.deps.exclusive(key, action) : action();
  }

  private async continueLocked(key: string, expected: number[], automatic: boolean) {
    if (this.claims.has(key) || this.streams.has(key) || this.disposed) {
      return;
    }
    this.claims.add(key);
    try {
      let state = this.deps.get(key);
      if (
        state.deleted ||
        !state.binding ||
        state.pending ||
        state.followupBlocked ||
        (automatic && !state.automatic) ||
        state.status === 'unconfirmed'
      ) {
        return;
      }
      const binding = state.binding;
      if (state.runId) {
        try {
          const run = await this.deps.request<HermesRun>(binding.connectionId, {
            operation: 'run',
            scope: binding.scope,
            runId: state.runId,
          });
          if (!hermesRunTerminal(run.status) || run.pending_steer) {
            return;
          }
        } catch (error) {
          if (!missingRun(error)) {
            throw error;
          }
        }
      }
      const fresh = await this.deps.request<HermesHistory>(binding.connectionId, {
        operation: 'messages',
        sessionId: binding.sessionId,
        scope: binding.scope,
      });
      state = this.deps.get(key);
      const actual = hermesContinuationRows(fresh.data);
      if (
        this.disposed ||
        state.deleted ||
        fresh.truncated ||
        !hermesSameDelivery(expected, actual) ||
        !hermesNeedsContinuation(actual, state.handled) ||
        state.followupBlocked ||
        (automatic && !state.automatic) ||
        this.streams.has(key)
      ) {
        return;
      }
      // Claim before POST. An ambiguous network failure must never replay a paid turn.
      this.deps.patch(key, {
        handled: [...new Set([...(state.handled ?? []), ...actual])],
        delivery: [],
        deferred: false,
      });
      await this.send(key, hermesContinuationPrompt);
    } finally {
      this.claims.delete(key);
    }
  }

  async tick(key: string, connection: HermesAccess) {
    if (this.checking.has(key) || this.disposed) {
      return;
    }
    this.checking.add(key);
    try {
      let state = this.deps.get(key);
      if (state.deleted || !state.binding) {
        return;
      }
      const binding = state.binding;
      if (
        state.runId &&
        (hermesRunActive(state.status) ||
          state.status === 'unconfirmed' ||
          (state.status === 'failed' && state.failedAt == null) ||
          Object.keys(state.approvals ?? {}).length > 0)
      ) {
        const runId = state.runId;
        try {
          const run = await this.readApprovals(key, runId);
          if (this.deps.get(key).runId === runId) {
            if (run.status === 'completed' || run.status === 'cancelled') {
              this.deps.live(key, { error: false, sent: '', text: '', tool: '' });
            }
            if (run.status === 'failed' && (state.status !== 'failed' || state.failedAt == null))
              this.failRun(key, 'error' in run ? run.error : undefined);
            this.deps.patch(key, {
              status:
                state.status === 'stopping' && hermesRunActive(run.status)
                  ? 'stopping'
                  : run.status,
              ...(run.usage ? { usage: run.usage } : {}),
              pending: run.pending_steer ? hermesUnframe(run.pending_steer) : undefined,
            });
          }
        } catch (error) {
          if (missingRun(error)) {
            this.deps.patch(key, { status: 'gone', approvals: {} });
          } else {
            throw error;
          }
        }
      }
      const history = await this.deps.request<HermesHistory>(binding.connectionId, {
        operation: 'messages',
        sessionId: binding.sessionId,
        scope: binding.scope,
      });
      if (this.disposed) {
        return;
      }
      state = this.deps.get(key);
      if (state.deleted) return;
      const rows = hermesContinuationRows(history.data);
      const last = history.data.at(-1);
      const previous = this.tails.get(key);
      let growthUntil = previous?.growthUntil ?? 0;
      if (
        previous &&
        !previous.owned &&
        last?.id !== previous.id &&
        last?.role !== 'user' &&
        !this.streams.has(key)
      ) {
        const previousIndex = history.data.findIndex((row) => row.id === previous.id);
        const exchange =
          previousIndex >= 0 &&
          history.data
            .slice(previousIndex)
            .some((row) => row.role === 'user' && !hermesServiceNotice(hermesText(row)));
        growthUntil = exchange ? 0 : this.deps.now() + connection.growthHoldMs;
      }
      this.tails.set(key, {
        id: last?.id,
        growthUntil,
        owned: this.streams.has(key) || hermesRunActive(state.status),
      });
      const externalBusy =
        !rows.length &&
        (hermesLiveTail(history.data, this.deps.now(), connection.liveStaleMs) ||
          growthUntil > this.deps.now());
      const terminalAt = state.status === 'failed' ? state.failedAt : state.stoppingAt;
      const stoppedTail =
        terminalAt != null &&
        hermesRunTerminal(state.status) &&
        (last?.timestamp == null || last.timestamp * 1000 <= terminalAt);
      this.deps.patch(key, {
        ...(hermesHasBriefing(history) ? { briefed: true } : {}),
        delivery: history.truncated ? [] : rows,
        externalBusy: externalBusy && !stoppedTail,
      });
      if (
        this.streams.has(key) ||
        hermesRunActive(state.status) ||
        state.status === 'unconfirmed' ||
        (externalBusy && !stoppedTail) ||
        history.truncated ||
        state.failureReason != null
      ) {
        return;
      }
      if (state.held?.length && hermesRunTerminal(state.status)) {
        const [message, ...rest] = state.held;
        this.deps.patch(key, { held: rest, followupBlocked: false });
        void this.send(key, message).catch(() => {});
        return;
      }
      if (
        state.pending &&
        state.runId &&
        state.status === 'completed' &&
        !state.followupBlocked &&
        state.deliveredRun !== state.runId
      ) {
        this.deps.patch(key, { deliveredRun: state.runId });
        void this.send(key, state.pending).catch(() => {});
        return;
      }
      if (state.automatic && hermesNeedsContinuation(rows, state.handled)) {
        void this.continue(key, rows, true).catch(() => this.deps.live(key, { error: true }));
      }
    } catch {
      this.deps.live(key, { error: true });
    } finally {
      this.checking.delete(key);
    }
  }
}

function missingRun(error: unknown): boolean {
  return (
    isAxiosError(error) &&
    error.response?.status === 404 &&
    error.response.data?.error === 'run_not_found'
  );
}
