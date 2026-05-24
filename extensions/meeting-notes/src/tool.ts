import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  getMeetingNotesSourceProvider,
  listMeetingNotesSourceProviders,
  type MeetingNotesSessionDescriptor,
  type MeetingNotesSourceLocator,
} from "openclaw/plugin-sdk/meeting-notes";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginService,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
import { type MeetingNotesAutoStartConfig, resolveMeetingNotesConfig } from "./config.js";
import { manualTranscriptSourceProvider } from "./manual-source.js";
import { MeetingNotesStore, type MeetingNotesSessionEntry } from "./store.js";
import { summarizeMeetingNotes } from "./summary.js";

type ActiveMeetingNotesSession = {
  session: MeetingNotesSessionDescriptor;
  providerId: string;
};

const activeSessions = new Map<string, ActiveMeetingNotesSession>();
const AUTO_START_RETRY_ATTEMPTS = 12;
const AUTO_START_RETRY_MS = 5_000;
const AUTO_START_STOP_TIMEOUT_MS = 5_000;
const AUTO_START_PROVIDER_READY_TIMEOUT_MS = 30_000;

function sameSessionIdentity(
  left: MeetingNotesSessionDescriptor,
  right: MeetingNotesSessionDescriptor,
): boolean {
  return left.sessionId === right.sessionId && left.startedAt === right.startedAt;
}

function asParamsRecord(params: unknown): Record<string, unknown> {
  return params && typeof params === "object" && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : {};
}

function readStringParam(
  params: Record<string, unknown>,
  key: string,
  options: { required: true; trim?: boolean },
): string;
function readStringParam(
  params: Record<string, unknown>,
  key: string,
  options?: { required?: false; trim?: boolean },
): string | undefined;
function readStringParam(
  params: Record<string, unknown>,
  key: string,
  options: { required?: boolean; trim?: boolean } = {},
): string | undefined {
  const value = params[key];
  if (typeof value !== "string") {
    if (options.required) {
      throw new Error(`${key} required`);
    }
    return undefined;
  }
  const normalized = options.trim === false ? value : value.trim();
  if (!normalized && options.required) {
    throw new Error(`${key} required`);
  }
  return normalized || undefined;
}

