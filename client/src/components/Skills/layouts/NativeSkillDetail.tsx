import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, Spinner } from '@librechat/client';
import { dataService, QueryKeys } from 'librechat-data-provider';
import { useActiveHermesConnection } from '~/data-provider/Hermes/useSkillCatalog';
import MarkdownLite from '~/components/Chat/Messages/Content/MarkdownLite';
import { useLocalize } from '~/hooks';
import SkillState from '../display/SkillState';
import ViewToggle from '../display/ViewToggle';
import { parseFrontmatter } from '../utils';

export default function NativeSkillDetail({
  name,
  description,
}: {
  name: string;
  description?: string;
}) {
  const { user, connection } = useActiveHermesConnection();
  const localize = useLocalize();
  const [viewMode, setViewMode] = useState<'rendered' | 'source'>('rendered');
  const input = { operation: 'skills' as const, name, scope: connection?.scope };
  const query = useQuery({
    queryKey: [QueryKeys.hermes, user?.id, connection?.id, connection?.scope, input],
    queryFn: async () => {
      const result = await dataService.hermesRequest<{ name: string; content: string }>(
        connection!.id,
        input,
      );
      if (result.name !== name || typeof result.content !== 'string')
        throw new Error('invalid_skill_content');
      return result.content;
    },
    enabled: !!user && !!connection,
    retry: false,
    staleTime: 60000,
  });
  const body = useMemo(
    () => parseFrontmatter(query.data ?? '', new Set(['name', 'description'])).body,
    [query.data],
  );
  if (query.isLoading) return <Spinner aria-label={localize('com_ui_loading')} />;
  if (query.isError)
    return (
      <div className="flex flex-col items-center gap-3">
        <SkillState
          variant="error"
          title={localize('com_ui_skills_load_error')}
          description={name}
        />
        <Button variant="outline" onClick={() => void query.refetch()}>
          {localize('com_ui_retry')}
        </Button>
      </div>
    );
  return (
    <article className="flex h-full min-w-0 flex-col gap-4 overflow-y-auto p-5" aria-label={name}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="break-words text-xl font-bold">{name}</h2>
          {description && <p className="text-text-secondary">{description}</p>}
        </div>
        <ViewToggle viewMode={viewMode} setViewMode={setViewMode} />
      </div>
      {viewMode === 'source' ? (
        <pre className="whitespace-pre-wrap break-words font-mono text-sm">{query.data}</pre>
      ) : (
        <div className="markdown prose dark:prose-invert max-w-none">
          <MarkdownLite content={body} codeExecution={false} />
        </div>
      )}
    </article>
  );
}
