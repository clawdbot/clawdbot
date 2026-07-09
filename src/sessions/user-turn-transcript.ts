// User turn transcript helpers extract user-turn text from session transcripts.
import path from "node:path";
import { mimeTypeFromFilePath } from "@openclaw/media-core/mime";
import type { AgentMessage } from "../../packages/agent-core/src/types.js";
import { persistSessionTranscriptTurn } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { applyInputProvenanceToUserMessage, normalizeInputProvenance } from "./input-provenance.js";
import type {
  PersistedUserTurnMediaInput,
  PersistedUserTurnMessage,
  UserTurnBeforeMessageWrite,
  UserTurnInput,
  UserTurnSessionEntry,
  UserTurnTranscriptFileTarget,
  UserTurnTranscriptPersistResult,
  UserTurnTranscriptRecorder,
  UserTurnTranscriptTarget,
  UserTurnTranscriptTargetResolver,
  UserTurnTranscriptUpdateMode,
} from "./user-turn-transcript.types.js";

export type {
  PersistedUserTurnMessage,
  UserTurnInput,
  UserTurnTranscriptRecorder,
} from "./user-turn-transcript.types.js";
export {
  attachRuntimeUserTurnTranscriptContext,
  attachRuntimeUserTurnTranscriptRecorder,
  takeRuntimeUserTurnTranscriptContext,
  takeRuntimeUserTurnTranscriptRecorder,
  type RuntimeUserTurnTranscriptContext,
} from "./user-turn-transcript-runtime-context.js";

type PersistedUserTurnMediaFields = {
  MediaPath?: string;
  MediaPaths?: string[];
  MediaType?: string;
  MediaTypes?: string[];
};

type AppendUserTurnTranscriptMessageParams = {
  transcriptPath: string;
  input?: UserTurnInput;
  message?: PersistedUserTurnMessage;
  sessionId?: string;
  agentId?: string;
  sessionKey?: string;
  cwd?: string;
  config?: OpenClawConfig;
  updateMode?: UserTurnTranscriptUpdateMode;
  beforeMessageWrite?: UserTurnBeforeMessageWrite;
};

type PersistUserTurnTranscriptParams = {
  input?: UserTurnInput;
  message?: PersistedUserTurnMessage;
  sessionId: string;
  sessionKey: string;
  sessionEntry: UserTurnSessionEntry | undefined;
  sessionStore?: Record<string, UserTurnSessionEntry>;
  storePath?: string;
  agentId: string;
  threadId?: string | number;
  cwd?: string;
  config?: unknown;
  updateMode?: UserTurnTranscriptUpdateMode;
  beforeMessageWrite?: UserTurnBeforeMessageWrite;
};

type UserTurnInputResolver = () => UserTurnInput | undefined | Promise<UserTurnInput | undefined>;

type CreateUserTurnTranscriptRecorderParams = {
  input?: UserTurnInput;
  message?: PersistedUserTurnMessage;
  resolveInput?: UserTurnInputResolver;
  target: UserTurnTranscriptTargetResolver;
  updateMode?: UserTurnTranscriptUpdateMode;
  beforeMessageWrite?: UserTurnBeforeMessageWrite;
  errorContext?: string;
  onPersistenceError?: (error: unknown) => void;
  onMessagePersisted?: (message: PersistedUserTurnMessage) => void | Promise<void>;
};

type ResolvePersistedUserTurnTextOptions = {
  hasMedia?: boolean;
};

type PersistedUserTurnMediaFieldSource = {
  MediaPath?: string | null;
  MediaPaths?: readonly (string | null | undefined)[] | null;
  MediaUrl?: string | null;
  MediaUrls?: readonly (string | null | undefined)[] | null;
  MediaType?: string | null;
  MediaTypes?: readonly (string | null | undefined)[] | null;
  MediaWorkspaceDir?: string | null;
};

function normalizeOptionalText(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizeTranscriptText(value: string | null | undefined): string {
  return value ?? "";
}

const CHANNEL_MEDIA_PLACEHOLDER_PATTERN = /^<media:[a-z0-9_-]+>(?:\s+\([^)]*\))?$/i;

