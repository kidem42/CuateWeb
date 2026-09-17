import { useQuery } from '@tanstack/react-query';
import { useParams, useSearchParams } from 'react-router-dom';
import { dataService, QueryKeys, parseHermesConversationId } from 'librechat-data-provider';
import { useAuthContext } from '~/hooks/AuthContext';
import { useHermesConnections } from './queries';

export type NativeSkill = { name: string; description?: string };

export function useActiveHermesConnection() {
  const { user } = useAuthContext();
  const { conversationId } = useParams();
  const [search] = useSearchParams();
  const connections = useHermesConnections(user?.id);
  const identity = parseHermesConversationId(conversationId);
  const requested = identity?.connectionId ?? search.get('hermes');
  const connection = requested
    ? connections.data?.find(
        (item) => item.id === requested && (!identity || item.scope === identity.scope),
      )
    : connections.data?.[0];
  return { user, connection, connections };
}

export function useNativeSkillCatalog() {
  const { user, connection, connections } = useActiveHermesConnection();
  const input = { operation: 'skills' as const, scope: connection?.scope };
  const query = useQuery(
    [QueryKeys.hermes, user?.id, connection?.id, connection?.scope, input],
    () => dataService.hermesRequest<{ data: NativeSkill[] }>(connection!.id, input),
    { enabled: !!user && !!connection, retry: false, staleTime: 60_000 },
  );
  return { connection, connections, query };
}
