import { createContext, useContext, useEffect, useMemo, useRef } from 'react';
import { useAtomValue, useStore } from 'jotai';
import { useQueryClient } from '@tanstack/react-query';
import { dataService, QueryKeys } from 'librechat-data-provider';
import { useHermesConnections } from '~/data-provider/Hermes';
import { useAuthContext } from '~/hooks';
import { hermesLiveAtom, hermesSessionsAtom } from './state';
import { HermesEngine } from './engine';

const Context = createContext<HermesEngine | null>(null);
export const useHermesEngine = () => {
  const engine = useContext(Context);
  if (!engine) {
    throw new Error('Hermes runtime missing');
  }
  return engine;
};
export default function HermesRuntime({ children }: { children: React.ReactNode }) {
  const { user, token } = useAuthContext();
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const store = useStore();
  const queryClient = useQueryClient();
  const connections = useHermesConnections(user?.id);
  const connectionsRef = useRef(connections.data);
  connectionsRef.current = connections.data;
  const states = useAtomValue(hermesSessionsAtom);
  const stateRef = useRef(states);
  stateRef.current = states;
  const engine = useMemo(
    () =>
      new HermesEngine({
        get: (key) => {
          const state = store.get(hermesSessionsAtom)[key];
          return state?.binding?.userId === user?.id ? state : {};
        },
        patch: (key, value) =>
          store.set(hermesSessionsAtom, (all) =>
            all[key]?.deleted ? all : { ...all, [key]: { ...all[key], ...value } },
          ),
        live: (key, value) =>
          store.set(hermesLiveAtom, (all) =>
            store.get(hermesSessionsAtom)[key]?.deleted
              ? all
              : { ...all, [key]: { ...all[key], ...value } },
          ),
        request: dataService.hermesRequest,
        answer: (connection, input) => {
          if (!tokenRef.current) {
            throw new Error('authentication_required');
          }
          const access = connectionsRef.current?.find(
            (item) => item.id === connection && item.scope === input.scope,
          );
          if (!access) {
            throw new Error('connection_changed');
          }
          // The adapter performs one status preflight and one decision request.
          return dataService.answerHermesApproval(
            connection,
            input,
            tokenRef.current,
            AbortSignal.timeout(2 * access.requestTimeoutMs),
          );
        },
        stream: (connection, input, signal, frame) => {
          if (!tokenRef.current) {
            throw new Error('authentication_required');
          }
          return dataService.streamHermes(connection, input, tokenRef.current, signal, frame);
        },
        refresh: (binding) => {
          void queryClient.invalidateQueries([
            QueryKeys.hermes,
            binding.userId,
            binding.connectionId,
          ]);
        },
        now: Date.now,
        exclusive: async (key, action) => {
          if (!navigator.locks) {
            return action();
          }
          await navigator.locks.request(
            `cuateweb.continue:${key}`,
            { ifAvailable: true },
            async (lock) => {
              if (!lock) {
                return;
              }
              // Re-read the persisted decision after taking the same-browser lock.
              const raw = localStorage.getItem('cuateweb.hermes.sessions.v2');
              if (raw) {
                try {
                  const latest = JSON.parse(raw) as Record<string, import('./state').SessionState>;
                  store.set(hermesSessionsAtom, latest);
                } catch {
                  return;
                }
              }
              await action();
            },
          );
        },
      }),
    [store, queryClient, user?.id],
  );
  useEffect(() => {
    for (const [key, state] of Object.entries(states)) {
      if (state.deleted) engine.detach(key);
    }
  }, [states, engine]);
  useEffect(() => {
    engine.activate();
    return () => {
      engine.dispose();
      store.set(hermesLiveAtom, {});
    };
  }, [engine, store]);
  useEffect(() => {
    let cancelled = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    for (const connection of connections.data ?? []) {
      const poll = async () => {
        if (cancelled) {
          return;
        }
        await Promise.all(
          Object.entries(stateRef.current)
            .filter(
              ([, state]) =>
                !state.deleted &&
                state.binding?.userId === user?.id &&
                state.binding?.connectionId === connection.id &&
                state.binding?.scope === connection.scope,
            )
            .map(([key]) => engine.tick(key, connection)),
        );
        if (!cancelled) {
          const timer = setTimeout(() => {
            timers.delete(timer);
            void poll();
          }, connection.pollIntervalMs);
          timers.add(timer);
        }
      };
      void poll();
    }
    return () => {
      cancelled = true;
      for (const timer of timers) {
        clearTimeout(timer);
      }
    };
  }, [connections.data, engine, user?.id]);
  return <Context.Provider value={engine}>{children}</Context.Provider>;
}