// Select text for persisted user turns. Channel-generated media placeholders
// are dropped only when structured media is present, keeping plain text intact.
export function resolvePersistedUserTurnText(
  value: string | null | undefined,
  options: ResolvePersistedUserTurnTextOptions = {},
): string | undefined {
  const normalized = normalizeOptionalText(value);
  if (!normalized) {
    return undefined;
  }
  if (options.hasMedia === true && CHANNEL_MEDIA_PLACEHOLDER_PATTERN.test(normalized)) {
    return undefined;
  }
  return normalized;
}

function mediaTypeForTranscript(media: PersistedUserTurnMediaInput): string {
  return (
    normalizeOptionalText(media.contentType) ??
    normalizeOptionalText(media.kind) ??
    "application/octet-stream"
  );
}

function normalizeMediaEntryForTranscript(media: PersistedUserTurnMediaInput):
  | {
      path: string;
      type: string;
    }
  | undefined {
  const pathLocal = normalizeOptionalText(media.path) ?? normalizeOptionalText(media.url);
  if (!pathLocal) {
    return undefined;
  }
  return {
    path: pathLocal,
    type: mediaTypeForTranscript(media),
  };
}

function normalizeOptionalTextArray(
  values: readonly (string | null | undefined)[] | null | undefined,
): (string | undefined)[] {
  // Map each entry to a normalized string or undefined — do NOT compact with
  // .filter(Boolean). The writer pads holes with "" to keep parallel Media*
  // arrays (MediaPaths / MediaUrls / MediaTypes) index-aligned, so compaction
  // here would shift later entries onto the wrong attachment.
  return values?.map(normalizeOptionalText) ?? [];
}

const URL_LIKE_MEDIA_PATH_PATTERN = /^[a-z][a-z0-9+.-]*:/i;

function resolveTranscriptMediaPath(pathValue: string, workspaceDir: string | undefined): string {
  // Relative staged media paths are anchored to the media workspace; absolute
  // paths and URL-like refs are already stable transcript references.
  if (!workspaceDir || path.isAbsolute(pathValue) || URL_LIKE_MEDIA_PATH_PATTERN.test(pathValue)) {
    return pathValue;
  }
  return path.join(workspaceDir, pathValue);
}

function resolveTranscriptMediaType(params: {
  explicitType: string | undefined;
  mediaPath: string | undefined;
  mediaUrl: string | undefined;
}): string | undefined {
  return params.explicitType ?? mimeTypeFromFilePath(params.mediaPath ?? params.mediaUrl);
}

export function buildPersistedUserTurnMediaInputsFromFields(
  fields: PersistedUserTurnMediaFieldSource | PersistedUserTurnMessage | null | undefined,
): PersistedUserTurnMediaInput[] {
  if (!fields) {
    return [];
  }

  const mediaFields = fields as PersistedUserTurnMediaFieldSource;
  const paths = normalizeOptionalTextArray(mediaFields.MediaPaths);
  const urls = normalizeOptionalTextArray(mediaFields.MediaUrls);
  const types = normalizeOptionalTextArray(mediaFields.MediaTypes);
  const singlePath = normalizeOptionalText(mediaFields.MediaPath);
  const singleUrl = normalizeOptionalText(mediaFields.MediaUrl);
  const singleType = normalizeOptionalText(mediaFields.MediaType);
  const workspaceDir = normalizeOptionalText(mediaFields.MediaWorkspaceDir);
  const mediaCount = Math.max(paths.length, urls.length, singlePath || singleUrl ? 1 : 0);
  const media: PersistedUserTurnMediaInput[] = [];

  for (let index = 0; index < mediaCount; index += 1) {
    const rawPath = paths[index] ?? (index === 0 ? singlePath : undefined);
    const mediaPath = rawPath ? resolveTranscriptMediaPath(rawPath, workspaceDir) : undefined;
    const url = urls[index] ?? (index === 0 ? singleUrl : undefined);
    if (!mediaPath && !url) {
      continue;
    }
    media.push({
      ...(mediaPath ? { path: mediaPath } : {}),
      ...(url ? { url } : {}),
      contentType: resolveTranscriptMediaType({
        explicitType: types[index] ?? (index === 0 ? singleType : undefined),
        mediaPath,
        mediaUrl: url,
      }),
    });
  }

  return media;
}

