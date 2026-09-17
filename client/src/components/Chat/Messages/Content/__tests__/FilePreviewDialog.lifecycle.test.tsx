import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TFilePreview } from 'librechat-data-provider';
import FilePreviewDialog from '../FilePreviewDialog';

let mockFileMap: Record<string, { llmDeliveryPath: 'text' }> = {};
let mockShareId: string | undefined;
let mockPreview: TFilePreview | undefined;
let mockPreviewError = false;
const mockOwnedPreview = jest.fn();
const mockSharedPreview = jest.fn();
const mockDownload = jest.fn();
const mockRetry = jest.fn();
const mockRevoke = jest.fn();
const mockTriggerDownload = jest.fn();
const mockUseFilePreview = jest.fn();

jest.mock('../MarkdownLite', () => ({
  __esModule: true,
  default: ({ content }: { content: string }) => (
    <div data-testid="rendered-markdown">{content}</div>
  ),
}));
jest.mock('~/components/Artifacts/ArtifactPreview', () => ({
  ArtifactPreview: () => <div data-testid="html-preview" />,
}));
jest.mock('~/hooks/Artifacts/useArtifactProps', () => ({ __esModule: true, default: () => ({}) }));
jest.mock('recoil', () => ({ useRecoilValue: () => ({ id: 'owner' }) }));
jest.mock('~/store', () => ({ user: {} }));
jest.mock('~/Providers', () => ({
  useShareContext: () => ({ shareId: mockShareId }),
  useFileMapContext: () => mockFileMap,
}));
jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('~/utils', () => ({
  getDownloadFilename: (name: string) => name,
  logger: { error: jest.fn() },
  sortPagesByRelevance: () => [],
  triggerDownload: (...args: unknown[]) => mockTriggerDownload(...args),
}));
jest.mock('~/data-provider', () => ({
  useFilePreview: (...args: unknown[]) => {
    mockUseFilePreview(...args);
    return {
      data: mockPreview,
      isInitialLoading: !mockPreview && !mockPreviewError,
      isFetching: false,
      isError: mockPreviewError,
      refetch: mockRetry,
    };
  },
  useFileDownload: (_user: string, _file: string, options: { purpose?: string }) => ({
    refetch: options.purpose === 'preview' ? mockOwnedPreview : mockDownload,
  }),
  useFilePreviewBlob: (_user: string, _file: string, shareId?: string) => ({
    refetch: shareId ? mockSharedPreview : mockOwnedPreview,
  }),
  useSharedFileDownload: (_share: string, _file: string, purpose?: string) => ({
    refetch: purpose === 'preview' ? mockSharedPreview : mockDownload,
  }),
  revokeDownloadURL: (url: string) => mockRevoke(url),
}));
jest.mock('@librechat/client', () => ({
  OGDialog: ({ open, children }: React.PropsWithChildren<{ open: boolean }>) =>
    open ? <div>{children}</div> : null,
  OGDialogContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  OGDialogTitle: ({ children }: React.PropsWithChildren) => <h2>{children}</h2>,
  OGDialogDescription: ({ children }: React.PropsWithChildren) => <p>{children}</p>,
  Button: ({ children, onClick }: React.PropsWithChildren<{ onClick: () => void }>) => (
    <button onClick={onClick}>{children}</button>
  ),
}));
jest.mock('~/components/Messages/Content/CopyButton', () => () => null);

const props = {
  open: true,
  onOpenChange: jest.fn(),
  fileId: 'f1',
  fileName: 'report.pdf',
  fileType: 'application/pdf',
};

