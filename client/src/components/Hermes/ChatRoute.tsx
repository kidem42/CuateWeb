import { useParams, useSearchParams } from 'react-router-dom';
import { Spinner } from '@librechat/client';
import { parseHermesConversationId } from 'librechat-data-provider';
import { useAuthContext, useLocalize } from '~/hooks';
import { useHermesConnections } from '~/data-provider/Hermes';
import NativeChat from './NativeChat';

export default function HermesChatRoute({ fallback }: { fallback: React.ReactNode }) {
  const { user } = useAuthContext();
  const { conversationId } = useParams();
  const [search] = useSearchParams();
  const localize = useLocalize();
  const connections = useHermesConnections(user?.id);
  const identity = parseHermesConversationId(conversationId);
  if (connections.isLoading && (identity || conversationId === 'new')) return <Spinner />;
  let connection;
  if (identity)
    connection = connections.data?.find(
      (item) => item.id === identity.connectionId && item.scope === identity.scope,
    );
  else if (conversationId === 'new')
    connection =
      connections.data?.find((item) => item.id === search.get('hermes')) ?? connections.data?.[0];
  if (identity && (!connection || !user))
    return <p role="alert">{localize('com_ui_hermes_request_error')}</p>;
  if (!connection || !user) return <>{fallback}</>;
  return (
    <NativeChat
      key={`${user.id}:${conversationId}:${connection.id}:${connection.scope}`}
      userId={user.id}
      connection={connection}
      sessionId={identity?.sessionId}
    />
  );
}
