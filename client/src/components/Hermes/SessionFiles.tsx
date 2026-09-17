import { useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Folder, RefreshCw } from 'lucide-react';
import {
  Button,
  TooltipAnchor,
  OGDialog,
  OGDialogContent,
  OGDialogTitle,
  OGDialogDescription,
} from '@librechat/client';
import type { ChatBackend } from '~/Providers/ChatBackendContext';
import type { SessionFile } from './files';
import FilePreviewDialog from '~/components/Chat/Messages/Content/FilePreviewDialog';
import { useChatBackend } from '~/Providers/ChatBackendContext';
import { useLocalize } from '~/hooks';
import { triggerDownload } from '~/utils';
import { fileParent } from './files';

type FileAccess = NonNullable<ChatBackend['files']>;
function FileRow({
  file,
  access,
  identity,
}: {
  file: SessionFile;
  access: FileAccess;
  identity: string;
}) {
  const localize = useLocalize();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const pending = useRef(false);
  const parent = fileParent(file.path);
  const name = file.path.slice(file.path.lastIndexOf('/') + 1);
  const listing = useQuery({
    queryKey: ['hermes-session-files', identity, parent],
    queryFn: () => access.list!(parent),
    enabled: !!access.list,
    staleTime: 15000,
    retry: false,
  });
  const entry = listing.data?.find((item) => item.name === name);
  const missing = listing.isSuccess && !entry;
  const { preview: previewFile, download: downloadFile } = access;
  const loader = useMemo(
    () => ({
      preview: () => previewFile(file.path),
      download: () => downloadFile(file.path),
    }),
    [previewFile, downloadFile, file.path],
  );
  const download = async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setFailed(false);
    try {
      const blob = await access.download(file.path);
      triggerDownload(URL.createObjectURL(blob), name);
    } catch {
      setFailed(true);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  if (entry?.is_directory) return null;
  return (
    <li className="flex items-start gap-2 border-b border-border-light py-2">
      <div className="min-w-0 flex-1">
        <Button
          variant="ghost"
          className="max-w-full justify-start"
          disabled={missing}
          onClick={() => setOpen(true)}
          title={localize('com_ui_preview')}
        >
          <span className="truncate">{name}</span>
        </Button>
        <p className="break-all text-xs text-text-secondary">{file.path}</p>
        {missing && (
          <p role="status" className="text-sm text-text-secondary">
            {localize('com_ui_session_file_missing')}
          </p>
        )}
        {listing.isError && (
          <p role="status" className="text-sm text-text-secondary">
            {localize('com_ui_session_file_unchecked')}
          </p>
        )}
        {failed && (
          <p role="alert" className="text-sm text-text-secondary">
            {localize('com_ui_download_error')}
          </p>
        )}
      </div>
      <Button
        variant="outline"
        size="icon"
        disabled={missing || busy}
        onClick={() => void download()}
        aria-label={`${localize('com_ui_download')} ${name}`}
        title={localize('com_ui_download')}
      >
        <Download className="icon-md" aria-hidden="true" />
      </Button>
      <FilePreviewDialog open={open} onOpenChange={setOpen} fileName={name} fileLoader={loader} />
    </li>
  );
}

export default function SessionFiles() {
  const backend = useChatBackend();
  const localize = useLocalize();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  if (!backend?.files) return null;
  const files = backend.sessionFiles ?? [];
  const title = localize('com_ui_session_files');
  return (
    <>
      <TooltipAnchor
        description={title}
        render={
          <Button variant="outline" size="icon" aria-label={title} onClick={() => setOpen(true)}>
            <Folder className="icon-md" aria-hidden="true" />
          </Button>
        }
      />
      <OGDialog open={open} onOpenChange={setOpen}>
        <OGDialogContent className="max-h-[80vh] overflow-y-auto">
          <OGDialogTitle>{title}</OGDialogTitle>
          <OGDialogDescription>{localize('com_ui_session_files_description')}</OGDialogDescription>
          <Button
            variant="outline"
            onClick={() =>
              void queryClient.invalidateQueries({
                queryKey: ['hermes-session-files', backend.identity],
              })
            }
          >
            <RefreshCw className="icon-sm mr-2" aria-hidden="true" />
            {localize('com_ui_refresh')}
          </Button>
          {!files.length && <p role="status">{localize('com_ui_session_files_empty')}</p>}
          {open &&
            (['assistant', 'user'] as const).map((source) => {
              const items = files.filter((file) => file.source === source);
              if (!items.length) return null;
              return (
                <section key={source}>
                  <h3 className="font-semibold">
                    {localize(
                      source === 'user'
                        ? 'com_ui_session_files_user'
                        : 'com_ui_session_files_agent',
                    )}
                  </h3>
                  <ul>
                    {items.map((file) => (
                      <FileRow
                        key={file.path}
                        file={file}
                        access={backend.files!}
                        identity={backend.identity}
                      />
                    ))}
                  </ul>
                </section>
              );
            })}
        </OGDialogContent>
      </OGDialog>
    </>
  );
}
