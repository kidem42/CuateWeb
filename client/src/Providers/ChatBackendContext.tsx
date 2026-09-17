import { createContext, useContext } from 'react';
import type { Agents } from 'librechat-data-provider';
import type { ExtendedFile } from '~/common';
import type { ReactNode } from 'react';

/** Optional transport capabilities for the shared chat surface. */
export type ChatBackend = {
  identity: string;
  openAtLatest?: boolean;
  documentFences?: boolean;
  nativeTranscript?: boolean;
  speechToText?: boolean;
  label: string;
  models?: {
    options: { id: string; label: string }[];
    selected?: string;
    loading: boolean;
    disabled: boolean;
    select: (id: string) => Promise<void>;
  };
  skills?: { items: { name: string; description?: string }[]; loading: boolean; error: boolean };
  sessionFiles?: { path: string; source: 'assistant' | 'user' }[];
  files?: {
    preview: (path: string) => Promise<Blob>;
    download: (path: string) => Promise<Blob>;
    list?: (path: string) => Promise<{ name: string; is_directory: boolean }[]>;
  };
  contextUsage?: { used: number; max: number; percent: number; estimated: boolean };
  uploadsPending?: boolean;
  upload?: (file: File) => Promise<ExtendedFile>;
  send: (text: string, accepted?: () => void) => Promise<void>;
  steer: (text: string) => Promise<void>;
  canSendDuringRun: boolean;
  notices?: ReactNode;
  recoverDraft?: string;
  submitApproval: (actionId: string, decisions: Agents.ToolApprovalResolution[]) => Promise<void>;
};
export const ChatBackendContext = createContext<ChatBackend | null>(null);
export const useChatBackend = () => useContext(ChatBackendContext);
