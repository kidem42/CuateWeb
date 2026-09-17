import { useActiveHermesConnection } from '~/data-provider/Hermes/useSkillCatalog';
import { SystemRoles } from 'librechat-data-provider';
import { AdminSettings } from '~/components/Skills/buttons';
import SkillsSidePanel from './SkillsSidePanel';
import { PanelFooter } from '~/components/ui';
import { useAuthContext } from '~/hooks';

export default function SkillsAccordion() {
  const { user } = useAuthContext();
  const { connection } = useActiveHermesConnection();
  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <SkillsSidePanel className="min-h-0 flex-1 border-r-0" />
      {!connection && user?.role === SystemRoles.ADMIN && (
        <PanelFooter>
          <AdminSettings />
        </PanelFooter>
      )}
    </div>
  );
}