function buildPersistedUserTurnMediaFields(
  media: readonly PersistedUserTurnMediaInput[] | null | undefined,
): PersistedUserTurnMediaFields {
  const entries = Array.isArray(media) ? media : [];
  const normalized = entries
    .map(normalizeMediaEntryForTranscript)
    .filter((entry): entry is { path: string; type: string } => entry !== undefined);
  const paths = normalized.map((entry) => entry.path);
  if (paths.length === 0) {
    return {};
  }
  const types = normalized.map((entry) => entry.type);
  return {
    MediaPath: paths[0],
    MediaPaths: paths,
    MediaType: types[0],
    MediaTypes: types,
  };
}

function buildUserTurnSenderMeta(
  sender: UserTurnInput["sender"],
): Record<string, string> | undefined {
  const senderId = normalizeOptionalText(sender?.id);
  const senderName = normalizeOptionalText(sender?.name);
  const senderUsername = normalizeOptionalText(sender?.username);
  if (!senderId && !senderName && !senderUsername) {
    return undefined;
  }
  return {
    ...(senderId ? { senderId } : {}),
    ...(senderName ? { senderName } : {}),
    ...(senderUsername ? { senderUsername } : {}),
  };
}

function readOpenClawMessageMeta(message: AgentMessage): Record<string, unknown> | undefined {
  const meta = (message as unknown as Record<string, unknown>)["__openclaw"];
  return meta && typeof meta === "object" && !Array.isArray(meta)
    ? (meta as Record<string, unknown>)
    : undefined;
}

export function buildPersistedUserTurnMessage(params: UserTurnInput): PersistedUserTurnMessage {
  const mediaFields = buildPersistedUserTurnMediaFields(params.media);
  const hasMedia = Boolean(mediaFields.MediaPath);
  const text = normalizeTranscriptText(params.text);
  // Storage is BARE (no timestamp prefix). The per-message timestamp is added
  // at the single LLM-boundary stamping site (normalizeMessagesForLlmBoundary),
  // derived from each message's own `timestamp` field, so the current turn and
  // every historical turn serialize identically on the wire. Persisting a stamp
  // here would NOT match the bare-current arrival (the gateway no longer stamps
  // the live turn) — see https://github.com/openclaw/openclaw/issues/3658.
  const content = text || (hasMedia ? (params.mediaOnlyText ?? "") : "");
  const senderMeta = buildUserTurnSenderMeta(params.sender);
  const openClawMeta = {
    ...(params.senderIsOwner === undefined ? {} : { senderIsOwner: params.senderIsOwner }),
    ...senderMeta,
  };
  const message = {
    role: "user",
    content,
    timestamp: params.timestamp ?? Date.now(),
    ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
    ...mediaFields,
    ...(Object.keys(openClawMeta).length > 0 ? { __openclaw: openClawMeta } : {}),
  } as PersistedUserTurnMessage;
  return applyInputProvenanceToUserMessage(message, params.provenance) as PersistedUserTurnMessage;
}

function resolvePersistedUserTurnMessage(
  params: Pick<AppendUserTurnTranscriptMessageParams, "input" | "message">,
): PersistedUserTurnMessage | undefined {
  if (params.message) {
    return params.message;
  }
  if (!params.input) {
    return undefined;
  }
  return buildPersistedUserTurnMessage(params.input);
}

function isUserMessage(message: AgentMessage): message is PersistedUserTurnMessage {
  return (message as { role?: unknown }).role === "user";
}

