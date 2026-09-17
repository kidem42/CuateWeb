import { useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import {
  dataService,
  QueryKeys,
  hermesNextSessionOffset,
  hermesSessionView,
} from 'librechat-data-provider';
import type { HermesSessionPage } from 'librechat-data-provider';
import { useHermesConnections } from './queries';

/** Supplies the shared sidebar; the Gateway remains the session catalog. */
export function useHermesConversationRows(userId?: string) {
  const connections = useHermesConnections(userId);
  const [extraPages, setExtraPages] = useState<Record<string, number[]>>({});
  const sources = (connections.data ?? []).flatMap((connection) => {
    const key = JSON.stringify([userId, connection.id, connection.scope]);
    return [0, ...(extraPages[key] ?? [])].map((offset) => ({ connection, key, offset }));
  });
  const queries = useQueries({
    queries: sources.map(({ connection, offset }) => ({
      queryKey: [QueryKeys.hermes, userId, connection.id, connection.scope, 'sidebar', offset],
      queryFn: () =>
        dataService.hermesRequest<HermesSessionPage>(connection.id, {
          operation: 'sessions',
          offset,
          scope: connection.scope,
        }),
      enabled: !!userId,
      retry: false,
      refetchInterval: connection.pollIntervalMs,
    })),
  });
  const nextPages = sources.flatMap((source, index) => {
    const data = queries[index].data;
    if (!data) return [];
    const offset = hermesNextSessionOffset(data);
    return offset != null && !sources.some((s) => s.key === source.key && s.offset === offset)
      ? [{ key: source.key, offset }]
      : [];
  });
  const rows = new Map<string, ReturnType<typeof hermesSessionView>>();
  queries.forEach((query, index) =>
    query.data?.data.forEach((session) => {
      const row = hermesSessionView(sources[index].connection, session);
      if (row.conversationId) rows.set(row.conversationId, row);
    }),
  );
  return {
    conversations: [...rows.values()],
    hasNextPage: nextPages.length > 0,
    isLoading: connections.isLoading || queries.some((q) => q.isLoading),
    isError: connections.isError || queries.some((q) => q.isError),
    loadMore: () =>
      setExtraPages((prev) => {
        const next = { ...prev };
        for (const { key, offset } of nextPages)
          next[key] = [...new Set([...(next[key] ?? []), offset])];
        return next;
      }),
    retry: () => {
      void connections.refetch();
      queries.forEach((q) => {
        void q.refetch();
      });
    },
  };
}