describe('FilePreviewDialog lifecycle', () => {
  it('routes Markdown files to the shared renderer instead of a raw pre block', async () => {
    const loader = {
      preview: async () => ({ text: async () => '# Report' }) as Blob,
      download: jest.fn(),
    };
    const { container } = render(
      <FilePreviewDialog
        {...props}
        fileId={undefined}
        fileName="report.md"
        fileType="text/markdown"
        fileLoader={loader}
      />,
    );
    await screen.findByTestId('rendered-markdown');
    expect(container.querySelector('pre')).toBeNull();
  });
  it('routes HTML files to the stock sandbox preview', async () => {
    const loader = {
      preview: async () => ({ text: async () => '<title>Report</title>' }) as Blob,
      download: jest.fn(),
    };
    render(
      <FilePreviewDialog
        {...props}
        fileId={undefined}
        fileName="report.html"
        fileType="text/html"
        fileLoader={loader}
      />,
    );
    expect(await screen.findByTestId('html-preview')).toBeInTheDocument();
  });
  it('revokes an image preview URL when the dialog unmounts', async () => {
    const create = URL.createObjectURL,
      revoke = URL.revokeObjectURL;
    URL.createObjectURL = jest.fn(() => 'blob:image');
    URL.revokeObjectURL = jest.fn();
    try {
      const loader = {
        preview: async () => new Blob(['image'], { type: 'image/png' }),
        download: jest.fn(),
      };
      const view = render(
        <FilePreviewDialog
          {...props}
          fileId={undefined}
          fileName="image.png"
          fileType="image/png"
          fileLoader={loader}
        />,
      );
      await waitFor(() => expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:image'));
      view.unmount();
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:image');
    } finally {
      URL.createObjectURL = create;
      URL.revokeObjectURL = revoke;
    }
  });
  it('uses the supplied native loader without accessing Mongo file IDs', async () => {
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = jest.fn(() => 'blob:native');
    URL.revokeObjectURL = jest.fn();
    const fileLoader = {
      preview: jest.fn().mockResolvedValue(new Blob(['pdf'])),
      download: jest.fn().mockResolvedValue(new Blob(['original'])),
    };
    try {
      const view = render(
        <FilePreviewDialog {...props} fileId={undefined} fileLoader={fileLoader} />,
      );
      await waitFor(() =>
        expect(screen.getByTitle('com_ui_preview: report.pdf')).toHaveAttribute(
          'src',
          'blob:native',
        ),
      );
      expect(mockOwnedPreview).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'com_ui_download report.pdf' }));
      await waitFor(() => expect(fileLoader.download).toHaveBeenCalledTimes(1));
      expect(mockDownload).not.toHaveBeenCalled();
      view.unmount();
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
  });
  it('renders an ordinary PDF and revokes its display URL on close', async () => {
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    const revoke = jest.fn();
    URL.createObjectURL = jest.fn(() => 'blob:display');
    URL.revokeObjectURL = revoke;
    try {
      mockOwnedPreview.mockResolvedValue({ data: new Blob(['pdf']) });
      const view = render(<FilePreviewDialog {...props} />);
      await waitFor(() =>
        expect(screen.getByTitle('com_ui_preview: report.pdf')).toHaveAttribute(
          'src',
          'blob:display',
        ),
      );
      view.unmount();
      expect(revoke).toHaveBeenCalledWith('blob:display');
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockFileMap = {};
    mockShareId = undefined;
    mockPreview = { file_id: 'f1', status: 'ready', text: 'extracted document' };
    mockPreviewError = false;
    mockOwnedPreview.mockResolvedValue({});
    mockSharedPreview.mockResolvedValue({});
    mockDownload.mockResolvedValue({ data: 'blob:original' });
  });

  it('renders extracted text and downloads the original object', async () => {
    render(<FilePreviewDialog {...props} deliveryPath="text" />);
    expect(screen.getByText('extracted document')).toBeInTheDocument();
    expect(mockOwnedPreview).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_download report.pdf' }));
    await waitFor(() =>
      expect(mockTriggerDownload).toHaveBeenCalledWith('blob:original', 'report.pdf'),
    );
  });

  it('handles pending, polling failure, retry, and empty success', () => {
    mockPreview = { file_id: 'f1', status: 'pending' };
    const view = render(<FilePreviewDialog {...props} deliveryPath="text" />);
    expect(screen.getByText('com_ui_loading')).toBeInTheDocument();
    mockPreviewError = true;
    view.rerender(<FilePreviewDialog {...props} deliveryPath="text" />);
    expect(screen.queryByText('com_ui_loading')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));
    expect(mockRetry).toHaveBeenCalledTimes(1);
    mockPreviewError = false;
    mockPreview = { file_id: 'f1', status: 'ready', text: '' };
    view.rerender(<FilePreviewDialog {...props} deliveryPath="text" />);
    expect(screen.queryByText('com_ui_preview_unavailable')).toBeNull();
  });

  it('recovers late metadata while open and discards the obsolete binary response', async () => {
    let resolve!: (value: { data: Blob }) => void;
    mockOwnedPreview.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const view = render(<FilePreviewDialog {...props} />);
    mockFileMap = { f1: { llmDeliveryPath: 'text' } };
    view.rerender(<FilePreviewDialog {...props} />);
    expect(screen.getByText('extracted document')).toBeInTheDocument();
    await act(async () => {
      resolve({ data: new Blob(['obsolete']) });
    });
    expect(screen.queryByTitle('com_ui_preview: report.pdf')).toBeNull();
  });

  it('handles a deduplicated response after closing and reopening', async () => {
    let resolve!: (value: { data: Blob }) => void;
    mockOwnedPreview.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const textProps = { ...props, fileName: 'notes.txt', fileType: 'text/plain' };
    const view = render(<FilePreviewDialog {...textProps} />);
    view.rerender(<FilePreviewDialog {...textProps} open={false} />);
    view.rerender(<FilePreviewDialog {...textProps} />);
    expect(mockOwnedPreview).toHaveBeenCalledTimes(2);
    await act(async () => {
      resolve({ data: { text: async () => 'shared bytes' } as Blob });
    });
    expect(screen.getByText('shared bytes')).toBeInTheDocument();
    expect(screen.queryByText('com_ui_preview_unavailable')).toBeNull();
  });

  it('uses only shared metadata and the shared authorization scope', async () => {
    mockShareId = 'public-share';
    mockFileMap = { f1: { llmDeliveryPath: 'text' } };
    const view = render(<FilePreviewDialog {...props} />);
    await waitFor(() => expect(mockSharedPreview).toHaveBeenCalledTimes(1));
    expect(mockOwnedPreview).not.toHaveBeenCalled();
    expect(screen.queryByText('extracted document')).toBeNull();
    view.rerender(<FilePreviewDialog {...props} deliveryPath="text" />);
    expect(mockUseFilePreview).toHaveBeenLastCalledWith('f1', { enabled: true }, 'public-share');
    expect(screen.getByText('extracted document')).toBeInTheDocument();
  });
});
