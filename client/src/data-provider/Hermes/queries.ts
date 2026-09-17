import {
  dataService,
  MutationKeys,
  QueryKeys,
  hermesNextSessionOffset,
} from 'librechat-data-provider';
import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import type { HermesAccess, HermesRequest, HermesSessionPage } from 'librechat-data-provider';

export const useHermesConnections = (userId?: string) =>
  useQuery([QueryKeys.hermesConnections, userId], dataService.getHermesConnections, {
    enabled: Boolean(userId),
    retry: false,
    staleTime: 60_000,
  });
export const useHermesQuery = <T>(
  userId: string,
  connection: HermesAccess,
  input: HermesRequest,
  enabled = true,
  poll = false,
) =>
  useQuery<T>(
    [QueryKeys.hermes, userId, connection.id, connection.scope, input],
    () => dataService.hermesRequest<T>(connection.id, input),
    { enabled, retry: false, refetchInterval: poll ? connection.pollIntervalMs : false },
  );
export const useHermesSessions = (userId: string, connection: HermesAccess) =>
  useInfiniteQuery(
    [QueryKeys.hermes, userId, connection.id, connection.scope, 'sessions'],
    ({ pageParam = 0 }) =>
      dataService.hermesRequest<HermesSessionPage>(connection.id, {
        operation: 'sessions',
        offset: pageParam,
      }),
    {
      retry: false,
      refetchInterval: connection.pollIntervalMs,
      getNextPageParam: hermesNextSessionOffset,
    },
  );
export const useHermesMutation = <T>() =>
  useMutation(
    [MutationKeys.hermes],
    ({ connection, input }: { connection: string; input: HermesRequest }) =>
      dataService.hermesRequest<T>(connection, input),
  );