function buildLateResolvedMediaMessage(params: {
  admittedMessage?: PersistedUserTurnMessage;
  resolvedMessage: PersistedUserTurnMessage;
}): PersistedUserTurnMessage | undefined {
  const admittedMedia = buildPersistedUserTurnMediaInputsFromFields(params.admittedMessage);
  const resolvedMedia = buildPersistedUserTurnMediaInputsFromFields(params.resolvedMessage);
  if (
    resolvedMedia.length === 0 ||
    JSON.stringify(resolvedMedia) === JSON.stringify(admittedMedia)
  ) {
    return undefined;
  }
  const resolved = params.resolvedMessage as unknown as Record<string, unknown>;
  const admittedContent = params.admittedMessage?.content;
  const resolvedContent = params.resolvedMessage.content;
  const mediaOnlyText = resolvedMedia
    .map((media) => media.path ?? media.url)
    .filter((value): value is string => Boolean(value))
    .map((value) => `[media attached: ${value}]`)
    .join("\n");
  const content =
    typeof resolvedContent === "string" && resolvedContent === admittedContent
      ? mediaOnlyText
      : Array.isArray(resolvedContent) && typeof admittedContent === "string"
        ? (() => {
            const mediaContent = resolvedContent.filter(
              (block) =>
                !block ||
                typeof block !== "object" ||
                (block as { type?: unknown; text?: unknown }).type !== "text" ||
                (block as { text?: unknown }).text !== admittedContent,
            );
            return mediaContent.length > 0
              ? mediaContent
              : [{ type: "text" as const, text: mediaOnlyText }];
          })()
        : resolvedContent;
  const idempotencyKey =
    typeof resolved.idempotencyKey === "string" && resolved.idempotencyKey.length > 0
      ? `${resolved.idempotencyKey}:late-media`
      : `late-media:${typeof resolved.timestamp === "number" ? resolved.timestamp : Date.now()}`;
  return {
    ...resolved,
    content,
    idempotencyKey,
  } as unknown as PersistedUserTurnMessage;
}

function isBeforeAgentRunBlockedMessage(message: AgentMessage): boolean {
  const marker = (message as { __openclaw?: { beforeAgentRunBlocked?: unknown } })["__openclaw"]
    ?.beforeAgentRunBlocked;
  return marker !== undefined;
}

function userMessageHasImageContent(message: AgentMessage): boolean {
  return (
    isUserMessage(message) &&
    Array.isArray(message.content) &&
    message.content.some(
      (block) =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "image",
    )
  );
}

// Runtime messages may lack transcript metadata because channel adapters prepare
// display text separately. Merge only safe user messages, never block markers.
export function mergePreparedUserTurnMessageForRuntime(params: {
  runtimeMessage: AgentMessage;
  preparedMessage?: PersistedUserTurnMessage;
}): AgentMessage {
  if (
    !params.preparedMessage ||
    !isUserMessage(params.runtimeMessage) ||
    isBeforeAgentRunBlockedMessage(params.runtimeMessage)
  ) {
    return params.runtimeMessage;
  }
  const runtimeMessage = params.runtimeMessage as unknown as Record<string, unknown>;
  const preparedMessage = params.preparedMessage as unknown as Record<string, unknown>;
  const runtimeMeta = readOpenClawMessageMeta(params.runtimeMessage);
  const preparedMeta = readOpenClawMessageMeta(params.preparedMessage);
  return {
    ...runtimeMessage,
    ...preparedMessage,
    ...(preparedMeta ? { __openclaw: { ...runtimeMeta, ...preparedMeta } } : {}),
    ...(userMessageHasImageContent(params.runtimeMessage)
      ? { content: params.runtimeMessage.content }
      : {}),
  } as unknown as AgentMessage;
}

/** Restores only auth state that write hooks must not be able to forge or erase. */
export function restorePreparedUserTurnOperationalMetaForRuntime(params: {
  runtimeMessage: AgentMessage;
  preparedMessage?: PersistedUserTurnMessage;
}): AgentMessage {
  if (!params.preparedMessage || !isUserMessage(params.runtimeMessage)) {
    return params.runtimeMessage;
  }
  const preparedMeta = readOpenClawMessageMeta(params.preparedMessage);
  const senderIsOwner = preparedMeta?.senderIsOwner;
  if (typeof senderIsOwner !== "boolean") {
    return params.runtimeMessage;
  }
  return {
    ...(params.runtimeMessage as unknown as Record<string, unknown>),
    __openclaw: { ...readOpenClawMessageMeta(params.runtimeMessage), senderIsOwner },
  } as unknown as AgentMessage;
}

