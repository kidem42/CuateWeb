import React from 'react';
import { render, screen } from 'test/layout-test-utils';
import { ChatBackendContext } from '~/Providers/ChatBackendContext';
import type { ChatBackend } from '~/Providers/ChatBackendContext';
import { getRemarkPlugins, getRehypePlugins, getMarkdownComponents } from '../markdownConfig';
import MarkdownBlocks from '../MarkdownBlocks';

jest.mock('~/components/Artifacts/Artifact', () => ({
  ...jest.requireActual('~/components/Artifacts/Artifact'),
  Artifact: ({
    identifier,
    title,
    type,
    children,
  }: {
    identifier: string;
    title: string;
    type: string;
    children: React.ReactNode;
  }) => (
    <div data-testid="document" data-id={identifier} data-type={type} data-title={title}>
      {children}
    </div>
  ),
}));
const show = (content: string) =>
  render(
    <ChatBackendContext.Provider value={{ documentFences: true } as ChatBackend}>
      <MarkdownBlocks
        content={content}
        remarkPlugins={getRemarkPlugins()}
        rehypePlugins={getRehypePlugins()}
        components={getMarkdownComponents()}
      />
    </ChatBackendContext.Provider>,
  );
it('routes HTML and Markdown fences through stock artifacts with distinct stable identities', () => {
  show(
    '```html\n<!doctype html><title>Example</title><button>Hi</button>\n```\n\n```markdown\n# Report\nText\n```',
  );
  const docs = screen.getAllByTestId('document');
  expect(docs.map((d) => d.dataset.type)).toEqual(['text/html', 'text/markdown']);
  expect(docs.map((d) => d.dataset.title)).toEqual(['Example', 'Report']);
  expect(new Set(docs.map((d) => d.dataset.id)).size).toBe(2);
  expect(screen.queryByRole('button', { name: 'Hi' })).toBeNull();
});
it('keeps ordinary formatted replies in the transcript', () => {
  show('# Heading\n\n**Bold** and `value`\n\n- First\n- Second');
  expect(screen.getByRole('heading', { name: 'Heading' })).toBeInTheDocument();
  expect(screen.getAllByRole('listitem')).toHaveLength(2);
  expect(screen.queryByTestId('document')).toBeNull();
});

it('renders the desktop Markdown vocabulary with the shared pipeline', () => {
  const { container } = show(
    '## Formats\n\n> Quote\n\n- [x] Done\n- [ ] Pending\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n---\n\n[Link](https://example.com) and *emphasis* and ~~removed~~.\n\n$$x^2$$',
  );
  expect(screen.getByRole('table')).toBeInTheDocument();
  expect(screen.getAllByRole('checkbox')).toHaveLength(2);
  expect(screen.getByRole('link', { name: 'Link' })).toHaveAttribute('href', 'https://example.com');
  expect(container.querySelector('blockquote')).not.toBeNull();
  expect(container.querySelector('em')).not.toBeNull();
  expect(container.querySelector('del')).not.toBeNull();
  expect(container.querySelector('hr')).not.toBeNull();
  expect(container.querySelector('.katex')).not.toBeNull();
});

it('preserves authorized native sandbox file links while blocking executable URL schemes', () => {
  render(
    <ChatBackendContext.Provider
      value={{
        identity: 'fixture',
        label: 'Hermes',
        send: async () => {},
        steer: async () => {},
        canSendDuringRun: false,
        submitApproval: async () => {},
        files: { preview: async () => new Blob(), download: async () => new Blob() },
      }}
    >
      <MarkdownBlocks
        content="[File](sandbox:/tmp/report.md) [Unsafe](javascript:alert)"
        remarkPlugins={getRemarkPlugins()}
        rehypePlugins={getRehypePlugins()}
        components={getMarkdownComponents()}
      />
    </ChatBackendContext.Provider>,
  );
  expect(screen.getByRole('link', { name: 'File' })).toHaveAttribute(
    'href',
    'sandbox:/tmp/report.md',
  );
  expect(screen.getByText('Unsafe')).not.toHaveAttribute('href', 'javascript:alert');
});

it('supports the native md alias and unlabelled HTML documents', () => {
  show('```md\n# Alias\nText\n```\n\n```\n<!doctype html><title>Unlabelled</title>\n```');
  expect(screen.getAllByTestId('document').map((node) => node.dataset.type)).toEqual([
    'text/markdown',
    'text/html',
  ]);
});
