import { atom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';
import type { HermesApproval, HermesUsage } from 'librechat-data-provider';

export type HermesBinding = {
  userId: string;
  connectionId: string;
  scope: string;
  sessionId: string;
};
export const hermesSessionKey = (binding: HermesBinding) =>
  JSON.stringify([binding.userId, binding.connectionId, binding.scope, binding.sessionId]);
export type SessionState = {
  deleted?: boolean;
  briefed?: boolean;
  binding?: HermesBinding;
  runId?: string;
  status?: string;
  usage?: HermesUsage;
  provider?: string;
  model?: string;
  pending?: string;
  deliveredRun?: string;
  followupBlocked?: boolean;
  automatic?: boolean;
  deferred?: boolean;
  handled?: number[];
  delivery?: number[];
  approvals?: Record<string, HermesApproval>;
  approvalPhases?: Record<string, 'sending' | 'uncertain' | 'accepted'>;
  externalBusy?: boolean;
  held?: string[];
  stoppingAt?: number;
  failedAt?: number;
  failureReason?: 'model_unavailable' | 'run_failed';
};
export const hermesSessionsAtom = atomWithStorage<Record<string, SessionState>>(
  'cuateweb.hermes.sessions.v2',
  {},
  undefined,
  { getOnInit: true },
);
export type HermesLive = {
  text?: string;
  sent?: string;
  tool?: string;
  error?: boolean;
  streaming?: boolean;
};
export const hermesLiveAtom = atom<Record<string, HermesLive>>({});

export const hermesModelPreferenceKey = (binding: HermesBinding) =>
  JSON.stringify([binding.userId, binding.connectionId, binding.scope]);
export const hermesModelPreferencesAtom = atomWithStorage<
  Record<string, { provider: string; model: string }>
>('cuateweb.hermes.models.v1', {}, undefined, { getOnInit: true });
