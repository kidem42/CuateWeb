import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import type { ComponentProps } from 'react';
import { useChatBackend } from '~/Providers/ChatBackendContext';

/** Retain native file references for the authorized file loader; keep unsafe schemes blocked. */
const nativeURL = (url: string) => (/^sandbox:\/(?!\/)/.test(url) ? url : defaultUrlTransform(url));

export default function MarkdownRenderer(props: ComponentProps<typeof ReactMarkdown>) {
  const backend = useChatBackend();
  return (
    <ReactMarkdown {...props} urlTransform={backend?.files ? nativeURL : props.urlTransform} />
  );
}
