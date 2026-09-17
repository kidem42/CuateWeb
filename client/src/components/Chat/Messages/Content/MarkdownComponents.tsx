import type { Element } from 'hast';
import { useChatBackend } from '~/Providers/ChatBackendContext';
import { Artifact } from '~/components/Artifacts/Artifact';
import FilePreviewDialog from './FilePreviewDialog';
import React, { memo, useMemo, useRef, useEffect, useState } from 'react';
import { useRecoilValue } from 'recoil';
import { Button, useToastContext } from '@librechat/client';
import { FileText } from 'lucide-react';
import { PermissionTypes, Permissions, apiBaseUrl } from 'librechat-data-provider';
import {
  extractContent,
  handleDoubleClick,
  triggerDownload,
  resolveInlineMedia,
  toAbsoluteFilePath,
} from '~/utils';
import Mermaid, { MermaidErrorBoundary } from '~/components/Messages/Content/Mermaid';
import { useCodeBlockContext, useMediaContext } from '~/Providers';
import CodeBlock from '~/components/Messages/Content/CodeBlock';
import useHasAccess from '~/hooks/Roles/useHasAccess';
import { useFileDownload } from '~/data-provider';
import { useLocalize } from '~/hooks';
import store from '~/store';

type TCodeProps = {
  node?: Element;
  inline?: boolean;
  className?: string;
  children: React.ReactNode;
};

const isSingleLineCode = (children: React.ReactNode): boolean => {
  if (typeof children === 'string') {
    return !children.includes('\n');
  }
  if (Array.isArray(children)) {
    return children.every((child) => typeof child === 'string' && !child.includes('\n'));
  }
  return false;
};

