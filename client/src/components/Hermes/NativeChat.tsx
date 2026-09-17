import { sessionFiles } from './files';
import { inlineImage } from './images';
import type { ExtendedFile } from '~/common';
import { sendHermesSteer } from './steer';
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useAtomValue, useStore } from 'jotai';
import { useNavigate } from 'react-router-dom';
import { Button, Spinner } from '@librechat/client';
import { useSetRecoilState } from 'recoil';
import {
  dataService,
  EModelEndpoint,
  hermesHasBriefing,
  hermesConversationId,
  hermesSessionView,
  hermesMessageViews,
  hermesGroupToolMessages,
  hermesRunActive,
  hermesOccupancy,
  hermesAttachmentNote,
  hermesNeedsContinuation,
} from 'librechat-data-provider';
import type {
  HermesAccess,
  HermesModels,
  HermesPreview,
  HermesHistory,
  HermesSession,
  HermesCapabilities,
  HermesApproval,
  TMessage,
  TConversation,
  Agents,
} from 'librechat-data-provider';
import { useHermesQuery, useHermesConnections } from '~/data-provider/Hermes';
import { useChatHelpers, useAddedResponse, useLocalize } from '~/hooks';
import { ToolCallsMapProvider } from '~/Providers';
import { ChatBackendContext } from '~/Providers/ChatBackendContext';
import { ChatSurface } from '~/components/Chat/ChatView';
import ToolApproval from '~/components/Chat/Messages/Content/ToolApproval';
import { useApprovalContext } from '~/components/Chat/Messages/Content/ApprovalContext';
import {
  hermesSessionKey,
  hermesSessionsAtom,
  hermesLiveAtom,
  hermesModelPreferenceKey,
  hermesModelPreferencesAtom,
} from './state';
import { useHermesEngine } from './Runtime';
import store from '~/store';

function Approval({
  approval,
  runId,
  sessionKey,
}: {
  approval: HermesApproval;
  runId: string;
  sessionKey: string;
}) {
  const engine = useHermesEngine();
  const localize = useLocalize();
  const states = useAtomValue(hermesSessionsAtom);
  const phase = states[sessionKey]?.approvalPhases?.[JSON.stringify([runId, approval.request_id])];
  const actionId = JSON.stringify([sessionKey, runId, approval.request_id]);
  const { setStatus, endToolSubmission } = useApprovalContext();
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    if (phase)
      setStatus(
        actionId,
        ({ uncertain: 'expired', accepted: 'submitted', sending: 'submitting' } as const)[phase],
      );
  }, [phase, actionId, setStatus]);
  return (
    <>
      <ToolApproval
        toolCallId={approval.request_id}
        args={{ command: approval.command }}
        approval={{
          actionId,
          allowed_decisions: ['approve', 'reject'],
          description: approval.description ?? approval.command,
        }}
      />
      {phase === 'uncertain' && (
        <Button
          disabled={checking}
          variant="outline"
          onClick={() => {
            if (checking) return;
            setChecking(true);
            void engine
              .readApprovals(sessionKey, runId, true)
              .then(() => {
                endToolSubmission(actionId);
                setStatus(actionId, 'idle');
              })
              .catch(() => {})
              .finally(() => setChecking(false));
          }}
        >
          {localize('com_ui_hermes_check_retry')}
        </Button>
      )}
    </>
  );
}

