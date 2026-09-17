import { sessionFiles } from '~/components/Hermes/files';
import { memo, useMemo, ReactElement } from 'react';
import { useRecoilValue } from 'recoil';
import MarkdownLite from '~/components/Chat/Messages/Content/MarkdownLite';
import useSmoothStreaming from '~/hooks/Messages/useSmoothStreaming';
import Markdown from '~/components/Chat/Messages/Content/Markdown';
import CollapsibleText from './CollapsibleText';
import { useMessageContext } from '~/Providers';
import { cn } from '~/utils';
import store from '~/store';
import { hermesNoticeDisplay, hermesSplitAttachments } from 'librechat-data-provider';
import { useChatBackend } from '~/Providers/ChatBackendContext';
import Wakeup from '../Wakeup';
import { a as FileAnchor } from '../MarkdownComponents';

type TextPartProps = {
  text: string;
  showCursor: boolean;
  isCreatedByUser: boolean;
};

type ContentType =
  | ReactElement<React.ComponentProps<typeof Markdown>>
  | ReactElement<React.ComponentProps<typeof MarkdownLite>>
  | ReactElement;

const TextPart = memo(function TextPart({ text, isCreatedByUser, showCursor }: TextPartProps) {
  const { messageId } = useMessageContext();
  const native = useChatBackend()?.nativeTranscript === true;
  const notice = useMemo(
    () =>
      native && !isCreatedByUser && messageId.endsWith('.notice')
        ? hermesNoticeDisplay(text)
        : null,
    [native, isCreatedByUser, text, messageId],
  );
  const attachments = useMemo(
    () => (native && isCreatedByUser ? hermesSplitAttachments(text) : null),
    [native, isCreatedByUser, text],
  );
  const filePaths = useMemo(
    () =>
      native && !isCreatedByUser && !notice
        ? sessionFiles([{ id: 0, role: 'assistant', content: text }])
        : [],
    [native, isCreatedByUser, notice, text],
  );
  const { isSubmitting = false, isLatestMessage = false } = useMessageContext();
  const enableUserMsgMarkdown = useRecoilValue(store.enableUserMsgMarkdown);
  const collapseLongUserMessages = useRecoilValue(store.collapseLongUserMessages);
  const smoothStreaming = useSmoothStreaming();
  // The word fade itself indicates streaming, so the trailing block cursor
  // only shows when the fade is unavailable (setting off or reduced motion).
  const showCursorState = useMemo(
    () => showCursor && isSubmitting && !(smoothStreaming && !isCreatedByUser),
    [showCursor, isSubmitting, smoothStreaming, isCreatedByUser],
  );

  const content: ContentType = useMemo(() => {
    if (!isCreatedByUser) {
      return <Markdown content={text} isLatestMessage={isLatestMessage} />;
    } else if (enableUserMsgMarkdown) {
      return <MarkdownLite content={text} />;
    } else {
      return <>{text}</>;
    }
  }, [isCreatedByUser, enableUserMsgMarkdown, text, isLatestMessage]);

  if (notice) return <Wakeup display={notice} />;
  if (attachments?.paths.length)
    return (
      <>
        <CollapsibleText enabled={collapseLongUserMessages}>
          {enableUserMsgMarkdown ? (
            <MarkdownLite content={attachments.text} />
          ) : (
            <span className="whitespace-pre-wrap">{attachments.text}</span>
          )}
        </CollapsibleText>
        <div className="flex flex-wrap gap-2">
          {attachments.paths.map((path) => (
            <FileAnchor key={path} href={path}>
              {path.split('/').at(-1) || path}
            </FileAnchor>
          ))}
        </div>
      </>
    );
  return (
    <CollapsibleText enabled={isCreatedByUser && collapseLongUserMessages}>
      <div
        className={cn(
          isSubmitting ? 'submitting' : '',
          showCursorState && !!text.length ? 'result-streaming' : '',
          'markdown prose message-content dark:prose-invert light w-full break-words',
          isCreatedByUser && !enableUserMsgMarkdown && 'whitespace-pre-wrap',
          'text-text-primary',
        )}
      >
        {content}
        {filePaths.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {filePaths.map(({ path }) => (
              <FileAnchor key={path} href={path}>
                {path.split('/').at(-1) || path}
              </FileAnchor>
            ))}
          </div>
        )}
      </div>
    </CollapsibleText>
  );
});
TextPart.displayName = 'TextPart';

export default TextPart;