export const code: React.ElementType = memo(function MarkdownCode({
  className,
  children,
  node,
}: TCodeProps) {
  const backend = useChatBackend();
  const canRunCode = useHasAccess({
    permissionType: PermissionTypes.RUN_CODE,
    permission: Permissions.USE,
  });
  const match = /language-(\w+)/.exec(className ?? '');
  const lang = match && match[1];
  const isMath = lang === 'math';
  const isMermaid = lang === 'mermaid';
  const isSingleLine = isSingleLineCode(children);
  const isDocument =
    backend?.documentFences &&
    (['html', 'markdown', 'md'].includes(lang || '') || node?.properties?.dataNativeHtml === true);

  const { getNextIndex, getNextMermaidIndex, resetCounter } = useCodeBlockContext();
  const blockIndex = useRef(
    getNextIndex(isMath || isMermaid || (isSingleLine && !isDocument)),
  ).current;
  /* Mermaid fences do not consume a code-block index, so every one of them in a
   * message would otherwise share `blockIndex` and collapse onto a single
   * artifact id. They carry their own sequence instead. */
  const mermaidIndex = useRef(isMermaid ? getNextMermaidIndex() : -1).current;

  useEffect(() => {
    resetCounter();
  }, [children, resetCounter]);

  if (isMath) {
    return <>{children}</>;
  } else if (isMermaid) {
    const content = typeof children === 'string' ? children : String(children);
    return (
      <MermaidErrorBoundary code={content}>
        <Mermaid id={`mermaid-${mermaidIndex}`}>{content}</Mermaid>
      </MermaidErrorBoundary>
    );
  } else if (isDocument) {
    const documentText = extractContent(children);
    const title =
      lang === 'markdown' || lang === 'md'
        ? (documentText.match(/^#\s+(.+)/)?.[1] ?? 'document.md')
        : (documentText.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] ?? 'document.html');
    return (
      <Artifact
        node={undefined}
        identifier={`cuate-document-${blockIndex}`}
        title={title}
        type={lang === 'markdown' || lang === 'md' ? 'text/markdown' : 'text/html'}
      >
        {children}
      </Artifact>
    );
  } else if (isSingleLine) {
    return (
      <code onDoubleClick={handleDoubleClick} className={className}>
        {children}
      </code>
    );
  } else {
    return (
      <CodeBlock
        lang={lang ?? 'text'}
        codeChildren={children}
        blockIndex={blockIndex}
        allowExecution={!backend && canRunCode}
      />
    );
  }
});
code.displayName = 'MarkdownCode';

export const codeNoExecution: React.ElementType = memo(function MarkdownCodeNoExecution({
  className,
  children,
}: TCodeProps) {
  const match = /language-(\w+)/.exec(className ?? '');
  const lang = match && match[1];

  if (lang === 'math') {
    return children;
  } else if (lang === 'mermaid') {
    const content = typeof children === 'string' ? children : String(children);
    return <Mermaid>{content}</Mermaid>;
  } else if (isSingleLineCode(children)) {
    return (
      <code onDoubleClick={handleDoubleClick} className={className}>
        {children}
      </code>
    );
  } else {
    return <CodeBlock lang={lang ?? 'text'} codeChildren={children} allowExecution={false} />;
  }
});
codeNoExecution.displayName = 'MarkdownCodeNoExecution';

type TAnchorProps = {
  href: string;
  children: React.ReactNode;
};

export const a: React.ElementType = memo(function MarkdownAnchor({ href, children }: TAnchorProps) {
  const backend = useChatBackend();
  const [previewOpen, setPreviewOpen] = useState(false);
  let path: string | undefined;
  if (href.startsWith('sandbox:/')) path = href.slice('sandbox:'.length);
  else if ((href.startsWith('/') && !href.startsWith('//')) || href.startsWith('~/')) path = href;
  const nativePreview = backend?.files?.preview;
  const nativeDownload = backend?.files?.download;
  const fileLoader = useMemo(
    () =>
      path && nativePreview && nativeDownload
        ? {
            preview: () => nativePreview(path),
            download: () => nativeDownload(path),
          }
        : undefined,
    [path, nativePreview, nativeDownload],
  );
  const user = useRecoilValue(store.user);
  const { showToast } = useToastContext();
  const localize = useLocalize();

  const {
    file_id = '',
    filename = '',
    filepath,
  } = useMemo(() => {
    const pattern = new RegExp(`(?:files|outputs)/${user?.id}/([^\\s]+)`);
    const match = href.match(pattern);
    if (match && match[0]) {
      const path = match[0];
      const parts = path.split('/');
      const name = parts.pop();
      const file_id = parts.pop();
      return { file_id, filename: name, filepath: path };
    }
    return { file_id: '', filename: '', filepath: '' };
  }, [user?.id, href]);

  const { refetch: downloadFile } = useFileDownload(user?.id ?? '', file_id, { direct: false });
  const props: { target?: string; onClick?: React.MouseEventHandler } = { target: '_blank' };

  if (fileLoader && path)
    return (
      <>
        <Button asChild variant="secondary" size="sm" className="max-w-full !no-underline">
          <a
            href={href}
            title={`${localize('com_ui_preview')}: ${path}`}
            onClick={(event) => {
              event.preventDefault();
              setPreviewOpen(true);
            }}
          >
            <FileText className="size-4 shrink-0" aria-hidden="true" />
            <span className="truncate">{children}</span>
          </a>
        </Button>
        <FilePreviewDialog
          open={previewOpen}
          onOpenChange={setPreviewOpen}
          fileName={path.split('/').pop() || 'file'}
          fileLoader={fileLoader}
        />
      </>
    );

  if (!file_id || !filename) {
    return (
      <a href={href} {...props}>
        {children}
      </a>
    );
  }

  const handleDownload = async (event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    try {
      const stream = await downloadFile();
      if (stream.data == null || stream.data === '') {
        console.error('Error downloading file: No data found');
        showToast({
          status: 'error',
          message: localize('com_ui_download_error'),
        });
        return;
      }
      triggerDownload(stream.data, filename);
    } catch (error) {
      console.error('Error downloading file:', error);
    }
  };

  props.onClick = handleDownload;
  props.target = '_blank';

  const domainServerBaseUrl = `${apiBaseUrl()}/api`;

  return (
    <a
      href={
        filepath?.startsWith('files/')
          ? `${domainServerBaseUrl}/${filepath}`
          : `${domainServerBaseUrl}/files/${filepath}`
      }
      {...props}
    >
      {children}
    </a>
  );
});
a.displayName = 'MarkdownAnchor';

type TParagraphProps = {
  children: React.ReactNode;
};

export const p: React.ElementType = memo(function MarkdownParagraph({ children }: TParagraphProps) {
  return <p className="mb-2 whitespace-pre-wrap">{children}</p>;
});
p.displayName = 'MarkdownParagraph';

type TTableProps = {
  children: React.ReactNode;
};

export const table: React.ElementType = memo(function MarkdownTable({ children }: TTableProps) {
  return (
    <div className="markdown-table-wrapper w-full max-w-full">
      <table>{children}</table>
    </div>
  );
});
table.displayName = 'MarkdownTable';

type TImageProps = {
  src?: string;
  alt?: string;
  title?: string;
  className?: string;
  style?: React.CSSProperties;
};

export const img: React.ElementType = memo(function MarkdownImage({
  src,
  alt,
  title,
  className,
  style,
}: TImageProps) {
  const backend = useChatBackend();
  const localize = useLocalize();
  const [open, setOpen] = useState(false);
  const [imageURL, setImageURL] = useState<string>();
  let nativePath: string | undefined;
  if (src?.startsWith('sandbox:/')) nativePath = src.slice('sandbox:'.length);
  else if (src && ((src.startsWith('/') && !src.startsWith('//')) || src.startsWith('~/')))
    nativePath = src;
  const preview = backend?.files?.preview;
  const download = backend?.files?.download;
  const loader = useMemo(
    () =>
      nativePath && preview && download
        ? {
            preview: () => preview(nativePath),
            download: () => download(nativePath),
          }
        : undefined,
    [nativePath, preview, download],
  );
  useEffect(() => {
    let cancelled = false;
    let url: string | undefined;
    setImageURL(undefined);
    if (loader)
      void loader
        .preview()
        .then((blob) => {
          if (cancelled || !blob.type.startsWith('image/')) return;
          url = URL.createObjectURL(blob);
          setImageURL(url);
        })
        .catch(() => {});
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [loader]);
  const baseURL = apiBaseUrl();
  /** A model writing `![DTI](5_dti.png)` is naming a file its run produced,
   *  not a path the browser can fetch. Resolving the reference against the
   *  turn's attachments is what turns those into the chart instead of a
   *  broken-image glyph; an unmatched source keeps its original behavior. */
  const { attachmentsByName } = useMediaContext();

  const fixedSrc = useMemo(() => {
    if (!src) return src;
    const resolved = resolveInlineMedia(src, attachmentsByName)?.filepath ?? src;
    return toAbsoluteFilePath(resolved, baseURL);
  }, [src, baseURL, attachmentsByName]);

  if (loader && nativePath)
    return (
      <>
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={`${localize('com_ui_preview')}: ${alt || nativePath.split('/').pop()}`}
        >
          <img src={imageURL} alt={alt} title={title} className={className} style={style} />
        </button>
        <FilePreviewDialog
          open={open}
          onOpenChange={setOpen}
          fileName={nativePath.split('/').pop() || 'image'}
          fileLoader={loader}
        />
      </>
    );
  return <img src={fixedSrc} alt={alt} title={title} className={className} style={style} />;
});
img.displayName = 'MarkdownImage';