const MeetingNotesSchema = Type.Object(
  {
    action: Type.String({
      description: "start, stop, status, import, or summarize.",
    }),
    sessionId: Type.Optional(Type.String({ minLength: 1 })),
    title: Type.Optional(Type.String({ minLength: 1 })),
    providerId: Type.Optional(Type.String({ minLength: 1 })),
    accountId: Type.Optional(Type.String({ minLength: 1 })),
    guildId: Type.Optional(Type.String({ minLength: 1 })),
    channelId: Type.Optional(Type.String({ minLength: 1 })),
    meetingUrl: Type.Optional(Type.String({ minLength: 1 })),
    transcript: Type.Optional(Type.String({ minLength: 1 })),
    speakerLabel: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

function createSessionId(): string {
  return `meeting-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

function createStore(api: OpenClawPluginApi): MeetingNotesStore {
  return new MeetingNotesStore(path.join(api.runtime.state.resolveStateDir(), "meeting-notes"));
}

async function waitForPendingAutoStartsToSettle(
  pendingStarts: Set<Promise<void>>,
): Promise<boolean> {
  if (pendingStarts.size === 0) {
    return true;
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.allSettled(pendingStarts).then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), AUTO_START_STOP_TIMEOUT_MS);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function sourceFromParams(params: Record<string, unknown>): MeetingNotesSourceLocator {
  const providerId = readStringParam(params, "providerId", { trim: true }) ?? "manual-transcript";
  return {
    providerId,
    accountId: readStringParam(params, "accountId", { trim: true }),
    guildId: readStringParam(params, "guildId", { trim: true }),
    channelId: readStringParam(params, "channelId", { trim: true }),
    meetingUrl: readStringParam(params, "meetingUrl", { trim: true }),
  };
}

function resolveSourceProvider(providerId: string, api: OpenClawPluginApi) {
  return providerId === manualTranscriptSourceProvider.id
    ? manualTranscriptSourceProvider
    : getMeetingNotesSourceProvider(providerId, api.config);
}

function toolText(text: string, details?: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text }],
    details: details ?? {},
  };
}

async function summarizeAndPersist(params: {
  config: ReturnType<typeof resolveMeetingNotesConfig>;
  store: MeetingNotesStore;
  session: MeetingNotesSessionDescriptor;
  sessionDir?: string;
}) {
  const utterances =
    params.sessionDir !== undefined
      ? await params.store.readUtterancesFromSessionDir(params.sessionDir, {
          maxUtterances: params.config.maxUtterances,
        })
      : await params.store.readUtterancesForSession(params.session, {
          maxUtterances: params.config.maxUtterances,
        });
  const summary = summarizeMeetingNotes({ session: params.session, utterances });
  const summaryPath =
    params.sessionDir !== undefined
      ? await params.store.writeSummaryToDir(summary, params.sessionDir)
      : await params.store.writeSummary(summary, params.session);
  return { summary, summaryPath };
}

async function startMeetingNotes(params: {
  api: OpenClawPluginApi;
  store: MeetingNotesStore;
  rawParams: Record<string, unknown>;
  abortSignal?: AbortSignal;
  startupWaitMs?: number;
}) {
  if (params.abortSignal?.aborted) {
    throw new Error("meeting notes start aborted");
  }
  const source = sourceFromParams(params.rawParams);
  const provider = resolveSourceProvider(source.providerId, params.api);
  if (!provider?.start) {
    throw new Error(`meeting notes provider ${source.providerId} cannot start live capture`);
  }
  const session: MeetingNotesSessionDescriptor = {
    sessionId: readStringParam(params.rawParams, "sessionId", { trim: true }) ?? createSessionId(),
    title: readStringParam(params.rawParams, "title", { trim: true }),
    source,
    startedAt: new Date().toISOString(),
  };
  await params.store.writeSession(session);
  const result = await provider.start({
    cfg: params.api.config,
    session,
    abortSignal: params.abortSignal,
    startupWaitMs: params.startupWaitMs,
    onUtterance: (utterance) => params.store.appendUtteranceForSession(session, utterance),
  });
  if (!result.ok) {
    throw new Error(result.error);
  }
  if (params.abortSignal?.aborted) {
    await provider.stop?.({
      cfg: params.api.config,
      sessionId: session.sessionId,
      source: session.source,
      reason: "service-stop",
    });
    throw new Error("meeting notes start aborted");
  }
  activeSessions.set(session.sessionId, { session, providerId: provider.id });
  return toolText(`Meeting notes started: ${session.sessionId}`, {
    sessionId: session.sessionId,
    providerId: provider.id,
  });
}

async function stopMeetingNotes(params: {
  api: OpenClawPluginApi;
  store: MeetingNotesStore;
  rawParams: Record<string, unknown>;
}) {
  const sessionSelector = readStringParam(params.rawParams, "sessionId", {
    required: true,
    trim: true,
  });
  const directActive = activeSessions.get(sessionSelector);
  const resolvedEntry: MeetingNotesSessionEntry | undefined = directActive
    ? { session: directActive.session, sessionDir: params.store.sessionDir(directActive.session) }
    : await params.store.readSessionEntry(sessionSelector);
  const resolvedSession = resolvedEntry?.session;
  const activeCandidate =
    resolvedSession !== undefined ? activeSessions.get(resolvedSession.sessionId) : undefined;
  const activeMatchesResolved =
    activeCandidate !== undefined &&
    resolvedSession !== undefined &&
    sameSessionIdentity(activeCandidate.session, resolvedSession);
  const selectedActive = directActive ?? (activeMatchesResolved ? activeCandidate : undefined);
  const session = selectedActive?.session ?? resolvedSession;
  if (!session) {
    throw new Error(`meeting notes session not found: ${sessionSelector}`);
  }
  const sessionId = session.sessionId;
  const providerId = selectedActive?.providerId ?? session.source.providerId;
  const provider = resolveSourceProvider(providerId, params.api);
  let providerStopError: string | undefined;
  if (selectedActive && provider?.stop) {
    const result = await provider.stop({
      cfg: params.api.config,
      sessionId,
      source: session.source,
      reason: "tool-stop",
    });
    if (!result.ok) {
      providerStopError = result.error;
    }
  }
  const stoppedAt = new Date().toISOString();
  if (selectedActive) {
    activeSessions.delete(sessionId);
  }
  const stoppedSession: MeetingNotesSessionDescriptor = {
    ...session,
    stoppedAt,
    ...(providerStopError
      ? {
          metadata: {
            ...session.metadata,
            providerStopError,
            providerStopFailedAt: stoppedAt,
          },
        }
      : {}),
  };
  if (selectedActive) {
    await params.store.writeSession(stoppedSession);
  } else {
    await params.store.updateStopped(sessionSelector, stoppedAt);
  }
  const { summaryPath, summary } = await summarizeAndPersist({
    config: resolveMeetingNotesConfig(params.api.pluginConfig),
    store: params.store,
    session: stoppedSession,
    sessionDir: selectedActive ? undefined : resolvedEntry?.sessionDir,
  });
  return toolText(`Meeting notes stopped: ${sessionId}\nSummary: ${summaryPath}`, {
    sessionId,
    ...(providerStopError ? { providerStopError } : {}),
    summary,
    summaryPath,
  });
}

async function importMeetingNotes(params: {
  api: OpenClawPluginApi;
  store: MeetingNotesStore;
  rawParams: Record<string, unknown>;
}) {
  const source = sourceFromParams(params.rawParams);
  const provider = resolveSourceProvider(source.providerId, params.api);
  if (!provider?.importTranscript) {
    throw new Error(`meeting notes provider ${source.providerId} cannot import transcripts`);
  }
  const session: MeetingNotesSessionDescriptor = {
    sessionId: readStringParam(params.rawParams, "sessionId", { trim: true }) ?? createSessionId(),
    title: readStringParam(params.rawParams, "title", { trim: true }),
    source,
    startedAt: new Date().toISOString(),
    stoppedAt: new Date().toISOString(),
  };
  const transcript = readStringParam(params.rawParams, "transcript", {
    required: true,
    trim: false,
  });
  await params.store.writeSession(session);
  const utterances = await provider.importTranscript({
    cfg: params.api.config,
    session,
    text: transcript,
    speakerLabel: readStringParam(params.rawParams, "speakerLabel", { trim: true }),
  });
  for (const utterance of utterances) {
    await params.store.appendUtteranceForSession(session, utterance);
  }
  const { summaryPath, summary } = await summarizeAndPersist({
    config: resolveMeetingNotesConfig(params.api.pluginConfig),
    store: params.store,
    session,
  });
  return toolText(`Meeting transcript imported: ${session.sessionId}\nSummary: ${summaryPath}`, {
    sessionId: session.sessionId,
    utteranceCount: utterances.length,
    summary,
    summaryPath,
  });
}

async function summarizeExisting(params: {
  config: ReturnType<typeof resolveMeetingNotesConfig>;
  store: MeetingNotesStore;
  rawParams: Record<string, unknown>;
}) {
  const sessionId = readStringParam(params.rawParams, "sessionId", {
    required: true,
    trim: true,
  });
  const entry = await params.store.readSessionEntry(sessionId);
  if (!entry) {
    throw new Error(`meeting notes session not found: ${sessionId}`);
  }
  const { summaryPath, summary } = await summarizeAndPersist({
    config: params.config,
    store: params.store,
    session: entry.session,
    sessionDir: entry.sessionDir,
  });
  return toolText(`Meeting notes summarized: ${sessionId}\nSummary: ${summaryPath}`, {
    sessionId,
    summary,
    summaryPath,
  });
}

async function statusMeetingNotes(api: OpenClawPluginApi) {
  const providers = [
    manualTranscriptSourceProvider.id,
    ...listMeetingNotesSourceProviders(api.config).map((provider) => provider.id),
  ].filter((value, index, values) => values.indexOf(value) === index);
  const active = [...activeSessions.values()].map((entry) => ({
    sessionId: entry.session.sessionId,
    providerId: entry.providerId,
    title: entry.session.title,
    source: entry.session.source,
  }));
  return toolText(
    [
      `Meeting notes providers: ${providers.length ? providers.join(", ") : "none"}`,
      `Active sessions: ${active.length}`,
    ].join("\n"),
    { providers, active },
  );
}

export function createMeetingNotesTool(
  api: OpenClawPluginApi,
  _ctx?: OpenClawPluginToolContext,
): AnyAgentTool {
  return {
    name: "meeting_notes",
    label: "Meeting Notes",
    description:
      "Start, stop, import, summarize, or inspect meeting notes from Discord, Google Meet, Slack huddles, and other meeting sources.",
    parameters: MeetingNotesSchema,
    async execute(_toolCallId, rawParams) {
      const config = resolveMeetingNotesConfig(api.pluginConfig);
      if (!config.enabled) {
        throw new Error("meeting notes plugin is disabled");
      }
      const params = asParamsRecord(rawParams);
      const action = readStringParam(params, "action", { required: true, trim: true });
      const store = createStore(api);
      switch (action) {
        case "start":
          return await startMeetingNotes({ api, store, rawParams: params });
        case "stop":
          return await stopMeetingNotes({ api, store, rawParams: params });
        case "import":
          return await importMeetingNotes({ api, store, rawParams: params });
        case "summarize":
          return await summarizeExisting({ config, store, rawParams: params });
        case "status":
          return await statusMeetingNotes(api);
        default:
          throw new Error(`unsupported meeting_notes action: ${action}`);
      }
    },
  };
}

export function createMeetingNotesAutoStartService(api: OpenClawPluginApi): OpenClawPluginService {
  let stopped = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const startedSessionIds = new Set<string>();
  const pendingStartControllers = new Set<AbortController>();
  const pendingStarts = new Set<Promise<void>>();

  const schedule = (run: () => void, delayMs: number) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      run();
    }, delayMs);
    timers.add(timer);
  };

  const startEntry = (
    entry: MeetingNotesAutoStartConfig,
    attempt: number,
    serviceApi: OpenClawPluginApi,
    store: MeetingNotesStore,
  ) => {
    if (stopped || !entry.enabled || startedSessionIds.has(entry.sessionId ?? "")) {
      return;
    }
    const abortController = new AbortController();
    pendingStartControllers.add(abortController);
    const startTask = startMeetingNotes({
      api: serviceApi,
      store,
      abortSignal: abortController.signal,
      startupWaitMs: AUTO_START_PROVIDER_READY_TIMEOUT_MS,
      rawParams: {
        action: "start",
        ...entry,
        sessionId: entry.sessionId ?? createSessionId(),
      },
    })
      .then((result) => {
        const sessionId = result.details?.sessionId;
        if (typeof sessionId === "string") {
          startedSessionIds.add(sessionId);
        }
      })
      .catch((err) => {
        if (stopped) {
          return;
        }
        if (attempt >= AUTO_START_RETRY_ATTEMPTS) {
          api.logger.warn(
            `meeting-notes autoStart failed provider=${entry.providerId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          return;
        }
        schedule(() => startEntry(entry, attempt + 1, serviceApi, store), AUTO_START_RETRY_MS);
      })
      .finally(() => {
        pendingStartControllers.delete(abortController);
        pendingStarts.delete(startTask);
      });
    pendingStarts.add(startTask);
  };

  return {
    id: "meeting-notes-auto-start",
    start(ctx) {
      const config = resolveMeetingNotesConfig(api.pluginConfig);
      if (!config.enabled || config.autoStart.length === 0) {
        return;
      }
      const serviceApi = { ...api, config: ctx.config };
      const store = new MeetingNotesStore(path.join(ctx.stateDir, "meeting-notes"));
      for (const entry of config.autoStart) {
        startEntry(
          {
            ...entry,
            sessionId: entry.sessionId ?? createSessionId(),
          },
          1,
          serviceApi,
          store,
        );
      }
    },
    async stop(ctx) {
      stopped = true;
      for (const timer of timers) {
        clearTimeout(timer);
      }
      timers.clear();
      for (const controller of pendingStartControllers) {
        controller.abort();
      }
      const pendingStartsSettled = await waitForPendingAutoStartsToSettle(pendingStarts);
      if (!pendingStartsSettled) {
        api.logger.warn(
          `meeting-notes autoStart stop timed out waiting for ${pendingStarts.size} pending start${
            pendingStarts.size === 1 ? "" : "s"
          }`,
        );
      }
      const serviceApi = { ...api, config: ctx.config };
      const store = new MeetingNotesStore(path.join(ctx.stateDir, "meeting-notes"));
      for (const sessionId of startedSessionIds) {
        await stopMeetingNotes({
          api: serviceApi,
          store,
          rawParams: { action: "stop", sessionId },
        }).catch((err) =>
          api.logger.warn(
            `meeting-notes autoStart stop failed session=${sessionId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
        );
      }
      startedSessionIds.clear();
    },
  };
}
