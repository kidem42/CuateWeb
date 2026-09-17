import { Navigate, useParams } from 'react-router-dom';
import { Spinner } from '@librechat/client';
import { hermesConversationId } from 'librechat-data-provider';
import { useAuthContext, useLocalize } from '~/hooks';
import { useHermesConnections } from '~/data-provider/Hermes';
export default function LegacyHermesRoute() {
  const { connectionId, sessionId } = useParams();
  const { user } = useAuthContext();
  const localize = useLocalize();
  const connections = useHermesConnections(user?.id);
  if (connections.isLoading) return <Spinner />;
  const connection = connectionId
    ? connections.data?.find((item) => item.id === connectionId)
    : connections.data?.[0];
  if (!connection) return <p role="alert">{localize('com_ui_hermes_request_error')}</p>;
  return (
    <Navigate
      replace
      to={
        sessionId
          ? `/c/${hermesConversationId({
              connectionId: connection.id,
              scope: connection.scope,
              sessionId,
            })}`
          : `/c/new?hermes=${encodeURIComponent(connection.id)}`
      }
    />
  );
}
