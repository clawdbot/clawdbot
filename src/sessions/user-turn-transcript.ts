import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { appendSessionTranscriptMessage } from "../config/sessions/transcript-append.js";
import { mimeTypeFromFilePath } from "../media/mime.js";
import {
  applyInputProvenanceToUserMessage,
  type InputProvenance,
  normalizeInputProvenance,
} from "./input-provenance.js";
import { emitSessionTranscriptUpdate } from "./transcript-events.js";

type TranscriptAppendConfig = Parameters<typeof appendSessionTranscriptMessage>[0]["config"];

type UserTurnSessionEntry = {
  sessionId: string;
  updatedAt: number;
  sessionFile?: string;
  threadId?: string | number;
} & Record<string, unknown>;

type PersistedUserTurnMediaInput = {
  path?: string | null;
  url?: string | null;
  contentType?: string | null;
  kind?: string | null;
};

type PersistedUserTurnMediaFields = {
  MediaPath?: string;
  MediaPaths?: string[];
  MediaType?: string;
  MediaTypes?: string[];
};

export type PersistedUserTurnMessage = Extract<AgentMessage, { role: "user" }>;

export type UserTurnInput = {
  text?: string | null;
  media?: readonly PersistedUserTurnMediaInput[] | null;
  timestamp?: number;
  idempotencyKey?: string;
  provenance?: InputProvenance;
  mediaOnlyText?: string;
};

type UserTurnTranscriptUpdateMode = "inline" | "none";

export type UserTurnBeforeMessageWrite = (params: {
  message: PersistedUserTurnMessage;
  agentId?: string;
  sessionKey?: string;
}) => AgentMessage | null;

type AppendUserTurnTranscriptMessageParams = {
  transcriptPath: string;
  input?: UserTurnInput;
  message?: PersistedUserTurnMessage;
  sessionId?: string;
  agentId?: string;
  sessionKey?: string;
  cwd?: string;
  config?: TranscriptAppendConfig;
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
  config?: TranscriptAppendConfig;
  updateMode?: UserTurnTranscriptUpdateMode;
  beforeMessageWrite?: UserTurnBeforeMessageWrite;
};

type UserTurnTranscriptPersistenceTarget = Omit<
  PersistUserTurnTranscriptParams,
  "input" | "message" | "updateMode"
>;

type UserTurnTranscriptFileTarget = {
  transcriptPath: string;
  sessionId?: string;
  agentId?: string;
  sessionKey?: string;
  cwd?: string;
  config?: TranscriptAppendConfig;
};

type UserTurnTranscriptTarget = UserTurnTranscriptPersistenceTarget | UserTurnTranscriptFileTarget;

type UserTurnTranscriptPersistResult = {
  sessionFile: string;
  sessionEntry: UserTurnSessionEntry | undefined;
  messageId: string;
  message: PersistedUserTurnMessage;
};

type UserTurnTranscriptTargetResolver =
  | UserTurnTranscriptTarget
  | (() => UserTurnTranscriptTarget | undefined | Promise<UserTurnTranscriptTarget | undefined>);

type UserTurnInputResolver = () => UserTurnInput | undefined | Promise<UserTurnInput | undefined>;

export type UserTurnTranscriptRecorder = {
  readonly message: PersistedUserTurnMessage | undefined;
  resolveMessage: () => Promise<PersistedUserTurnMessage | undefined>;
  markRuntimePersistencePending: (pending: Promise<void>) => void;
  markRuntimePersisted: (message?: PersistedUserTurnMessage) => void;
  markBlocked: () => void;
  hasPersisted: () => boolean;
  isBlocked: () => boolean;
  hasRuntimePersistencePending: () => boolean;
  waitForRuntimePersistence: () => Promise<void>;
  persistApproved: (params?: {
    target?: UserTurnTranscriptTargetResolver;
    updateMode?: UserTurnTranscriptUpdateMode;
  }) => Promise<UserTurnTranscriptPersistResult | undefined>;
  persistFallback: (params?: {
    target?: UserTurnTranscriptTargetResolver;
    updateMode?: UserTurnTranscriptUpdateMode;
  }) => Promise<UserTurnTranscriptPersistResult | undefined>;
};

type CreateUserTurnTranscriptRecorderParams = {
  input?: UserTurnInput;
  message?: PersistedUserTurnMessage;
  resolveInput?: UserTurnInputResolver;
  target: UserTurnTranscriptTargetResolver;
  updateMode?: UserTurnTranscriptUpdateMode;
  beforeMessageWrite?: UserTurnBeforeMessageWrite;
  errorContext?: string;
  onPersistenceError?: (error: unknown) => void;
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
  const path = normalizeOptionalText(media.path) ?? normalizeOptionalText(media.url);
  if (!path) {
    return undefined;
  }
  return {
    path,
    type: mediaTypeForTranscript(media),
  };
}

function normalizeOptionalTextArray(
  values: readonly (string | null | undefined)[] | null | undefined,
): string[] {
  return (
    values?.map(normalizeOptionalText).filter((value): value is string => Boolean(value)) ?? []
  );
}

const URL_LIKE_MEDIA_PATH_PATTERN = /^[a-z][a-z0-9+.-]*:/i;

