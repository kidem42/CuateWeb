import { Navigate } from 'react-router-dom';
import { Spinner } from '@librechat/client';
import { useActiveHermesConnection } from '~/data-provider/Hermes/useSkillCatalog';

export default function ProjectAccess({ children }: { children: React.ReactNode }) {
  const { connection, connections } = useActiveHermesConnection();
  if (connections.isLoading) return <Spinner />;
  if (connection) return <Navigate to="/c/new" replace />;
  return <>{children}</>;
}