/** Applies before-message hooks while preserving user-turn transcript metadata. */
export function preparePersistedUserTurnMessageForTranscriptWrite(
  message: PersistedUserTurnMessage,
  params: Pick<
    AppendUserTurnTranscriptMessageParams,
    "agentId" | "sessionKey" | "beforeMessageWrite"
  >,
): PersistedUserTurnMessage | undefined {
  if (!params.beforeMessageWrite) {
    return message;
  }
  const originalMessage = message as unknown as { idempotencyKey?: unknown };
  const idempotencyKey =
    typeof originalMessage.idempotencyKey === "string" ? originalMessage.idempotencyKey : undefined;
  const provenance = normalizeInputProvenance(
    (message as unknown as { provenance?: unknown }).provenance,
  );
  const senderIsOwner = readOpenClawMessageMeta(message)?.senderIsOwner;
  const nextMessage = params.beforeMessageWrite({
    message,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
  });
  if (nextMessage?.role !== "user") {
    return undefined;
  }
  const nextUserMessage = provenance
    ? (applyInputProvenanceToUserMessage(nextMessage, provenance) as PersistedUserTurnMessage)
    : nextMessage;
  if (!idempotencyKey && typeof senderIsOwner !== "boolean") {
    return nextUserMessage;
  }
  return {
    ...(nextUserMessage as unknown as Record<string, unknown>),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(typeof senderIsOwner === "boolean"
      ? {
          __openclaw: {
            ...readOpenClawMessageMeta(nextUserMessage),
            senderIsOwner,
          },
        }
      : {}),
  } as unknown as PersistedUserTurnMessage;
}

export async function appendUserTurnTranscriptMessage(
  params: AppendUserTurnTranscriptMessageParams,
): Promise<
  | {
      sessionFile: string;
      messageId: string;
      message: PersistedUserTurnMessage;
    }
  | undefined
> {
  const resolvedMessage = resolvePersistedUserTurnMessage(params);
  if (!resolvedMessage) {
    return undefined;
  }

  const turn = await persistSessionTranscriptTurn(
    {
      sessionFile: params.transcriptPath,
      sessionKey: params.sessionKey ?? "",
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    },
    {
      ...(params.cwd ? { cwd: params.cwd } : {}),
      ...(params.config ? { config: params.config } : {}),
      updateMode: params.updateMode ?? "inline",
      messages: [
        {
          message: resolvedMessage,
          idempotencyLookup: "scan",
          prepareMessageAfterIdempotencyCheck: (message) =>
            preparePersistedUserTurnMessageForTranscriptWrite(
              message as PersistedUserTurnMessage,
              params,
            ),
        },
      ],
    },
  );
  const appended = turn.messages[0] as
    | {
        messageId: string;
        message: PersistedUserTurnMessage;
      }
    | undefined;
  if (!appended) {
    return undefined;
  }

  return {
    sessionFile: params.transcriptPath,
    messageId: appended.messageId,
    message: appended.message,
  };
}

// Store-backed persistence resolves the current session transcript file lazily
// so callers can pass a session entry/store without knowing the final path.
export async function persistUserTurnTranscript(
  params: PersistUserTurnTranscriptParams,
): Promise<UserTurnTranscriptPersistResult | undefined> {
  const message = resolvePersistedUserTurnMessage(params);
  if (!message) {
    return undefined;
  }

  const turn = await persistSessionTranscriptTurn(
    {
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      sessionEntry: params.sessionEntry,
      ...(params.sessionStore ? { sessionStore: params.sessionStore } : {}),
      ...(params.storePath ? { storePath: params.storePath } : {}),
      agentId: params.agentId,
      ...(params.threadId !== undefined ? { threadId: params.threadId } : {}),
    },
    {
      ...(params.cwd ? { cwd: params.cwd } : {}),
      ...(params.config ? { config: params.config as OpenClawConfig } : {}),
      updateMode: params.updateMode ?? "inline",
      messages: [
        {
          message,
          idempotencyLookup: "scan",
          prepareMessageAfterIdempotencyCheck: (candidate) =>
            preparePersistedUserTurnMessageForTranscriptWrite(
              candidate as PersistedUserTurnMessage,
              params,
            ),
        },
      ],
    },
  );
  const appended = turn.messages[0] as
    | {
        messageId: string;
        message: PersistedUserTurnMessage;
      }
    | undefined;
  if (!appended) {
    return undefined;
  }

  return {
    ...appended,
    sessionEntry: turn.sessionEntry,
    sessionFile: turn.sessionFile,
  };
}

