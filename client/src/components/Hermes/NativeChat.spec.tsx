import React from 'react';
import { Provider, createStore } from 'jotai';
import { render, act, cleanup } from '@testing-library/react';
import NativeChat from './NativeChat';
import {
  hermesSessionsAtom,
  hermesSessionKey,
  hermesModelPreferenceKey,
  hermesModelPreferencesAtom,
} from './state';
import { useChatBackend as mockUseChatBackend } from '~/Providers/ChatBackendContext';
const mockRequest = jest.fn(),
  mockUpload = jest.fn(),
  mockSet = jest.fn();
const mockEngine = {
  send: jest.fn(),
  stop: jest.fn(),
  approve: jest.fn(),
  continue: jest.fn(),
  readApprovals: jest.fn(),
};
const mockHelpers: any = {
  files: new Map(),
  setFiles: jest.fn(),
  setMessages: mockSet,
  setConversation: mockSet,
  setIsSubmitting: mockSet,
};
let mockBackend: any, mockView: any;
const mockResults: Record<string, any> = {
  session: { session: { id: 's', title: 'Existing', model: 'model1' } },
  messages: { data: [{ id: 1, role: 'user', content: 'History' }], truncated: false },
  models: { providers: [{ slug: 'p', models: ['model1', 'model2'] }] },
  skills: { data: [{ name: 'reports' }] },
  capabilities: { features: { run_steer: true } },
};
jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  ...jest.requireActual('../../../../packages/data-provider/src/hermes'),
  dataService: {
    hermesRequest: (...args: any[]) => mockRequest(...args),
    uploadHermesFile: (...args: any[]) => mockUpload(...args),
  },
}));
jest.mock('react-router-dom', () => ({ useNavigate: () => mockSet }));
jest.mock('recoil', () => ({ useSetRecoilState: () => mockSet }));
jest.mock('~/store', () => ({ __esModule: true, default: { showStopButtonByIndex: () => ({}) } }));
jest.mock('~/hooks', () => ({
  useChatHelpers: () => mockHelpers,
  useAddedResponse: () => ({}),
  useLocalize: () => (key: string) => key,
}));
jest.mock('~/Providers', () => ({ ToolCallsMapProvider: ({ children }: any) => children }));
jest.mock('~/data-provider/Hermes', () => ({
  useHermesConnections: () => ({ data: [] }),
  useHermesQuery: (_u: string, _c: any, input: any) => ({
    data: mockResults[input.operation],
    isLoading: false,
    refetch: mockSet,
  }),
}));
jest.mock('./Runtime', () => ({ useHermesEngine: () => mockEngine }));
jest.mock('~/components/Chat/Messages/Content/ApprovalContext', () => ({
  useApprovalContext: () => ({ setStatus: mockSet, endToolSubmission: mockSet }),
}));
jest.mock('~/components/Chat/Messages/Content/ToolApproval', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('~/components/Chat/ChatView', () => ({
  ChatSurface: (props: any) => {
    mockView = props;
    mockBackend = mockUseChatBackend();
    return <>{mockBackend.notices}</>;
  },
}));
const connection: any = {
  id: 'c',
  scope: 'host',
  label: 'Hermes',
  files: true,
  maxChatBytes: 2500000,
  maxUploadBytes: 1000000,
};
const binding = { userId: 'u', connectionId: 'c', scope: 'host', sessionId: 's' },
  key = hermesSessionKey(binding);
function mount(state = {}) {
  const atoms = createStore();
  atoms.set(hermesSessionsAtom, { [key]: { binding, ...state } });
  render(
    <Provider store={atoms}>
      <NativeChat userId="u" connection={connection} sessionId="s" />
    </Provider>,
  );
  return atoms;
}
beforeEach(() => {
  jest.clearAllMocks();
  localStorage.removeItem('cuateweb.hermes.models.v1');
  mockHelpers.files = new Map();
  mockHelpers.setFiles.mockImplementation((update: any) => {
    mockHelpers.files = update(mockHelpers.files);
  });
  mockEngine.send.mockImplementation(
    async (_k: string, _t: string, _i: string[], accepted: () => void) => accepted(),
  );
  mockEngine.stop.mockResolvedValue(undefined);
  mockRequest.mockResolvedValue({ accepted: true });
});
afterEach(cleanup);
it('projects native history and catalogs into the shared view', () => {
  mount();
  expect(mockView.messages[0].text).toBe('History');
  expect(mockBackend.models.options).toHaveLength(2);
  expect(mockBackend.skills.items[0].name).toBe('reports');
});
it('changes the existing session model through its native API', async () => {
  const atoms = mount();
  await act(async () => {
    await mockBackend.models.select(JSON.stringify(['p', 'model2']));
  });
  expect(mockRequest).toHaveBeenCalledWith('c', {
    operation: 'model',
    sessionId: 's',
    scope: 'host',
    provider: 'p',
    model: 'model2',
  });
  expect(atoms.get(hermesSessionsAtom)[key].model).toBe('model2');
});
it('delivers and consumes acknowledged attachments', async () => {
  mockHelpers.files = new Map([
    [
      'file',
      { file_id: 'file', filepath: '/uploads/a.txt', size: 5, progress: 1, backendIdentity: key },
    ],
  ]);
  mount();
  await act(async () => {
    await mockBackend.send('Read');
  });
  expect(mockEngine.send).toHaveBeenCalledWith(
    key,
    expect.stringContaining('/uploads/a.txt'),
    [],
    expect.any(Function),
    undefined,
  );
  expect(mockHelpers.files.size).toBe(0);
});
it('rejects attachments from another session before sending', async () => {
  mockHelpers.files = new Map([
    [
      'file',
      { file_id: 'file', filepath: '/uploads/a.txt', progress: 1, backendIdentity: 'other' },
    ],
  ]);
  mount();
  await act(async () => {
    await expect(mockBackend.send('Read')).rejects.toThrow('file_not_ready');
  });
  expect(mockEngine.send).not.toHaveBeenCalled();
  expect(mockHelpers.files.size).toBe(1);
});
it('retains Stop and locks model selection while waiting for approval', async () => {
  mount({ runId: 'r', status: 'waiting_for_approval' });
  expect(mockView.chatHelpers.isSubmitting).toBe(true);
  expect(mockBackend.models.disabled).toBe(true);
  await act(async () => {
    mockView.chatHelpers.stopGenerating();
  });
  expect(mockEngine.stop).toHaveBeenCalledWith(key);
});
it('returns a scoped stock file chip after native upload', async () => {
  mockUpload.mockResolvedValue({ path: '/uploads/a.txt' });
  mount();
  const result = await mockBackend.upload(new File(['hello'], 'a.txt', { type: 'text/plain' }));
  expect(result).toMatchObject({
    filepath: '/uploads/a.txt',
    attached: true,
    backendIdentity: key,
    progress: 1,
  });
});

it('keeps attachments after an uncertain send and never retries', async () => {
  mockHelpers.files = new Map([
    ['file', { file_id: 'file', filepath: '/uploads/a.txt', progress: 1, backendIdentity: key }],
  ]);
  mockEngine.send.mockRejectedValue(new Error('lost connection'));
  mount();
  await act(async () => {
    await expect(mockBackend.send('Read')).rejects.toThrow('lost connection');
  });
  expect(mockEngine.send).toHaveBeenCalledTimes(1);
  expect(mockHelpers.files.size).toBe(1);
});
it('includes attachment paths in a native steer', async () => {
  mockHelpers.files = new Map([
    ['file', { file_id: 'file', filepath: '/uploads/a.txt', progress: 1, backendIdentity: key }],
  ]);
  mount({ runId: 'r', status: 'running' });
  await act(async () => {
    await mockBackend.steer('Also read');
  });
  expect(mockRequest).toHaveBeenCalledWith(
    'c',
    expect.objectContaining({
      operation: 'steer',
      runId: 'r',
      text: expect.stringContaining('/uploads/a.txt'),
    }),
  );
  expect(mockHelpers.files.size).toBe(0);
  expect(mockEngine.send).not.toHaveBeenCalled();
});

it('blocks submissions while an upload is pending', async () => {
  let resolve!: (result: { path: string }) => void;
  mockUpload.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  mount();
  let upload!: Promise<unknown>;
  await act(async () => {
    upload = mockBackend.upload(new File(['x'], 'a.txt'));
  });
  expect(mockBackend.uploadsPending).toBe(true);
  await act(async () => {
    await expect(mockBackend.send('Read')).rejects.toThrow('file_not_ready');
  });
  expect(mockEngine.send).not.toHaveBeenCalled();
  await act(async () => {
    resolve({ path: '/uploads/a.txt' });
    await upload;
  });
  expect(mockBackend.uploadsPending).toBe(false);
});
it('uses occupancy rather than cumulative spend for the stock context indicator', () => {
  mount({ usage: { context_used: 30, context_max: 100, total_tokens: 90000 } });
  expect(mockBackend.contextUsage).toMatchObject({ used: 30, max: 100, percent: 30 });
});

it('persists an explicit model selection for the next session on the same account and endpoint', async () => {
  const atoms = mount();
  await act(async () => {
    await mockBackend.models.select(JSON.stringify(['p', 'model2']));
  });
  expect(atoms.get(hermesModelPreferencesAtom)[hermesModelPreferenceKey(binding)]).toEqual({
    provider: 'p',
    model: 'model2',
  });
  expect(hermesModelPreferenceKey({ ...binding, userId: 'other' })).not.toBe(
    hermesModelPreferenceKey(binding),
  );
  expect(hermesModelPreferenceKey({ ...binding, scope: 'other' })).not.toBe(
    hermesModelPreferenceKey(binding),
  );
  cleanup();
  mockRequest.mockResolvedValue({ session: { id: 'next' } });
  render(
    <Provider store={atoms}>
      <NativeChat userId="u" connection={connection} />
    </Provider>,
  );
  await act(async () => {
    await mockBackend.send('New task');
  });
  expect(mockRequest).toHaveBeenCalledWith(
    'c',
    expect.objectContaining({ operation: 'create', provider: 'p', model: 'model2' }),
  );
});
it('does not remember a rejected model switch', async () => {
  const atoms = mount();
  mockRequest.mockRejectedValueOnce(new Error('rejected'));
  await act(async () => {
    await expect(mockBackend.models.select(JSON.stringify(['p', 'model2']))).rejects.toThrow(
      'rejected',
    );
  });
  expect(atoms.get(hermesModelPreferencesAtom)[hermesModelPreferenceKey(binding)]).toBeUndefined();
});