/** Native Hermes controller; the transcript, composer and header belong to ChatSurface. */
export default function NativeChat({
  connection,
  userId,
  sessionId,
}: {
  connection: HermesAccess;
  userId: string;
  sessionId?: string;
}) {
  const navigate = useNavigate();
  const localize = useLocalize();
  const engine = useHermesEngine();
  const atomStore = useStore();
  const states = useAtomValue(hermesSessionsAtom);
  const lives = useAtomValue(hermesLiveAtom);
  const binding = useMemo(
    () => ({
      userId,
      connectionId: connection.id,
      scope: connection.scope,
      sessionId: sessionId ?? 'new',
    }),
    [userId, connection.id, connection.scope, sessionId],
  );
  const key = hermesSessionKey(binding);
  const state = states[key] ?? {};
  const preferences = useAtomValue(hermesModelPreferencesAtom);
  const preferenceKey = hermesModelPreferenceKey(binding);
  const preferred = preferences[preferenceKey];
  const live = lives[key] ?? {};
  const conversationId = sessionId ? hermesConversationId(binding) : 'new';
  const helpers = useChatHelpers(0, conversationId);
  const added = useAddedResponse();
  const [error, setError] = useState(false);
  const creating = useRef(false);
  const sendFailure = useRef(false);
  useEffect(() => {
    if (sendFailure.current && !live.error && state.status === 'completed') {
      sendFailure.current = false;
      setError(false);
    }
  }, [state.status, live.error]);
  const uploadsInFlight = useRef(0);
  const [uploadsPending, setUploadsPending] = useState(false);
  const modelChanging = useRef(false);
  const [modelPending, setModelPending] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const setFiles = helpers.setFiles;
  const filesRef = useRef(helpers.files);
  filesRef.current = helpers.files;
  const patch = useCallback(
    (value: Partial<import('./state').SessionState>) => {
      atomStore.set(hermesSessionsAtom, (all) => ({ ...all, [key]: { ...all[key], ...value } }));
    },
    [atomStore, key],
  );

  const setShowStop = useSetRecoilState(store.showStopButtonByIndex(0));
  const session = useHermesQuery<{ session: HermesSession }>(
    userId,
    connection,
    { operation: 'session', sessionId: sessionId ?? 'new', scope: connection.scope },
    !!sessionId,
  );
  const history = useHermesQuery<HermesHistory>(
    userId,
    connection,
    { operation: 'messages', sessionId: sessionId ?? 'new', scope: connection.scope },
    !!sessionId,
    true,
  );
  const capabilities = useHermesQuery<HermesCapabilities>(userId, connection, {
    operation: 'capabilities',
  });
  const connections = useHermesConnections(userId);
  const models = useHermesQuery<HermesModels>(userId, connection, { operation: 'models' });
  const skills = useHermesQuery<{ data: { name: string; description?: string }[] }>(
    userId,
    connection,
    { operation: 'skills' },
  );
  const modelOptions = (models.data?.providers ?? []).flatMap((provider) =>
    provider.models.map((model) => ({
      id: JSON.stringify([provider.slug, model]),
      label: `${provider.name ?? provider.slug} / ${model}`,
    })),
  );
  const selectedModel = sessionId
    ? (state.model ?? session.data?.session.model)
    : (preferred?.model ?? state.model ?? models.data?.model);
  const selectedProvider = sessionId
    ? state.provider
    : (preferred?.provider ?? state.provider ?? models.data?.provider);
  let selectedOption: string | undefined;
  if (selectedProvider && selectedModel)
    selectedOption = JSON.stringify([selectedProvider, selectedModel]);
  else {
    const matching = modelOptions.filter((item) => JSON.parse(item.id)[1] === selectedModel);
    if (matching.length === 1) selectedOption = matching[0].id;
  }
  const connectionOptions = (connections.data ?? [])
    .filter((item) => item.id !== connection.id)
    .map((item) => ({
      id: `connection:${item.id}`,
      label: `${localize('com_ui_new_chat')} · ${item.label}`,
    }));
  const selectModel = async (id: string) => {
    const target = connectionOptions.find((item) => item.id === id);
    if (target) {
      navigate(`/c/new?hermes=${encodeURIComponent(id.slice('connection:'.length))}`);
      return;
    }

    if (!modelOptions.some((option) => option.id === id) || modelChanging.current) return;
    const current = atomStore.get(hermesSessionsAtom)[key];
    if (
      hermesRunActive(current?.status) ||
      current?.status === 'unconfirmed' ||
      current?.externalBusy ||
      atomStore.get(hermesLiveAtom)[key]?.streaming
    )
      return;
    modelChanging.current = true;
    setModelPending(true);
    setError(false);
    try {
      const [provider, model] = JSON.parse(id) as [string, string];
      if (sessionId) {
        const result = await dataService.hermesRequest<{
          runtime?: { provider?: string; model?: string };
        }>(connection.id, {
          operation: 'model',
          sessionId,
          scope: connection.scope,
          provider,
          model,
        });
        patch({
          provider: result.runtime?.provider ?? provider,
          model: result.runtime?.model ?? model,
        });
        await session.refetch();
      } else patch({ provider, model });
      atomStore.set(hermesModelPreferencesAtom, (all) => ({
        ...all,
        [preferenceKey]: { provider, model },
      }));
    } catch (failure) {
      setError(true);
      throw failure;
    } finally {
      modelChanging.current = false;
      setModelPending(false);
    }
  };
  const listedFiles = useMemo(() => sessionFiles(history.data?.data ?? []), [history.data]);
  const listFiles = useCallback(
    async (path: string) => {
      const reply = await dataService.hermesRequest<{
        entries: { name: string; is_directory: boolean }[];
      }>(connection.id, {
        operation: 'files',
        path,
        scope: connection.scope,
      });
      if (
        !Array.isArray(reply.entries) ||
        reply.entries.some(
          (entry) => typeof entry.name !== 'string' || typeof entry.is_directory !== 'boolean',
        )
      ) {
        throw new Error('invalid_file_listing');
      }
      return reply.entries;
    },
    [connection.id, connection.scope],
  );
  const previewFile = useCallback(
    async (path: string) => {
      const value = await dataService.hermesRequest<HermesPreview>(connection.id, {
        operation: 'preview',
        path,
        scope: connection.scope,
      });
      if (value.text != null) return new Blob([value.text], { type: 'text/plain' });
      if (!value.data) throw new Error('preview_unavailable');
      const bytes = Uint8Array.from(atob(value.data.replace(/^data:[^,]*,/, '')), (char) =>
        char.charCodeAt(0),
      );
      return new Blob([bytes], { type: value.mime });
    },
    [connection.id, connection.scope],
  );
  const downloadFile = useCallback(
    (path: string) => dataService.downloadHermesFile(connection.id, path, connection.scope),
    [connection.id, connection.scope],
  );
  const upload = async (file: File): Promise<ExtendedFile> => {
    uploadsInFlight.current += 1;
    setUploadsPending(true);
    try {
      if (file.size > connection.maxUploadBytes) throw new Error('file_too_large');
      const preview = /^image\/(png|jpeg|webp|gif)$/.test(file.type)
        ? await inlineImage(file, connection)
        : undefined;
      const result = await dataService.uploadHermesFile(connection.id, file, connection.scope);
      if (!result.path) throw new Error('upload_unconfirmed');
      return {
        file_id: crypto.randomUUID(),
        filename: file.name,
        filepath: result.path,
        type: file.type,
        size: file.size,
        progress: 1,
        attached: true,
        preview,
        backendIdentity: key,
      };
    } finally {
      uploadsInFlight.current -= 1;
      setUploadsPending(uploadsInFlight.current > 0);
    }
  };
  const prepareSubmission = useCallback(
    (text: string) => {
      if (uploadsInFlight.current > 0) throw new Error('file_not_ready');
      const files = [...filesRef.current.values()];
      if (files.some((file) => file.backendIdentity !== key || file.progress < 1 || !file.filepath))
        throw new Error('file_not_ready');
      const message = [text.trim(), hermesAttachmentNote(files.map((file) => file.filepath!))]
        .filter(Boolean)
        .join('\n\n');
      const images = files.flatMap((file) =>
        file.preview?.startsWith('data:image/') ? [file.preview] : [],
      );
      if (
        new TextEncoder().encode(
          JSON.stringify({
            sessionId: sessionId ?? 'new',
            scope: connection.scope,
            input: images.length
              ? [
                  { type: 'text', text: message },
                  ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
                ]
              : message,
          }),
        ).length > connection.maxChatBytes
      )
        throw new Error('message_too_large');
      const consume = () =>
        setFiles((all) => {
          const next = new Map(all);
          for (const file of files) next.delete(file.file_id);
          return next;
        });
      return { message, images, consume };
    },
    [key, setFiles, connection.maxChatBytes, connection.scope, sessionId],
  );
  const busy = Boolean(
    live.streaming ||
      hermesRunActive(state.status) ||
      state.status === 'unconfirmed' ||
      state.externalBusy,
  );
  const canSteer =
    busy &&
    state.status !== 'stopping' &&
    state.status !== 'unconfirmed' &&
    Boolean(
      (state.runId && capabilities.data?.features?.run_steer) ||
        capabilities.data?.features?.session_steer,
    );
  const conversation = useMemo<TConversation>(
    () =>
      sessionId
        ? hermesSessionView(connection, session.data?.session ?? { id: sessionId })
        : {
            conversationId: 'new',
            title: 'New Chat',
            endpoint: EModelEndpoint.hermes,
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
            model: undefined,
          },
    [connection, sessionId, session.data],
  );
  useEffect(() => {
    if (sessionId)
      atomStore.set(hermesSessionsAtom, (all) => ({ ...all, [key]: { ...all[key], binding } }));
  }, [atomStore, key, binding, sessionId]);
  const setConversation = helpers.setConversation;
  useEffect(() => {
    setConversation(conversation);
  }, [conversation, setConversation]);
  const setSubmitting = helpers.setIsSubmitting;
  useEffect(() => {
    setSubmitting(busy);
    setShowStop(busy);
  }, [busy, setSubmitting, setShowStop]);
  useEffect(
    () => () => {
      setSubmitting(false);
      setShowStop(false);
    },
    [setSubmitting, setShowStop],
  );
  const messages = useMemo(() => {
    if (!sessionId) return [];
    const rows = hermesMessageViews(conversationId, history.data ?? { data: [], truncated: false });
    const last = rows.at(-1);
    const tailText = last?.content?.filter((part) => part.type === 'text').at(-1);
    const liveAlreadyVisible =
      !last?.isCreatedByUser &&
      (last?.text === live.text || (tailText?.type === 'text' && tailText.text === live.text));
    if (live.text && !liveAlreadyVisible)
      rows.push({
        conversationId,
        messageId: `${conversationId}.live`,
        parentMessageId: rows.at(-1)?.messageId ?? null,
        text: live.text,
        sender: 'Hermes',
        isCreatedByUser: false,
        endpoint: 'hermes',
        unfinished: true,
      });
    return hermesGroupToolMessages(rows);
  }, [sessionId, conversationId, history.data, live.text]);
  const setMessages = helpers.setMessages;
  useEffect(() => {
    setMessages(messages);
  }, [messages, setMessages]);
  const stop = useCallback(() => {
    return engine.stop(key).catch(() => setError(true));
  }, [engine, key]);
  const steer = useCallback(
    async (text: string) => {
      setError(false);
      try {
        if (new TextEncoder().encode(text).length > connection.maxChatBytes)
          throw new Error('message_too_large');
        const submission = prepareSubmission(text);
        await sendHermesSteer({
          state: atomStore.get(hermesSessionsAtom)[key] ?? {},
          streaming: atomStore.get(hermesLiveAtom)[key]?.streaming === true,
          capabilities: capabilities.data,
          text: submission.message,
          request: dataService.hermesRequest,
        });
        submission.consume();
      } catch (failure) {
        setError(true);
        throw failure;
      }
    },
    [atomStore, key, capabilities.data, connection.maxChatBytes, prepareSubmission],
  );
  const send = useCallback(
    async (text: string, accepted?: () => void) => {
      setError(false);
      sendFailure.current = false;
      try {
        if (new TextEncoder().encode(text).length > connection.maxChatBytes)
          throw new Error('message_too_large');
        if (modelChanging.current) throw new Error('model_change_pending');
        const submission = prepareSubmission(text);
        if (!sessionId) {
          if (creating.current) throw new Error('session_busy');
          creating.current = true;
          const choice =
            atomStore.get(hermesModelPreferencesAtom)[hermesModelPreferenceKey(binding)] ??
            atomStore.get(hermesSessionsAtom)[key];
          const result = await dataService.hermesRequest<{ session: HermesSession }>(
            connection.id,
            {
              operation: 'create',
              title: Array.from(text.trim()).slice(0, 100).join('') || localize('com_ui_new_chat'),
              scope: connection.scope,
              ...(choice?.provider && choice.model
                ? { provider: choice.provider, model: choice.model }
                : {}),
            },
          );
          const next = { ...binding, sessionId: result.session.id };
          const nextKey = hermesSessionKey(next);
          atomStore.set(hermesSessionsAtom, (all) => ({
            ...all,
            [nextKey]: { binding: next, provider: choice?.provider, model: choice?.model },
          }));
          await new Promise<void>((resolve, reject) => {
            void engine
              .send(
                nextKey,
                submission.message,
                submission.images,
                resolve,
                connection.formattingInstructions,
              )
              .then(resolve, reject);
          });
          submission.consume();
          accepted?.();
          navigate(`/c/${hermesConversationId(next)}`);
          return;
        }
        if (busy) {
          await steer(text);
        } else {
          if (connection.formattingInstructions) {
            if (!history.data || history.isError) throw new Error('history_unavailable');
            if (hermesHasBriefing(history.data)) patch({ briefed: true });
          }
          await new Promise<void>((resolve, reject) => {
            void engine
              .send(
                key,
                submission.message,
                submission.images,
                resolve,
                connection.formattingInstructions,
              )
              .then(resolve, reject);
          });
        }
        submission.consume();
      } catch (failure) {
        sendFailure.current = true;
        setError(true);
        throw failure;
      } finally {
        creating.current = false;
      }
    },
    [
      connection,
      binding,
      sessionId,
      atomStore,
      navigate,
      engine,
      key,
      busy,
      steer,
      prepareSubmission,
      localize,
      history.data,
      history.isError,
      patch,
    ],
  );
  const submitApproval = useCallback(
    async (actionId: string, decisions: Agents.ToolApprovalResolution[]) => {
      if (!state.runId || decisions.length !== 1) throw new Error('approval_identity_changed');
      const decision = decisions[0];
      if (
        actionId !== JSON.stringify([key, state.runId, decision.tool_call_id]) ||
        !['approve', 'reject'].includes(decision.decision)
      )
        throw new Error('approval_identity_changed');
      await engine.approve(
        key,
        state.runId,
        decision.tool_call_id,
        decision.decision === 'approve' ? 'once' : 'deny',
      );
    },
    [engine, key, state.runId],
  );
  const notices = (
    <>
      {state.failureReason && (
        <p role="alert">
          {localize(
            state.failureReason === 'model_unavailable'
              ? 'com_ui_hermes_model_unavailable'
              : 'com_ui_hermes_run_failed',
          )}
        </p>
      )}
      {!state.failureReason && (error || live.error || history.isError || session.isError) && (
        <p role="alert">{localize('com_ui_hermes_request_error')}</p>
      )}
      {!busy && hermesNeedsContinuation(state.delivery ?? [], state.handled) && (
        <div role="status">
          <p>{localize('com_ui_hermes_continue_notice')}</p>
          <Button
            disabled={continuing}
            onClick={() => {
              if (continuing) return;
              setContinuing(true);
              patch({ followupBlocked: false, deferred: false });
              void engine
                .continue(key, state.delivery ?? [])
                .catch(() => setError(true))
                .finally(() => setContinuing(false));
            }}
          >
            {localize('com_ui_hermes_continue_once')}
          </Button>
          {!state.deferred && (
            <Button variant="ghost" onClick={() => patch({ deferred: true, automatic: false })}>
              {localize('com_ui_hermes_later')}
            </Button>
          )}
        </div>
      )}
      {history.data?.truncated && <p role="status">{localize('com_ui_hermes_truncated')}</p>}
      {Object.values(state.approvals ?? {}).map(
        (approval) =>
          state.runId && (
            <Approval
              key={`${state.runId}:${approval.request_id}`}
              approval={approval}
              runId={state.runId}
              sessionKey={key}
            />
          ),
      )}
    </>
  );
  const viewHelpers = {
    ...helpers,
    conversation,
    isSubmitting: busy,
    feedbackEnabled: false,
    getMessages: () => messages as TMessage[],
    stopGenerating: stop,
    handleStopGenerating: (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      stop();
    },
    ask: () => false as const,
    regenerate: () => {},
    handleRegenerate: () => {},
    handleContinue: () => {},
  };
  if (sessionId && session.isLoading) return <Spinner />;
  return (
    <ChatBackendContext.Provider
      value={{
        identity: key,
        openAtLatest: true,
        documentFences: true,
        nativeTranscript: true,
        label: connection.label,
        models: {
          options: [...modelOptions, ...connectionOptions],
          selected: selectedOption,
          loading: models.isLoading,
          disabled: busy || modelPending,
          select: selectModel,
        },
        skills: {
          items: skills.data?.data ?? [],
          loading: skills.isLoading,
          error: skills.isError,
        },
        upload: connection.files ? upload : undefined,
        uploadsPending,
        contextUsage: hermesOccupancy(state.usage),
        files: connection.files
          ? { preview: previewFile, download: downloadFile, list: listFiles }
          : undefined,
        sessionFiles: listedFiles,
        send,
        steer,
        canSendDuringRun: canSteer,
        speechToText: false,
        notices,
        recoverDraft: live.error ? live.sent : undefined,
        submitApproval,
      }}
    >
      <ToolCallsMapProvider conversationId={conversationId}>
        <ChatSurface
          conversationId={conversationId}
          chatHelpers={viewHelpers}
          addedChatHelpers={added}
          messages={messages}
          isLoading={!!sessionId && history.isLoading}
        />
      </ToolCallsMapProvider>
    </ChatBackendContext.Provider>
  );
}