function resolveTranscriptMediaPath(pathValue: string, workspaceDir: string | undefined): string {
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
  fields: PersistedUserTurnMediaFieldSource | null | undefined,
): PersistedUserTurnMediaInput[] {
  if (!fields) {
    return [];
  }

  const paths = normalizeOptionalTextArray(fields.MediaPaths);
  const urls = normalizeOptionalTextArray(fields.MediaUrls);
  const types = normalizeOptionalTextArray(fields.MediaTypes);
  const singlePath = normalizeOptionalText(fields.MediaPath);
  const singleUrl = normalizeOptionalText(fields.MediaUrl);
  const singleType = normalizeOptionalText(fields.MediaType);
  const workspaceDir = normalizeOptionalText(fields.MediaWorkspaceDir);
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

function buildPersistedUserTurnMessage(params: UserTurnInput): PersistedUserTurnMessage {
  const mediaFields = buildPersistedUserTurnMediaFields(params.media);
  const hasMedia = Boolean(mediaFields.MediaPath);
  const text = normalizeTranscriptText(params.text);
  const content = text || (hasMedia ? (params.mediaOnlyText ?? "") : "");
  const message = {
    role: "user",
    content,
    timestamp: params.timestamp ?? Date.now(),
    ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
    ...mediaFields,
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

function isBeforeAgentRunBlockedMessage(message: AgentMessage): boolean {
  const marker = (message as { __openclaw?: { beforeAgentRunBlocked?: unknown } })["__openclaw"]
    ?.beforeAgentRunBlocked;
  return marker !== undefined;
}

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
  return {
    ...(params.runtimeMessage as unknown as Record<string, unknown>),
    ...(params.preparedMessage as unknown as Record<string, unknown>),
  } as unknown as AgentMessage;
}

function applyBeforeMessageWriteToUserTurn(
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
  return idempotencyKey
    ? ({
        ...(nextUserMessage as unknown as Record<string, unknown>),
        idempotencyKey,
      } as unknown as PersistedUserTurnMessage)
    : nextUserMessage;
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

  const appended = await appendSessionTranscriptMessage({
    transcriptPath: params.transcriptPath,
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    ...(params.cwd ? { cwd: params.cwd } : {}),
    ...(params.config ? { config: params.config } : {}),
    message: resolvedMessage,
    idempotencyLookup: "scan",
    prepareMessageAfterIdempotencyCheck: (message) =>
      applyBeforeMessageWriteToUserTurn(message, params),
  });
  if (!appended) {
    return undefined;
  }

  switch (params.updateMode ?? "inline") {
    case "inline":
      if (appended.appended) {
        emitSessionTranscriptUpdate({
          sessionFile: params.transcriptPath,
          ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
          message: appended.message,
          messageId: appended.messageId,
        });
      }
      break;
    case "none":
      break;
  }

  return {
    sessionFile: params.transcriptPath,
    messageId: appended.messageId,
    message: appended.message,
  };
}

export async function persistUserTurnTranscript(
  params: PersistUserTurnTranscriptParams,
): Promise<UserTurnTranscriptPersistResult | undefined> {
  const message = resolvePersistedUserTurnMessage(params);
  if (!message) {
    return undefined;
  }

  const { resolveSessionTranscriptFile } = await import("../config/sessions/transcript.js");
  const { sessionFile, sessionEntry } = await resolveSessionTranscriptFile({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    sessionEntry: params.sessionEntry,
    ...(params.sessionStore ? { sessionStore: params.sessionStore } : {}),
    ...(params.storePath ? { storePath: params.storePath } : {}),
    agentId: params.agentId,
    ...(params.threadId !== undefined ? { threadId: params.threadId } : {}),
  });

  const appended = await appendUserTurnTranscriptMessage({
    transcriptPath: sessionFile,
    message,
    sessionId: params.sessionId,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    ...(params.cwd ? { cwd: params.cwd } : {}),
    ...(params.config ? { config: params.config } : {}),
    ...(params.updateMode ? { updateMode: params.updateMode } : {}),
    ...(params.beforeMessageWrite ? { beforeMessageWrite: params.beforeMessageWrite } : {}),
  });
  if (!appended) {
    return undefined;
  }

  return {
    ...appended,
    sessionEntry,
  };
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
          return (
            resolvePersistedUserTurnMessage({
              message: params.message,
              input: resolvedInput ?? params.input,
            }) ?? message
          );
        } catch (error) {
          handlePersistenceError(error);
          return message;
        }
      })();
    }
    return await resolvedMessagePromise;
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
    if (persisted) {
      return persistedResult;
    }
    if (options.skipWhenBlocked && blocked) {
      return undefined;
    }
    if (!message && !params.resolveInput) {
      return undefined;
    }
    if (options.waitForRuntime) {
      await waitForRuntimePersistence();
      if (persisted) {
        return persistedResult;
      }
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
      const result = isUserTurnTranscriptFileTarget(target)
        ? await appendUserTurnTranscriptMessage({
            ...target,
            message: resolvedMessage,
            updateMode,
            ...(params.beforeMessageWrite ? { beforeMessageWrite: params.beforeMessageWrite } : {}),
          }).then((appended) =>
            appended
              ? {
                  ...appended,
                  sessionEntry: undefined,
                }
              : undefined,
          )
        : await persistUserTurnTranscript({
            ...target,
            message: resolvedMessage,
            updateMode,
            ...(params.beforeMessageWrite ? { beforeMessageWrite: params.beforeMessageWrite } : {}),
          });
      if (result) {
        persisted = true;
        persistedResult = result;
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
    markRuntimePersistencePending: (pending) => {
      runtimePersistencePromise = pending;
    },
    markRuntimePersisted: (persistedMessage) => {
      persisted = true;
      if (persistedMessage && persistedResult) {
        persistedResult = {
          ...persistedResult,
          message: persistedMessage,
        };
      }
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
