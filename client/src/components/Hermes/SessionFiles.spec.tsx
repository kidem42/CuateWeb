import React from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { render } from 'test/layout-test-utils';
import { ChatBackendContext } from '~/Providers/ChatBackendContext';
import type { ChatBackend } from '~/Providers/ChatBackendContext';
import { triggerDownload } from '~/utils';
import SessionFiles from './SessionFiles';

jest.mock('~/utils', () => ({ ...jest.requireActual('~/utils'), triggerDownload: jest.fn() }));
jest.mock('~/components/Chat/Messages/Content/FilePreviewDialog', () => ({
  __esModule: true,
  default: ({ open, fileName }: { open: boolean; fileName: string }) =>
    open ? <p>Preview {fileName}</p> : null,
}));
let identity = 0;
const show = (files: NonNullable<ChatBackend['files']>) =>
  render(
    <ChatBackendContext.Provider
      value={{
        identity: `user.endpoint.session-${++identity}`,
        label: 'Hermes',
        files,
        sessionFiles: [
          { path: '/tmp/report.md', source: 'assistant' },
          { path: '/tmp/removed.pdf', source: 'user' },
        ],
        send: async () => {},
        steer: async () => {},
        canSendDuringRun: false,
        submitApproval: async () => {},
      }}
    >
      <SessionFiles />
    </ChatBackendContext.Provider>,
  );
it('opens the session folder on demand and marks missing files without downloading them', async () => {
  const access = {
    list: jest.fn().mockResolvedValue([{ name: 'report.md', is_directory: false }]),
    preview: jest.fn(),
    download: jest.fn(),
  };
  show(access);
  expect(access.list).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Session files' }));
  await screen.findByText('File no longer available');
  expect(access.list).toHaveBeenCalledTimes(1);
  expect(access.list).toHaveBeenCalledWith('/tmp');
  expect(screen.getByRole('button', { name: 'Download removed.pdf' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'report.md' }));
  expect(screen.getByText('Preview report.md')).toBeVisible();
  expect(access.download).not.toHaveBeenCalled();
});
it('downloads original bytes only after an explicit click', async () => {
  const blob = new Blob(['original bytes']);
  const original = URL.createObjectURL;
  URL.createObjectURL = jest.fn(() => 'blob:fixture');
  try {
    const access = { preview: jest.fn(), download: jest.fn().mockResolvedValue(blob) };
    show(access);
    fireEvent.click(screen.getByRole('button', { name: 'Session files' }));
    fireEvent.click(screen.getByRole('button', { name: 'Download report.md' }));
    await waitFor(() => expect(triggerDownload).toHaveBeenCalledWith('blob:fixture', 'report.md'));
    expect(access.download).toHaveBeenCalledWith('/tmp/report.md');
    expect(URL.createObjectURL).toHaveBeenCalledWith(blob);
  } finally {
    URL.createObjectURL = original;
  }
});
it('keeps access errors distinct from confirmed missing files and allows retry', async () => {
  const access = {
    list: jest.fn().mockRejectedValue(new Error('offline')),
    preview: jest.fn(),
    download: jest.fn().mockRejectedValue(new Error('offline')),
  };
  show(access);
  fireEvent.click(screen.getByRole('button', { name: 'Session files' }));
  await screen.findAllByText('Could not check availability; you can retry downloading.');
  expect(screen.queryByText('File no longer available')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Download report.md' }));
  await screen.findByRole('alert');
  expect(access.download).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'Download report.md' })).toBeEnabled();
});