async function appendFileTargetUserTurnTranscript(params: {
  target: UserTurnTranscriptFileTarget;
  message: PersistedUserTurnMessage;
  updateMode: UserTurnTranscriptUpdateMode;
  beforeMessageWrite?: UserTurnBeforeMessageWrite;
}): Promise<UserTurnTranscriptPersistResult | undefined> {
  const { config, ...target } = params.target;
  const appended = await appendUserTurnTranscriptMessage({
    ...target,
    message: params.message,
    updateMode: params.updateMode,
    ...(config ? { config: config as OpenClawConfig } : {}),
    ...(params.beforeMessageWrite ? { beforeMessageWrite: params.beforeMessageWrite } : {}),
  });
  return appended
    ? {
        ...appended,
        sessionEntry: undefined,
      }
    : undefined;
}

async function resolveUserTurnTranscriptTarget(
  target: UserTurnTranscriptTargetResolver,
): Promise<UserTurnTranscriptTarget | undefined> {
  return typeof target === "function" ? await target() : target;
}

function isUserTurnTranscriptFileTarget(
  target: UserTurnTranscriptTarget,
): target is UserTurnTranscriptFileTarget {
  return "transcriptPath" in target;
}

export function createUserTurnTranscriptRecorder(
  params: CreateUserTurnTranscriptRecorderParams,
): UserTurnTranscriptRecorder {
  const message = resolvePersistedUserTurnMessage(params);
  let blocked = false;
  let persisted = false;
  let persistedResult: UserTurnTranscriptPersistResult | undefined;
  let runtimePersistencePromise: Promise<void> | undefined;
  let selfPersistencePromise: Promise<UserTurnTranscriptPersistResult | undefined> | undefined;
  let resolvedMessagePromise: Promise<PersistedUserTurnMessage | undefined> | undefined;
  let persistedMessageNotified = false;
  let runtimePersistedMessage: PersistedUserTurnMessage | undefined;
  let sentToProvider = false;
  let resolvedBeforeProvider = false;

  const handlePersistenceError = (error: unknown) => {
    if (params.onPersistenceError) {
      params.onPersistenceError(error);
      return;
    }
    void import("../globals.js")
      .then(({ logVerbose }) => {
        logVerbose(
          `failed to persist ${params.errorContext ?? "user turn transcript"}: ${String(error)}`,
        );
      })
      .catch(() => undefined);
  };

  const resolveMessageForPersistence = async (): Promise<PersistedUserTurnMessage | undefined> => {
    if (params.message) {
      return params.message;
    }
    if (!params.resolveInput) {
      return message;
    }
    if (!resolvedMessagePromise) {
      resolvedMessagePromise = (async () => {
        try {
          const resolvedInput = await params.resolveInput?.();
          const resolvedMessage =
            resolvePersistedUserTurnMessage({
              message: params.message,
              input: resolvedInput ?? params.input,
            }) ?? message;
          resolvedBeforeProvider = !sentToProvider;
          return resolvedMessage;
        } catch (error) {
          handlePersistenceError(error);
          return message;
        }
      })();
    }
    return await resolvedMessagePromise;
  };

  const notifyMessagePersisted = (persistedMessage?: PersistedUserTurnMessage) => {
    const notificationMessage = persistedMessage ?? persistedResult?.message ?? message;
    if (!notificationMessage || persistedMessageNotified || !params.onMessagePersisted) {
      return;
    }
    persistedMessageNotified = true;
    try {
      void Promise.resolve(params.onMessagePersisted(notificationMessage)).catch(
        handlePersistenceError,
      );
    } catch (error) {
      handlePersistenceError(error);
    }
  };

  const waitForRuntimePersistence = async () => {
    if (!runtimePersistencePromise) {
      return;
    }
    try {
      await runtimePersistencePromise;
    } catch (error) {
      handlePersistenceError(error);
    }
  };

  const persistPrepared = async (options: {
    waitForRuntime: boolean;
    skipWhenBlocked: boolean;
    target?: UserTurnTranscriptTargetResolver;
    updateMode?: UserTurnTranscriptUpdateMode;
  }): Promise<UserTurnTranscriptPersistResult | undefined> => {
    if (options.skipWhenBlocked && blocked) {
      return undefined;
    }
    if (!message && !params.resolveInput) {
      return undefined;
    }
    if (options.waitForRuntime) {
      // Approved persistence waits for runtime-owned writes first to avoid
      // duplicate user turns when the harness already persisted the message.
      await waitForRuntimePersistence();
    }
    if (selfPersistencePromise) {
      return await selfPersistencePromise;
    }
    selfPersistencePromise = (async () => {
      const resolvedMessage = await resolveMessageForPersistence();
      if (!resolvedMessage) {
        return undefined;
      }
      const target = await resolveUserTurnTranscriptTarget(options.target ?? params.target);
      if (!target) {
        return undefined;
      }
      const updateMode = options.updateMode ?? params.updateMode ?? "inline";
      const persistMessage = async (
        candidate: PersistedUserTurnMessage,
        candidateUpdateMode: UserTurnTranscriptUpdateMode,
      ) =>
        isUserTurnTranscriptFileTarget(target)
          ? await appendFileTargetUserTurnTranscript({
              target,
              message: candidate,
              updateMode: candidateUpdateMode,
              beforeMessageWrite: params.beforeMessageWrite,
            })
          : await persistUserTurnTranscript({
              ...target,
              message: candidate,
              updateMode: candidateUpdateMode,
              ...(params.beforeMessageWrite
                ? { beforeMessageWrite: params.beforeMessageWrite }
                : {}),
            });
      const lateMediaMessage =
        sentToProvider && !resolvedBeforeProvider
          ? buildLateResolvedMediaMessage({
              admittedMessage: runtimePersistedMessage ?? message,
              resolvedMessage,
            })
          : undefined;
      if (lateMediaMessage) {
        // The admitted bytes already crossed the LLM boundary. Persisting media as a
        // second turn preserves that prefix; inline replacement would thrash cache tail (#99495).
        if (!persisted && message) {
          const admittedResult = await persistMessage(message, updateMode);
          if (admittedResult) {
            persisted = true;
            persistedResult = admittedResult;
            notifyMessagePersisted(admittedResult.message);
          }
        }
        const appendedMedia = await persistMessage(lateMediaMessage, "none");
        if (appendedMedia) {
          persisted = true;
          persistedResult = appendedMedia;
        }
        return appendedMedia;
      }
      if (persisted) {
        return persistedResult;
      }
      const result = await persistMessage(resolvedMessage, updateMode);
      if (result) {
        persisted = true;
        persistedResult = result;
        notifyMessagePersisted(result.message);
      }
      return result;
    })();
    try {
      return await selfPersistencePromise;
    } catch (error) {
      handlePersistenceError(error);
      throw error;
    }
  };

  return {
    message,
    resolveMessage: resolveMessageForPersistence,
    markSentToProvider: () => {
      sentToProvider = true;
    },
    markRuntimePersistencePending: (pending) => {
      runtimePersistencePromise = pending;
    },
    markRuntimePersisted: (persistedMessage) => {
      persisted = true;
      runtimePersistedMessage = persistedMessage;
      if (persistedMessage && persistedResult) {
        persistedResult = {
          ...persistedResult,
          message: persistedMessage,
        };
      }
      notifyMessagePersisted(persistedMessage);
    },
    markBlocked: () => {
      blocked = true;
    },
    hasPersisted: () => persisted,
    isBlocked: () => blocked,
    hasRuntimePersistencePending: () => runtimePersistencePromise !== undefined,
    waitForRuntimePersistence,
    persistApproved: async (options) =>
      await persistPrepared({
        waitForRuntime: false,
        skipWhenBlocked: true,
        target: options?.target,
        updateMode: options?.updateMode,
      }),
    persistFallback: async (options) =>
      await persistPrepared({
        waitForRuntime: true,
        skipWhenBlocked: true,
        target: options?.target,
        updateMode: options?.updateMode,
      }),
  };
}
