// Chat directive tag tests cover reply directive metadata, transcript mirrors,
// current-message reply routing, and dispatched payload ordering.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { CURRENT_SESSION_VERSION } from "openclaw/plugin-sdk/agent-sessions";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { CHAT_SEND_SESSION_KEY_MAX_LENGTH } from "../../../packages/gateway-protocol/src/schema.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  bindActiveCronCreatorAuthorityResolver,
  runWithCronCreatorAuthorityCapabilityResolver,
  type CronCreatorAuthorityCapability,
} from "../../agents/cron-creator-authority-context.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import { onTrustedMessageAuditEvent } from "../../audit/message-audit-events.js";
import { setReplyPayloadMetadata, type ReplyPayload } from "../../auto-reply/reply-payload.js";
import { getTotalPendingReplies } from "../../auto-reply/reply/dispatcher-registry.js";
import { markInboundContextLabel } from "../../auto-reply/reply/inbound-context-marker.js";
import {
  replyRunRegistry as baseReplyRunRegistry,
  type ReplyBackendQueueMessageOptions,
  type ReplyOperation,
} from "../../auto-reply/reply/reply-run-registry.js";
import { testing as replyRunRegistryTesting } from "../../auto-reply/reply/reply-run-registry.test-support.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import { recordAgentRunTerminalOutcome } from "../../channels/turn/agent-run-terminal-outcome.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  loadSessionEntry as loadSqliteSessionEntry,
  loadTranscriptEventsSync,
  replaceSessionEntry,
  resolveSessionTranscriptActiveLeafEntryId,
  switchSessionBranch,
  type SessionAccessScope,
  type SessionTranscriptReadScope,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { waitForSessionTranscriptIndexReconcile } from "../../config/sessions/session-transcript-reconcile.js";
import { resolveMirroredTranscriptText } from "../../config/sessions/transcript-mirror.js";
import { withOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context.js";
import { getAgentRunContext } from "../../infra/agent-run-registry.js";
import { RUN_STALE_TAKEOVER_MS } from "../../logging/diagnostic-run-activity.js";
import { runExclusiveSessionLifecycleMutation } from "../../sessions/session-lifecycle-admission.js";
import { projectAssistantDisplayContent } from "../../shared/assistant-display-content.js";
import {
  disposeOpenClawAgentDatabaseByPath,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseByPath } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { consumeCronCreatorAuthorityGrant } from "../cron-creator-authority-grant.js";
import { createChatRunState } from "../server-chat-state.js";
import { STALE_WORKER_BUILD_REASON } from "../worker-environments/admission.js";
import { agentWaitHandler } from "./agent-wait.js";
import { handleChatSend, handleTrustedInternalChatSend } from "./chat-send-handler.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

type ProjectedDispatchParams = Parameters<
  typeof import("../../auto-reply/dispatch.js").dispatchInboundMessageWithProjectedDispatcher
>[0];
type TestReplyDispatcher = ReturnType<
  typeof import("../../auto-reply/reply/reply-dispatcher.js").createReplyDispatcher
>;
type TestDispatchParams = Omit<ProjectedDispatchParams, "dispatcherOptions"> & {
  dispatcher: TestReplyDispatcher;
};
type RespondMock = ReturnType<typeof vi.fn<RespondFn>>;
type TranscriptUpdate = Parameters<
  typeof import("../../sessions/transcript-events.js").emitSessionTranscriptUpdate
>[0];

const TEST_TOOL_AUTHORITY_FINGERPRINT = "test-tool-authority";
const TEST_TOOL_AUTHORITY_ROUTE = { provider: "openai", model: "gpt-5.6-sol" } as const;
const replyRunRegistry = {
  ...baseReplyRunRegistry,
  begin(...args: Parameters<typeof baseReplyRunRegistry.begin>) {
    const operation = baseReplyRunRegistry.begin(...args);
    operation.bindToolAuthorityRoute(TEST_TOOL_AUTHORITY_ROUTE);
    operation.bindToolAuthorityFingerprint(TEST_TOOL_AUTHORITY_FINGERPRINT);
    return operation;
  },
};

const mockState = vi.hoisted(() => {
  const createTestState = () => ({
    config: {} as Record<string, unknown>,
    mainSessionKey: "main",
    finalText: "[[reply_to_current]]",
    finalPayload: null as ReplyPayload | null,
    dispatchedReplies: [] as Array<{
      kind: "tool" | "block" | "final";
      payload: ReplyPayload;
    }>,
    dispatchError: null as Error | null,
    dispatchWait: null as Promise<void> | null,
    dispatchErrorAfterAgentRunStart: null as Error | null,
    dispatchErrorAfterDelivery: null as Error | null,
    sessionMetadataChanges: [] as Array<{
      sessionKey: string;
      agentId?: string;
      reason: "command-metadata";
    }>,
    triggerAgentRunStart: false,
    triggerUserMessagePersisted: false,
    runtimeUserMessagePersistencePending: null as Promise<void> | null,
    onAfterAgentRunStart: null as (() => void) | null,
    agentRunId: "run-agent-1",
    sessionEntry: {} as Record<string, unknown>,
    sessionIdsByKey: new Map<string, string>(),
    sessionMissing: false,
    loadSessionEntryCalls: [] as Array<{ rawKey: string; opts?: { agentId?: string } }>,
    lastDispatchCtx: undefined as MsgContext | undefined,
    lastDispatchImages: undefined as Array<{ mimeType: string; data: string }> | undefined,
    lastDispatchImageOrder: undefined as string[] | undefined,
    lastDispatchThinkingLevelOverride: undefined as string | undefined,
    lastDispatchOriginatingLeafEntryId: undefined as string | null | undefined,
    lastTaskSuggestionDeliveryMode: undefined as "gateway" | undefined,
    lastMessageInjectionDisposition: undefined as "none" | "accepted" | "rejected" | undefined,
    lastDispatchUserTurnInput: undefined as unknown,
    modelCatalog: null as ModelCatalogEntry[] | null,
    emittedTranscriptUpdates: [] as TranscriptUpdate[],
    savedMediaResults: [] as Array<{ id?: string; path: string; contentType?: string }>,
    saveMediaError: null as Error | null,
    savedMediaCalls: [] as Array<{ contentType?: string; subdir?: string; size: number }>,
    saveMediaWait: null as Promise<void> | null,
    activeSaveMediaCalls: 0,
    maxActiveSaveMediaCalls: 0,
    replyContextCalls: 0,
    replyContextResult: null as {
      ReplyToId?: string;
      ReplyToBody?: string;
      ReplyToSender?: string;
    } | null,
    replyContextWait: null as Promise<void> | null,
    sandboxWorkspace: null as { workspaceDir: string; containerWorkdir?: string } | null,
    stageSandboxMediaError: null as Error | null,
    stagedRelativePaths: null as string[] | null,
    hasBeforeAgentRunHooks: false,
    hasMessageReceivedHooks: false,
    messageReceivedCalls: [] as Array<{ event: unknown; context: unknown }>,
    beforeMessageWriteBlock: false,
    beforeMessageWriteContent: null as string | null,
    beforeMessageWriteCalls: [] as Array<{ message: unknown; ctx: unknown }>,
    dispatchBlockedByBeforeAgentRun: false,
    disposedTranscriptWriteContext: false,
    disposedTranscriptWriteAttempts: 0,
    runtimeAssistantContentBeforeDelivery: null as Array<Record<string, unknown>> | null,
    runtimeAssistantTextsBeforeDelivery: [] as string[],
    cronAuthorityProbe: undefined as
      | ((
          runId: string | undefined,
          capability: CronCreatorAuthorityCapability | undefined,
        ) => Promise<void> | void)
      | undefined,
    // `unstagedSources` lets tests simulate partial staging failure: absolute
    // source paths listed here are excluded from the returned `staged` map even
    // though ctx still carries their rewritten paths. This mirrors how the real
    // stageSandboxMedia silently skips over-cap files.
    unstagedSources: null as string[] | null,
    deleteMediaBufferCalls: [] as Array<{ id: string; subdir?: string }>,
  });
  const state = {
    storePath: "",
    transcriptPath: "",
    sessionId: "sess-1",
    ...createTestState(),
  };
  return Object.assign(state, {
    reset: () => Object.assign(state, createTestState()),
  });
});

type TestReply = (typeof mockState.dispatchedReplies)[number];
type TestReplyPayload = TestReply["payload"];
type SourceReplyTranscriptMirror = NonNullable<
  Parameters<typeof setReplyPayloadMetadata>[1]["sourceReplyTranscriptMirror"]
>;

let suiteFixtureRoot = "";
let suiteDatabasePath = "";
let suiteFixtureEnv: NodeJS.ProcessEnv = {};
let suiteFixtureSeq = 0;

function readTranscriptJsonLines(transcriptPath: string): Array<Record<string, unknown>> {
  const sqliteEvents = loadTranscriptEventsSync(transcriptScope()).filter(
    (event): event is Record<string, unknown> =>
      Boolean(event) && typeof event === "object" && !Array.isArray(event),
  );
  if (sqliteEvents.length > 0) {
    return sqliteEvents;
  }
  const entries: Array<Record<string, unknown>> = [];
  if (!fs.existsSync(transcriptPath)) {
    return entries;
  }
  for (const line of fs.readFileSync(transcriptPath, "utf-8").split("\n")) {
    if (line.length > 0) {
      entries.push(JSON.parse(line) as Record<string, unknown>);
    }
  }
  return entries;
}

const bindingMocks = vi.hoisted(() => ({
  resolveByConversation: vi.fn(
    (_ref: unknown) =>
      null as { metadata?: Record<string, unknown>; targetSessionKey?: string } | null,
  ),
}));

const UNTRUSTED_CONTEXT_SUFFIX = `${markInboundContextLabel("Context:")}
<<<EXTERNAL_UNTRUSTED_CONTENT id="deadbeefdeadbeef">>>
Source: Channel metadata
---
Channel metadata (discord)
Sender labels:
example
<<<END_EXTERNAL_UNTRUSTED_CONTENT id="deadbeefdeadbeef">>>`;

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=";
const INLINE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYoYAAAAASUVORK5CYII=";
const OFFLOAD_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";
const TINY_JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAkGBxAQEBUQEBAVFRUVFRUVFRUVFRUVFRUVFRUXFhUVFRUYHSggGBolHRUVITEhJSkrLi4uFx8zODMsNygtLisBCgoKDg0OGhAQGi0fICUtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLf/AABEIAAEAAQMBEQACEQEDEQH/xAAXAAADAQAAAAAAAAAAAAAAAAAAAQMC/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEAMQAAAB6AAAAP/EABQQAQAAAAAAAAAAAAAAAAAAACD/2gAIAQEAAT8Af//EABQRAQAAAAAAAAAAAAAAAAAAACD/2gAIAQIBAT8Af//EABQRAQAAAAAAAAAAAAAAAAAAACD/2gAIAQMBAT8Af//Z";

vi.mock("../session-utils.js", async () => {
  const original =
    await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  const loadSessionEntry = (rawKey: string, opts?: { agentId?: string }) => {
    mockState.loadSessionEntryCalls.push({ rawKey, opts });
    const canonicalKey =
      typeof mockState.sessionEntry.canonicalKey === "string"
        ? mockState.sessionEntry.canonicalKey
        : rawKey === "main"
          ? `agent:${opts?.agentId ?? "main"}:${mockState.mainSessionKey}`
          : rawKey || `agent:${opts?.agentId ?? "main"}:${mockState.mainSessionKey}`;
    const entry = mockState.sessionMissing
      ? undefined
      : {
          sessionId: mockState.sessionIdsByKey.get(rawKey) ?? mockState.sessionId,
          sessionFile: mockState.transcriptPath,
          ...mockState.sessionEntry,
        };
    return {
      ...(typeof mockState.sessionEntry.canonicalKey === "string" ? { canonicalKey } : {}),
      cfg: {
        ...mockState.config,
        session: {
          ...(mockState.config.session as Record<string, unknown> | undefined),
          mainKey: mockState.mainSessionKey,
        },
      },
      storePath: mockState.storePath,
      store: entry ? { [canonicalKey]: entry } : {},
      entry,
      canonicalKey,
    };
  };
  return {
    ...original,
    loadSessionEntry,
    loadGatewaySessionEntryReadOnly: loadSessionEntry,
  };
});

const dispatchInboundMessageMock = vi.hoisted(() => vi.fn());

vi.mock("../../auto-reply/dispatch.js", async () => {
  const { createReplyDispatcher } = await vi.importActual<
    typeof import("../../auto-reply/reply/reply-dispatcher.js")
  >("../../auto-reply/reply/reply-dispatcher.js");
  const { withReplyDispatcher } = await vi.importActual<
    typeof import("../../auto-reply/dispatch-dispatcher.js")
  >("../../auto-reply/dispatch-dispatcher.js");
  return {
    dispatchInboundMessage: dispatchInboundMessageMock,
    dispatchInboundMessageWithProjectedDispatcher: vi.fn(
      async (params: ProjectedDispatchParams) => {
        const { dispatcherOptions, ...dispatchParams } = params;
        const dispatcher = createReplyDispatcher(dispatcherOptions);
        return await withReplyDispatcher({
          dispatcher,
          run: () => dispatchInboundMessageMock({ ...dispatchParams, dispatcher }),
        });
      },
    ),
  };
});

dispatchInboundMessageMock.mockImplementation(
  vi.fn(async (params: TestDispatchParams) => {
    mockState.lastDispatchCtx = params.ctx;
    mockState.lastDispatchImages = params.replyOptions?.images;
    mockState.lastDispatchImageOrder = params.replyOptions?.imageOrder;
    mockState.lastDispatchThinkingLevelOverride = params.replyOptions?.thinkingLevelOverride;
    mockState.lastDispatchOriginatingLeafEntryId =
      params.replyOptions?.turnAdoptionLifecycle?.originatingLeafEntryId;
    mockState.lastTaskSuggestionDeliveryMode = params.replyOptions?.taskSuggestionDeliveryMode;
    mockState.lastMessageInjectionDisposition = params.replyOptions?.messageInjectionDisposition;
    await mockState.cronAuthorityProbe?.(
      params.replyOptions?.runId,
      params.replyOptions?.cronCreatorAuthorityCapability,
    );
    const recorder = params.replyOptions?.userTurnTranscriptRecorder;
    mockState.lastDispatchUserTurnInput = recorder?.resolveMessage
      ? await recorder.resolveMessage()
      : recorder?.message;
    if (mockState.dispatchError) {
      throw mockState.dispatchError;
    }
    if (mockState.dispatchWait) {
      await mockState.dispatchWait;
    }
    if (mockState.triggerAgentRunStart) {
      params.replyOptions?.onAgentRunStart?.(mockState.agentRunId);
      mockState.onAfterAgentRunStart?.();
    }
    if (mockState.triggerUserMessagePersisted) {
      params.replyOptions?.userTurnTranscriptRecorder?.markRuntimePersisted({
        role: "user",
        content: "persisted by runtime",
        timestamp: Date.now(),
      });
    }
    if (mockState.runtimeUserMessagePersistencePending) {
      params.replyOptions?.userTurnTranscriptRecorder?.markRuntimePersistencePending(
        mockState.runtimeUserMessagePersistencePending,
      );
    }
    if (mockState.dispatchErrorAfterAgentRunStart) {
      throw mockState.dispatchErrorAfterAgentRunStart;
    }
    if (mockState.runtimeAssistantContentBeforeDelivery) {
      await appendSourceReplyMirrorEntry({
        content: mockState.runtimeAssistantContentBeforeDelivery,
        text: "",
        provider: "openai",
        model: "gpt-5.6-luna",
        now: Date.now(),
      });
    }
    for (const text of mockState.runtimeAssistantTextsBeforeDelivery) {
      await appendSourceReplyMirrorEntry({
        text,
        provider: "openai",
        model: "gpt-5.6-luna",
        now: Date.now(),
      });
    }
    if (mockState.sessionMetadataChanges.length > 0) {
      params.onSessionMetadataChanges?.(mockState.sessionMetadataChanges);
    }
    const deliverReplies = async () => {
      if (mockState.dispatchedReplies.length > 0) {
        for (const reply of mockState.dispatchedReplies) {
          if (reply.kind === "tool") {
            params.dispatcher.sendToolResult(reply.payload);
            continue;
          }
          if (reply.kind === "block") {
            params.dispatcher.sendBlockReply(reply.payload);
            continue;
          }
          params.dispatcher.sendFinalReply(reply.payload);
        }
      } else {
        params.dispatcher.sendFinalReply(mockState.finalPayload ?? { text: mockState.finalText });
      }
      params.dispatcher.markComplete();
      await params.dispatcher.waitForIdle();
    };
    if (mockState.disposedTranscriptWriteContext) {
      const sessionKey = mockState.mainSessionKey;
      const storePath = mockState.storePath;
      await withOwnedSessionTranscriptWrites(
        {
          sessionKey,
          sessionTarget: {
            agentId: "main",
            sessionId: mockState.sessionId,
            sessionKey,
            storePath,
          },
          withTranscriptWrite: async () => {
            mockState.disposedTranscriptWriteAttempts += 1;
            throw new Error("attempt disposed before transcript write");
          },
        },
        deliverReplies,
      );
    } else {
      await deliverReplies();
    }
    if (mockState.dispatchErrorAfterDelivery) {
      throw mockState.dispatchErrorAfterDelivery;
    }
    return {
      ok: true,
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 1 },
      ...(mockState.dispatchBlockedByBeforeAgentRun ? { beforeAgentRunBlocked: true } : {}),
    };
  }),
);

vi.mock("../../infra/outbound/session-binding-service.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../infra/outbound/session-binding-service.js")
  >("../../infra/outbound/session-binding-service.js");
  return {
    ...actual,
    getSessionBindingService: () => ({
      ...actual.getSessionBindingService(),
      resolveByConversation: (ref: unknown) => bindingMocks.resolveByConversation(ref),
    }),
  };
});

vi.mock("./chat-send-reply-context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chat-send-reply-context.js")>();
  return {
    ...actual,
    resolveChatSendReplyContext: async (
      ...args: Parameters<typeof actual.resolveChatSendReplyContext>
    ) => {
      mockState.replyContextCalls += 1;
      if (mockState.replyContextWait) {
        await mockState.replyContextWait;
      }
      return mockState.replyContextResult ?? actual.resolveChatSendReplyContext(...args);
    },
  };
});

vi.mock("../../plugins/hook-runner-global.js", () => {
  const hasHooks = (hookName: string) =>
    (hookName === "before_agent_run" && mockState.hasBeforeAgentRunHooks) ||
    (hookName === "message_received" && mockState.hasMessageReceivedHooks) ||
    (hookName === "before_message_write" &&
      (mockState.beforeMessageWriteBlock || mockState.beforeMessageWriteContent !== null));
  return {
    getGlobalHookRunner: () => ({
      hasHooks,
      runBeforeMessageWrite: (event: { message: unknown }, ctx: unknown) => {
        mockState.beforeMessageWriteCalls.push({ message: event.message, ctx });
        if (mockState.beforeMessageWriteBlock) {
          return { block: true };
        }
        if (mockState.beforeMessageWriteContent !== null) {
          return {
            message: {
              ...(typeof event.message === "object" && event.message !== null ? event.message : {}),
              role: "user",
              content: mockState.beforeMessageWriteContent,
            },
          };
        }
        return undefined;
      },
      runMessageReceived: async (event: unknown, context: unknown) => {
        mockState.messageReceivedCalls.push({ event, context });
      },
    }),
    hasGlobalHooks: hasHooks,
  };
});

vi.mock("../../sessions/transcript-events.js", async (importOriginal) => {
  const { attachSessionTranscriptRunId, resolveTerminalAssistantTranscriptRunId } =
    await importOriginal<typeof import("../../sessions/transcript-events.js")>();
  return {
    attachSessionTranscriptRunId,
    resolveTerminalAssistantTranscriptRunId,
    emitSessionTranscriptUpdate: vi.fn((update: TranscriptUpdate) => {
      mockState.emittedTranscriptUpdates.push(update);
    }),
  };
});

vi.mock("../../agents/sandbox/context.js", async () => {
  const original = await vi.importActual<typeof import("../../agents/sandbox/context.js")>(
    "../../agents/sandbox/context.js",
  );
  return {
    ...original,
    ensureSandboxWorkspaceForSession: vi.fn(async () => mockState.sandboxWorkspace),
  };
});

vi.mock("../../auto-reply/reply/stage-sandbox-media.js", () => ({
  SANDBOX_MEDIA_MAX_BYTES: 50 * 1024 * 1024,
  stageSandboxMedia: vi.fn(
    async (params: {
      ctx: { media?: Array<{ path?: string; contentType?: string; workspaceDir?: string }> };
    }) => {
      if (mockState.stageSandboxMediaError) {
        throw mockState.stageSandboxMediaError;
      }
      const staged = new Map<number, string>();
      const originalPaths = params.ctx.media?.map((fact) => fact.path) ?? [];
      if (mockState.stagedRelativePaths) {
        const mapping = mockState.stagedRelativePaths;
        params.ctx.media = (params.ctx.media ?? []).map((fact, index) => ({
          path: mapping[index] ?? fact.path,
          contentType: fact.contentType,
          workspaceDir: mockState.sandboxWorkspace?.workspaceDir,
        }));
        for (let i = 0; i < mapping.length; i += 1) {
          const source = originalPaths[i];
          const dest = mapping[i];
          if (source && dest) {
            staged.set(i, dest);
          }
        }
      }
      if (mockState.unstagedSources) {
        for (const source of mockState.unstagedSources) {
          const index = originalPaths.indexOf(source);
          if (index >= 0) {
            staged.delete(index);
          }
        }
      }
      return { staged };
    },
  ),
}));

vi.mock("../../media/store.js", async () => {
  const original =
    await vi.importActual<typeof import("../../media/store.js")>("../../media/store.js");
  return {
    ...original,
    deleteMediaBuffer: vi.fn(async (id: string, subdir?: string) => {
      mockState.deleteMediaBufferCalls.push({ id, subdir });
    }),
    saveMediaBuffer: vi.fn(async (buffer: Buffer, contentType?: string, subdir?: string) => {
      mockState.activeSaveMediaCalls += 1;
      mockState.maxActiveSaveMediaCalls = Math.max(
        mockState.maxActiveSaveMediaCalls,
        mockState.activeSaveMediaCalls,
      );
      if (mockState.saveMediaWait) {
        await mockState.saveMediaWait;
      }
      if (mockState.saveMediaError) {
        mockState.activeSaveMediaCalls -= 1;
        throw mockState.saveMediaError;
      }
      mockState.savedMediaCalls.push({ contentType, subdir, size: buffer.byteLength });
      const next = mockState.savedMediaResults.shift();
      try {
        return {
          id: next?.id ?? "saved-media",
          path: next?.path ?? `/tmp/${mockState.savedMediaCalls.length}.png`,
          size: buffer.byteLength,
          contentType: next?.contentType ?? contentType,
        };
      } finally {
        mockState.activeSaveMediaCalls -= 1;
      }
    }),
  };
});

const { chatHandlers } = await import("./chat.js");

// Multi-media transcript mirroring can exceed 1s on loaded CI before the async broadcast lands.
async function waitForAssertion(assertion: () => void, timeoutMs = 5_000, stepMs = 2) {
  await vi.waitFor(assertion, { interval: stepMs, timeout: timeoutMs });
}

function expectClaimOnlyTranscriptMedia(
  message: unknown,
  expectedMedia: unknown[],
  forbiddenValues: string[],
) {
  const media = (
    message as { __openclaw?: { media?: Array<Record<string, unknown>> } } | undefined
  )?.["__openclaw"]?.media;
  expect(media).toEqual(expectedMedia);
  for (const fact of media ?? []) {
    expect(fact.url).toMatch(/^media:\/\/inbound\/[^?#]+$/u);
    expect(fact).not.toHaveProperty("path");
    expect(fact).not.toHaveProperty("workspaceDir");
    expect(fact).not.toHaveProperty("data");
  }
  const serialized = JSON.stringify(message);
  expect(serialized).not.toContain("base64");
  for (const value of forbiddenValues) {
    expect(serialized).not.toContain(value);
  }
}

function createFixturePaths(prefix: string): { dir: string; transcriptPath: string } {
  const dir = fs.mkdtempSync(path.join(suiteFixtureRoot, `${suiteFixtureSeq++}-${prefix}`));
  const transcriptPath = path.join(dir, "sess.jsonl");
  mockState.sessionId = `chat-directive-${suiteFixtureSeq}`;
  mockState.transcriptPath = transcriptPath;
  return { dir, transcriptPath };
}

async function createTranscriptFixture(
  prefix: string,
  owner: Pick<SessionAccessScope, "agentId" | "sessionKey"> = {
    agentId: "main",
    sessionKey: "main",
  },
) {
  const { dir, transcriptPath } = createFixturePaths(prefix);
  fs.writeFileSync(
    transcriptPath,
    `${JSON.stringify({
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: mockState.sessionId,
      timestamp: new Date(0).toISOString(),
      cwd: "/tmp",
    })}\n`,
    "utf-8",
  );
  // The accessor resolves transcript targets from the persisted store, so the
  // fixture seeds a real entry instead of relying on the mocked gateway wrapper.
  await replaceSessionEntry(
    { ...owner, storePath: mockState.storePath },
    {
      sessionId: mockState.sessionId,
      sessionFile: transcriptPath,
      updatedAt: Date.now(),
    },
  );
  return dir;
}

async function createSqliteTranscriptFixture(prefix: string) {
  const { dir } = createFixturePaths(prefix);
  await replaceSessionEntry(sessionEntryScope(), {
    sessionId: mockState.sessionId,
    updatedAt: 1,
  });
  return dir;
}

async function createGatewayUserTurnSqliteFixture(prefix: string) {
  return await createSqliteTranscriptFixture(prefix);
}

async function withTranscriptFixtureState(
  prefix: string,
  run: (fixtureDir: string) => Promise<void>,
): Promise<void> {
  const fixtureDir = await createTranscriptFixture(prefix);
  await withEnvAsync({ OPENCLAW_STATE_DIR: suiteFixtureRoot }, async () => await run(fixtureDir));
}

async function withSqliteTranscriptFixtureState(
  prefix: string,
  run: (fixtureDir: string) => Promise<void>,
): Promise<void> {
  const fixtureDir = await createSqliteTranscriptFixture(prefix);
  await withEnvAsync({ OPENCLAW_STATE_DIR: suiteFixtureRoot }, async () => await run(fixtureDir));
}

function transcriptScope(): SessionTranscriptReadScope {
  return {
    agentId: "main",
    sessionId: mockState.sessionId,
    sessionKey: "main",
    storePath: mockState.storePath,
  };
}

function sessionEntryScope(): SessionAccessScope {
  return {
    agentId: "main",
    sessionKey: "main",
    storePath: mockState.storePath,
  };
}

async function seedSqliteSessionEntry(entry: Record<string, unknown> = {}): Promise<void> {
  await upsertSessionEntryCore(sessionEntryScope(), {
    sessionId: mockState.sessionId,
    ...entry,
  });
}

function readSqliteMainSessionEntry(): Record<string, any> | undefined {
  return loadSqliteSessionEntry(sessionEntryScope()) as Record<string, any> | undefined;
}

async function appendSourceReplyMirrorEntry(params: {
  content?: Array<Record<string, unknown>>;
  idempotencyKey?: string;
  openclawDelivery?: Record<string, unknown>;
  text: string;
  provider?: string;
  model?: string;
  now?: number;
}) {
  const now = params.now ?? 0;
  await appendTranscriptMessage(transcriptScope(), {
    idempotencyLookup: "scan",
    now,
    message: {
      role: "assistant",
      content: params.content ?? [{ type: "text", text: params.text }],
      api: "openai-responses",
      provider: params.provider ?? "openclaw",
      model: params.model ?? "delivery-mirror",
      ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
      ...(params.openclawDelivery ? { openclawDelivery: params.openclawDelivery } : {}),
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
      timestamp: now,
    },
  });
}

async function readRawActiveAssistantTranscriptMessages(): Promise<Array<Record<string, unknown>>> {
  return readTranscriptJsonLines(mockState.transcriptPath)
    .map((entry) => entry.message)
    .filter(
      (message): message is Record<string, unknown> =>
        typeof message === "object" &&
        message !== null &&
        (message as { role?: unknown }).role === "assistant",
    );
}

async function readActiveAssistantTranscriptMessages(): Promise<Array<Record<string, unknown>>> {
  return (await readRawActiveAssistantTranscriptMessages()).map(projectAssistantDisplayContent);
}

function extractFirstTextBlock(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const message = (payload as { message?: unknown }).message;
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  const first = content[0];
  if (!first || typeof first !== "object") {
    return undefined;
  }
  const firstText = (first as { text?: unknown }).text;
  return typeof firstText === "string" ? firstText : undefined;
}

function getMessage(payload: unknown): Record<string, any> | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const message = (payload as { message?: unknown }).message;
  return message && typeof message === "object" ? (message as Record<string, any>) : undefined;
}

function getMessageContent(payload: unknown): Array<Record<string, any>> {
  const content = getMessage(payload)?.content;
  return Array.isArray(content) ? (content as Array<Record<string, any>>) : [];
}

function mockCallAt(
  mock: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } },
  index: number,
): ReadonlyArray<unknown> | undefined {
  const calls = mock.mock.calls;
  const normalizedIndex = index < 0 ? calls.length + index : index;
  return calls[normalizedIndex];
}

function lastRespondCall(respond: RespondMock) {
  return mockCallAt(respond, -1) as
    | [boolean, Record<string, any> | undefined, Record<string, any> | undefined]
    | undefined;
}

function responseErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") {
      return message;
    }
    return JSON.stringify(error);
  }
  return String(error);
}

function lastBroadcastPayload(context: ChatContext): Record<string, any> | undefined {
  const chatCall = mockCallAt(context.broadcast, -1);
  expect(chatCall?.[0]).toBe("chat");
  return chatCall?.[1] as Record<string, any> | undefined;
}

function lastNodeSendCall(context: ChatContext) {
  return mockCallAt(context.nodeSendToSession, -1) as
    | [string, string, Record<string, any>]
    | undefined;
}

function findAssistantTranscriptUpdates() {
  return mockState.emittedTranscriptUpdates
    .filter(
      (update) =>
        typeof update.message === "object" &&
        update.message !== null &&
        (update.message as { role?: unknown }).role === "assistant",
    )
    .map((update) => {
      const message = update.message as Record<string, unknown>;
      const projected = projectAssistantDisplayContent(message);
      return projected === message ? update : Object.assign({}, update, { message: projected });
    });
}

function findAssistantUpdateWithBlock(predicate: (block: Record<string, any>) => boolean) {
  return findAssistantTranscriptUpdates().find((update) => {
    const message = update.message as { role?: unknown; content?: unknown } | undefined;
    return (
      message?.role === "assistant" &&
      Array.isArray(message.content) &&
      (message.content as Array<Record<string, any>>).some(predicate)
    );
  });
}

function findUserUpdate() {
  return mockState.emittedTranscriptUpdates.find((update) => {
    const message = update.message as { role?: unknown } | undefined;
    return message?.role === "user";
  });
}

function userUpdateMessage(
  update: { message?: unknown } | undefined,
): Record<string, any> | undefined {
  return update?.message && typeof update.message === "object"
    ? (update.message as Record<string, any>)
    : undefined;
}

function expectUserUpdateIdentity(update: ReturnType<typeof findUserUpdate>) {
  expect(update?.target).toEqual({
    agentId: "main",
    sessionId: mockState.sessionId,
    sessionKey: "agent:main:main",
    storePath: mockState.storePath,
  });
  expect(update?.sessionKey).toBe("agent:main:main");
  expect(update?.agentId).toBe("main");
}

function readPersistedUserMessages(): Array<Record<string, unknown>> {
  return readTranscriptJsonLines(mockState.transcriptPath)
    .map((entry) => entry.message)
    .filter(
      (candidate): candidate is Record<string, unknown> =>
        typeof candidate === "object" &&
        candidate !== null &&
        (candidate as { role?: unknown }).role === "user",
    );
}

function expectDispatchContextFields(expected: {
  OriginatingChannel?: unknown;
  OriginatingTo?: unknown;
  ExplicitDeliverRoute?: unknown;
  AccountId?: unknown;
  MessageThreadId?: unknown;
  BodyForCommands?: unknown;
  CommandSource?: unknown;
}) {
  for (const [key, value] of Object.entries(expected)) {
    expect((mockState.lastDispatchCtx as Record<string, unknown> | undefined)?.[key]).toBe(value);
  }
}

function createScopedCliClient(
  scopes?: string[],
  client: Partial<{
    id: string;
    mode: string;
    displayName: string;
    version: string;
  }> = {},
  caps?: string[],
) {
  const id = client.id ?? "openclaw-cli";
  return {
    connect: {
      scopes,
      caps,
      client: {
        id,
        mode: client.mode ?? "cli",
        displayName: client.displayName ?? id,
        version: client.version ?? "1.0.0",
      },
    },
  };
}

function createChatContext() {
  const context = {
    broadcast: vi.fn<GatewayRequestContext["broadcast"]>(),
    nodeSendToSession: vi.fn<GatewayRequestContext["nodeSendToSession"]>(),
    agentRunSeq: new Map<string, number>(),
    chatAbortControllers: new Map(),
    chatQueuedTurns: new Map(),
    chatRunState: createChatRunState(),
    addChatRun: vi.fn(),
    removeChatRun: vi.fn(),
    dedupe: new Map(),
    loadGatewayModelCatalog: async () =>
      mockState.modelCatalog ?? [
        // Keep the default model image-capable here; otherwise attachment tests
        // exercise the unsupported-model fallback instead of Pi persistence.
        {
          provider: "openai",
          id: "gpt-5.6-sol",
          name: "GPT-5.6 Sol",
          input: ["text", "image"],
        },
        {
          provider: "anthropic",
          id: "claude-opus-4-6",
          name: "Claude Opus 4.6",
          input: ["text", "image"],
        },
      ],
    getRuntimeConfig: () =>
      ({
        ...mockState.config,
        session: {
          ...(mockState.config.session as Record<string, unknown> | undefined),
          mainKey: mockState.mainSessionKey,
        },
      }) as never,
    registerToolEventRecipient: vi.fn<GatewayRequestContext["registerToolEventRecipient"]>(),
    broadcastToConnIds: vi.fn<GatewayRequestContext["broadcastToConnIds"]>(),
    getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
    logGateway: {
      warn: vi.fn<GatewayRequestContext["logGateway"]["warn"]>(),
      debug: vi.fn<GatewayRequestContext["logGateway"]["debug"]>(),
      error: vi.fn<GatewayRequestContext["logGateway"]["error"]>(),
    },
  };
  return context as typeof context & GatewayRequestContext;
}

type ChatContext = ReturnType<typeof createChatContext>;

function useChatTestModel(model: "vision-model" | "text-only", configured = false) {
  mockState.sessionEntry = {
    modelProvider: "test-provider",
    model,
    ...(configured ? { providerOverride: "test-provider", modelOverride: model } : {}),
  };
  mockState.modelCatalog = [
    {
      provider: "test-provider",
      id: model,
      name: model === "vision-model" ? "Vision model" : "Text only",
      input: model === "vision-model" ? ["text", "image"] : ["text"],
    },
  ];
}

function useGlobalSessionScope() {
  mockState.config = {
    agents: { list: [{ id: "main", default: true }, { id: "work" }] },
    session: { scope: "global" },
  };
}

async function createReadyChatTranscript(prefix: string) {
  await createTranscriptFixture(prefix);
  mockState.finalText = "ok";
}

function createChatRequestFixture() {
  const context = createChatContext();
  const respond = vi.fn<RespondFn>();
  return {
    context,
    respond,
    send: (params: Omit<Parameters<typeof runNonStreamingChatSend>[0], "context" | "respond">) =>
      runNonStreamingChatSend({ context, respond, ...params }),
    inject: (params: Parameters<NonNullable<(typeof chatHandlers)["chat.inject"]>>[0]["params"]) =>
      expectDefined(
        chatHandlers["chat.inject"],
        'chatHandlers["chat.inject"] test invariant',
      )({
        params,
        respond,
        req: {} as never,
        client: null as never,
        isWebchatConnect: () => false,
        context,
      }),
  };
}

async function sendNewChatRequest(
  params: Omit<Parameters<typeof runNonStreamingChatSend>[0], "context" | "respond">,
) {
  const fixture = createChatRequestFixture();
  const payload = await fixture.send(params);
  return { ...fixture, payload };
}

async function createSqliteChatRequest(prefix: string) {
  await createGatewayUserTurnSqliteFixture(prefix);
  return createChatRequestFixture();
}

type NonStreamingChatSendWaitFor = "broadcast" | "dedupe" | "none";
type ChatDeliveryRoutingCase = readonly [
  name: string,
  id: string,
  delivery: { channel: string; to: string; accountId: string; threadId?: string | number },
  sessionKey: string,
  options?: {
    deliver?: boolean;
    clientMode?: string;
    mainSessionKey?: string;
    origin?: { provider: string; accountId: string; threadId?: string };
    omitClientDetails?: boolean;
    external?: boolean;
  },
];
type SlashCommandMediaCase = {
  name: string;
  id: string;
  files: string[];
  replies: (paths: [string, string]) => typeof mockState.dispatchedReplies;
  verify: (content: Array<Record<string, any>>, paths: [string, string]) => void;
};

function createSlashCommandMediaReply(
  kind: "block" | "final",
  mediaUrls: string[],
  payload: (typeof mockState.dispatchedReplies)[number]["payload"] = {},
): (typeof mockState.dispatchedReplies)[number] {
  return { kind, payload: { mediaUrls, trustedLocalMedia: true, ...payload } };
}

function managedAudioBlocks(content: Array<Record<string, unknown>>) {
  return content.filter((block) => block.type === "audio");
}

function bindTestToolAuthority(operation: ReplyOperation) {
  operation.bindToolAuthorityProjector(() => TEST_TOOL_AUTHORITY_FINGERPRINT);
  operation.bindToolAuthorityRoute({ provider: "anthropic", model: "test-model" });
}

function beginActiveReplyOperation(params: {
  backend?: Parameters<ReplyOperation["attachBackend"]>[0];
  bindToolAuthority?: boolean;
  originatingLeafEntryId?: string | null;
  sessionId?: string;
  sessionKey?: string;
}) {
  const operation = replyRunRegistry.begin({
    sessionKey: params.sessionKey ?? "agent:main:main",
    sessionId: params.sessionId ?? mockState.sessionId,
    resetTriggered: false,
    ...(params.originatingLeafEntryId !== undefined
      ? { originatingLeafEntryId: params.originatingLeafEntryId }
      : {}),
  });
  if (params.bindToolAuthority) {
    bindTestToolAuthority(operation);
  }
  operation.setPhase("running");
  if (params.backend) {
    operation.attachBackend(params.backend);
  }
  return operation;
}

type TestReplyBackend = Parameters<ReplyOperation["attachBackend"]>[0];
type TestQueueMessage = NonNullable<TestReplyBackend["queueMessage"]>;

function beginMessageInjectionOperation(params: {
  bindToolAuthority?: boolean;
  cancel?: TestReplyBackend["cancel"];
  isStopped?: TestReplyBackend["isStopped"];
  isStreaming?: TestReplyBackend["isStreaming"];
  legacy?: boolean;
  originatingLeafEntryId?: string | null;
  queueMessage: TestQueueMessage;
  runId?: string;
  supportsQueueMessageImages?: boolean;
  taskSuggestionDeliveryMode?: "gateway";
}) {
  const backend = {
    kind: "embedded" as const,
    cancel: params.cancel ?? (() => {}),
    runId: params.runId,
    supportsQueueMessageImages: params.supportsQueueMessageImages,
    taskSuggestionDeliveryMode: params.taskSuggestionDeliveryMode,
    ...(params.legacy
      ? {
          queueMessage: params.queueMessage,
          isStopped: params.isStopped,
          isStreaming: params.isStreaming,
        }
      : {
          messageInjection: { isAvailable: () => true, queueMessage: params.queueMessage },
        }),
  } satisfies TestReplyBackend;
  return beginActiveReplyOperation({
    bindToolAuthority: params.bindToolAuthority ?? true,
    originatingLeafEntryId: params.originatingLeafEntryId,
    backend,
  });
}

async function appendTestTranscriptMessage(params: {
  content: string;
  display?: boolean;
  eventId: string;
  now: number;
  parentId: string | null;
  role: "assistant" | "user";
}) {
  await appendTranscriptMessage(transcriptScope(), {
    eventId: params.eventId,
    message: {
      role: params.role,
      content: params.content,
      ...(params.display === undefined ? {} : { display: params.display }),
    },
    now: params.now,
    parentId: params.parentId,
  });
}

function createImageAttachment(
  params: {
    content?: string;
    fileName?: string;
    mimeType?: string;
    type?: string;
  } = {},
) {
  return {
    ...(params.type ? { type: params.type } : {}),
    mimeType: params.mimeType ?? "image/png",
    ...(params.fileName ? { fileName: params.fileName } : {}),
    content: params.content ?? TINY_PNG_BASE64,
  };
}

function createFileAttachment(fileName: string, mimeType: string, content: string, type = "file") {
  return {
    type,
    mimeType,
    fileName,
    content,
  };
}

function createPngBuffer(size: number): Buffer {
  const buffer = Buffer.alloc(size);
  buffer.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return buffer;
}

function writeSavedPng(fixtureDir: string, fileName: string): string {
  const savedImagePath = path.join(fixtureDir, fileName);
  fs.writeFileSync(savedImagePath, Buffer.from(TINY_PNG_BASE64, "base64"));
  mockState.savedMediaResults.push({ path: savedImagePath, contentType: "image/png" });
  return savedImagePath;
}

function setSavedMediaResults(...results: Array<[path: string, contentType: string, id?: string]>) {
  mockState.savedMediaResults = results.map(([pathValue, contentType, id]) => {
    const result = { path: pathValue, contentType, id: undefined as string | undefined };
    if (id) {
      result.id = id;
    }
    return result;
  });
}

async function createAudioTranscriptFixture(prefix: string, fileName = "tts.mp3") {
  const transcriptDir = await createTranscriptFixture(prefix);
  const audioPath = path.join(transcriptDir, fileName);
  fs.writeFileSync(audioPath, Buffer.from([0xff, 0xfb, 0x90, 0x00]));
  mockState.config = { agents: { defaults: { workspace: transcriptDir } } };
  return { audioPath, transcriptDir };
}

function createSourceReply(
  payload: TestReplyPayload,
  sourceReplyTranscriptMirror: SourceReplyTranscriptMirror,
): TestReply {
  return {
    kind: "final",
    payload: setReplyPayloadMetadata(payload, { sourceReplyTranscriptMirror }),
  };
}

function createMainSourceReply(params: {
  idempotencyKey: string;
  mediaUrls?: string[];
  replyToCurrent?: boolean;
  replyToId?: string;
  text?: string;
}): TestReply {
  const { idempotencyKey, mediaUrls, replyToCurrent, replyToId, text } = params;
  return createSourceReply(
    {
      ...(text ? { text } : {}),
      ...(mediaUrls ? { mediaUrls } : {}),
      ...(replyToCurrent ? { replyToCurrent } : {}),
      ...(replyToId ? { replyToId } : {}),
    },
    {
      sessionKey: "main",
      ...(text ? { text } : {}),
      ...(mediaUrls ? { mediaUrls } : {}),
      idempotencyKey,
    },
  );
}

function setAgentRunReplies(replies: TestReply[]) {
  mockState.triggerAgentRunStart = true;
  mockState.dispatchedReplies = replies;
}

function expectManagedAudioBlock(
  block: Record<string, unknown> | undefined,
  fileName: string,
  isVoiceNote?: boolean,
) {
  expect(block).toEqual(
    expect.objectContaining({
      type: "audio",
      artifactId: expect.stringMatching(/^artifact_managed_media_/u),
      fileName,
      mimeType: "audio/mpeg",
      ...(isVoiceNote === undefined ? {} : { isVoiceNote }),
    }),
  );
}

async function runNonStreamingChatSend(params: {
  context: ChatContext;
  respond: RespondFn;
  idempotencyKey: string;
  message?: string;
  sessionKey?: string;
  deliver?: boolean;
  client?: unknown;
  expectBroadcast?: boolean;
  requestParams?: Record<string, unknown>;
  directExternal?: boolean;
  waitForCompletion?: boolean;
  waitForDedupe?: boolean;
  waitFor?: NonStreamingChatSendWaitFor;
  runtimeToolsAllow?: string[];
}): Promise<Record<string, any> | undefined> {
  const sendParams: {
    sessionKey: string;
    message: string;
    idempotencyKey: string;
    deliver?: boolean;
  } = {
    sessionKey: params.sessionKey ?? "main",
    message: params.message ?? "hello",
    idempotencyKey: params.idempotencyKey,
  };
  if (typeof params.deliver === "boolean") {
    sendParams.deliver = params.deliver;
  }
  const handler =
    params.directExternal === false
      ? handleChatSend
      : expectDefined(chatHandlers["chat.send"], 'chatHandlers["chat.send"] test invariant');
  const handlerOptions = {
    params: {
      ...sendParams,
      ...params.requestParams,
    },
    respond: params.respond,
    req: {} as never,
    client: (params.client ?? null) as never,
    isWebchatConnect: () => false,
    context: params.context,
  };
  if (params.runtimeToolsAllow) {
    await handleTrustedInternalChatSend(handlerOptions, undefined, {
      toolsAllow: params.runtimeToolsAllow,
    });
  } else {
    await handler(handlerOptions);
  }

  const waitFor =
    params.waitFor ??
    (params.waitForCompletion === false || params.waitForDedupe === false
      ? "none"
      : params.expectBroadcast === false
        ? "dedupe"
        : "broadcast");
  if (waitFor === "none") {
    return undefined;
  }
  if (waitFor === "dedupe") {
    await waitForAssertion(() => {
      expect(params.context.dedupe.has(`chat:${params.idempotencyKey}`)).toBe(true);
    });
    return undefined;
  }

  await waitForAssertion(() => {
    expect(params.context.broadcast.mock.calls.length).toBe(1);
  });

  const chatCall = mockCallAt(params.context.broadcast, 0);
  expect(chatCall?.[0]).toBe("chat");
  return chatCall?.[1] as Record<string, any> | undefined;
}

async function expectUnpersistedAgentRunFinal(params: {
  transcriptPrefix: string;
  idempotencyKey: string;
  payload: (typeof mockState.dispatchedReplies)[number]["payload"];
  staleAudio?: boolean;
  expectedMediaFailure?: { code: string; kind: string; label: string; mimeType?: string };
}) {
  const transcriptDir = await createTranscriptFixture(params.transcriptPrefix);
  const staleAudioPath = path.join(transcriptDir, "stale.mp3");
  mockState.config = { agents: { defaults: { workspace: transcriptDir } } };
  mockState.triggerAgentRunStart = true;
  mockState.dispatchedReplies = [
    {
      kind: "final",
      payload: {
        ...params.payload,
        ...(params.staleAudio
          ? {
              mediaUrl: staleAudioPath,
              mediaUrls: [staleAudioPath],
              trustedLocalMedia: true,
            }
          : {}),
      },
    },
  ];
  const { send } = createChatRequestFixture();
  await send({ idempotencyKey: params.idempotencyKey, expectBroadcast: false, waitFor: "dedupe" });

  const assistantUpdates = findAssistantTranscriptUpdates();
  const assistantEntries = readTranscriptJsonLines(mockState.transcriptPath).filter(
    (entry) =>
      (entry as { message?: { role?: string } }).message?.role === "assistant" ||
      (entry as { role?: string }).role === "assistant",
  );
  if (params.expectedMediaFailure) {
    expect(assistantEntries).toHaveLength(1);
    const message = (assistantEntries[0] as { message?: Record<string, unknown> }).message;
    const modelContent = Array.isArray(message?.content) ? message.content : [];
    expect(JSON.stringify(assistantUpdates)).toContain('"type":"attachment_error"');
    expect(JSON.stringify(assistantUpdates)).toContain(params.expectedMediaFailure.label);
    expect(JSON.stringify(assistantUpdates)).not.toContain(staleAudioPath);
    expect(JSON.stringify(modelContent)).not.toContain("attachment_error");
    expect(JSON.stringify(message?.openclawDisplayContent)).toContain("attachment_error");
    return;
  }

  // Agent-run delivery is a live projection; message_end alone owns persisted assistant turns.
  expect(assistantUpdates).toStrictEqual([]);
  expect(assistantEntries).toStrictEqual([]);
}

async function expectImageOnlyFinal(params: {
  transcriptPrefix: string;
  idempotencyKey: string;
  finalPayload: NonNullable<typeof mockState.finalPayload>;
}) {
  await createTranscriptFixture(params.transcriptPrefix);
  mockState.finalPayload = params.finalPayload;
  const { send } = createChatRequestFixture();
  const payload = await send({ idempotencyKey: params.idempotencyKey });
  const content = getMessageContent(payload);
  const mediaUrl = params.finalPayload.mediaUrl;
  if (typeof mediaUrl !== "string") {
    throw new Error("Expected an image-only final media URL");
  }
  const image = content.find((block) => block.type === "image");
  expect(getMessage(payload)?.role).toBe("assistant");
  expect(content).toHaveLength(1);
  expect(image).toMatchObject({
    type: "image",
    artifactId: expect.stringMatching(/^artifact_managed_image_/u),
    mimeType: "image/png",
    url: expect.stringMatching(/\/api\/chat\/media\/outgoing\//u),
    openUrl: expect.stringMatching(/\/api\/chat\/media\/outgoing\//u),
  });
  expect(content.some((block) => block.type === "attachment_error")).toBe(false);
  expect(JSON.stringify(content)).not.toContain(mediaUrl);
}

beforeAll(() => {
  suiteFixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-chat-directive-suite-"));
  suiteDatabasePath = path.join(suiteFixtureRoot, "openclaw-agent.sqlite");
  suiteFixtureEnv = { ...process.env, OPENCLAW_STATE_DIR: suiteFixtureRoot };
  mockState.storePath = suiteDatabasePath;
  openOpenClawAgentDatabase({
    agentId: "main",
    env: suiteFixtureEnv,
    path: suiteDatabasePath,
  });
});

afterAll(async () => {
  try {
    expect(getTotalPendingReplies()).toBe(0);
    await waitForSessionTranscriptIndexReconcile({
      agentId: "main",
      env: suiteFixtureEnv,
      path: suiteDatabasePath,
    });
  } finally {
    disposeOpenClawAgentDatabaseByPath(suiteDatabasePath, { env: suiteFixtureEnv });
    closeOpenClawStateDatabaseByPath(resolveOpenClawStateSqlitePath(suiteFixtureEnv));
    fs.rmSync(suiteFixtureRoot, { recursive: true, force: true });
  }
});

describe("chat directive tag stripping for non-streaming final payloads", () => {
  afterEach(() => {
    replyRunRegistryTesting.resetReplyRunRegistry();
    mockState.reset();
    bindingMocks.resolveByConversation.mockReset();
    bindingMocks.resolveByConversation.mockReturnValue(null);
  });

  it("carries an internal runtime tool cap into agent dispatch", async () => {
    const { send } = await createSqliteChatRequest("openclaw-chat-send-runtime-tools-");

    await send({
      idempotencyKey: "idem-runtime-tools",
      directExternal: false,
      runtimeToolsAllow: ["read"],
      waitFor: "dedupe",
    });

    expect(dispatchInboundMessageMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ toolsAllow: ["read"] }),
    );
  });

  it.each([
    ["stale", "previous-leaf"],
    ["empty", null],
  ])("rejects a %s expected active leaf before starting or writing", async (name, expectedLeaf) => {
    const { context, respond, send } = await createSqliteChatRequest(
      `openclaw-chat-send-${name}-leaf-`,
    );
    await appendTestTranscriptMessage({
      eventId: "current-leaf",
      role: "user",
      content: "existing",
      now: 1,
      parentId: null,
    });
    const before = loadTranscriptEventsSync(transcriptScope());

    await send({
      idempotencyKey: `idem-${name}-leaf`,
      requestParams: { expectedLeafEntryId: expectedLeaf },
      waitFor: "none",
    });

    expect(lastRespondCall(respond)).toEqual([
      false,
      undefined,
      expect.objectContaining({ details: { reason: "active-leaf-changed" } }),
    ]);
    expect(context.addChatRun).not.toHaveBeenCalled();
    expect(mockState.lastDispatchCtx).toBeUndefined();
    expect(loadTranscriptEventsSync(transcriptScope())).toEqual(before);
  });

  it.each([
    {
      name: "allows a same-session expected ancestor that remains on the active path",
      sessionId: "current",
      accepted: true,
    },
    {
      name: "rejects an active-path ancestor from a different requested session generation",
      sessionId: "different-session-generation",
      accepted: false,
    },
  ])("$name", async ({ sessionId, accepted }) => {
    const { context, respond, send } = await createSqliteChatRequest(
      `openclaw-chat-send-active-ancestor-${sessionId}-`,
    );
    await appendTestTranscriptMessage({
      eventId: "rendered-leaf",
      role: "assistant",
      content: "rendered",
      now: 1,
      parentId: null,
    });
    await appendTestTranscriptMessage({
      eventId: "memory-flush-user",
      role: "user",
      content: "maintenance prompt",
      display: false,
      now: 2,
      parentId: "rendered-leaf",
    });
    await appendTranscriptEvent(transcriptScope(), {
      type: "compaction",
      id: "background-compaction",
      parentId: "memory-flush-user",
      timestamp: "2026-08-10T00:00:00.000Z",
      summary: "background maintenance",
      firstKeptEntryId: "rendered-leaf",
      tokensBefore: 10,
    });
    await appendTestTranscriptMessage({
      eventId: "background-leaf",
      role: "assistant",
      content: "background append",
      display: false,
      now: 3,
      parentId: "background-compaction",
    });
    const before = loadTranscriptEventsSync(transcriptScope());

    await send({
      idempotencyKey: `idem-active-ancestor-${sessionId}`,
      requestParams: {
        expectedLeafEntryId: "rendered-leaf",
        sessionId: sessionId === "current" ? mockState.sessionId : sessionId,
      },
      waitFor: "none",
    });

    const response = expectDefined(
      lastRespondCall(respond),
      "active ancestor response test invariant",
    );
    expect(response[0]).toBe(accepted);
    expect(context.addChatRun).toHaveBeenCalledTimes(accepted ? 1 : 0);
    if (accepted) {
      expect(response[1]).toEqual(expect.objectContaining({ status: "started" }));
    } else {
      expect(response[2]).toEqual(
        expect.objectContaining({ details: { reason: "active-leaf-changed" } }),
      );
      expect(loadTranscriptEventsSync(transcriptScope())).toEqual(before);
    }
  });

  it("rejects a copied exact leaf from the session before a branch switch", async () => {
    const { context, respond, send } = await createSqliteChatRequest(
      "openclaw-chat-send-rotated-exact-leaf-",
    );
    await appendTestTranscriptMessage({
      eventId: "branch-root",
      role: "user",
      content: "root",
      now: 1,
      parentId: null,
    });
    await appendTestTranscriptMessage({
      eventId: "copied-leaf",
      role: "assistant",
      content: "selected branch",
      now: 2,
      parentId: "branch-root",
    });
    await appendTestTranscriptMessage({
      eventId: "active-sibling",
      role: "assistant",
      content: "active branch",
      now: 3,
      parentId: "branch-root",
    });
    await waitForSessionTranscriptIndexReconcile({
      agentId: "main",
      env: suiteFixtureEnv,
      path: suiteDatabasePath,
    });
    const staleSessionId = mockState.sessionId;
    const switched = await switchSessionBranch({
      agentId: "main",
      env: suiteFixtureEnv,
      leafEntryId: "copied-leaf",
      sessionKey: "agent:main:main",
      storePath: suiteDatabasePath,
    });
    expect(switched.status).toBe("created");
    if (switched.status !== "created") {
      throw new Error("expected branch switch test invariant");
    }
    expect(switched.entry.sessionId).not.toBe(staleSessionId);
    mockState.sessionId = switched.entry.sessionId;
    const before = loadTranscriptEventsSync(transcriptScope());
    expect(resolveSessionTranscriptActiveLeafEntryId(before)).toBe("copied-leaf");

    await send({
      idempotencyKey: "idem-rotated-exact-leaf",
      requestParams: {
        expectedLeafEntryId: "copied-leaf",
        sessionId: staleSessionId,
      },
      waitFor: "none",
    });

    expect(lastRespondCall(respond)).toEqual([
      false,
      undefined,
      expect.objectContaining({ details: { reason: "active-leaf-changed" } }),
    ]);
    expect(context.addChatRun).not.toHaveBeenCalled();
    expect(mockState.lastDispatchCtx).toBeUndefined();
    expect(loadTranscriptEventsSync(transcriptScope())).toEqual(before);
  });

  it("rejects an expected sibling that is off the active path", async () => {
    const { context, respond, send } = await createSqliteChatRequest(
      "openclaw-chat-send-off-path-sibling-",
    );
    await appendTestTranscriptMessage({
      eventId: "branch-root",
      role: "user",
      content: "root",
      now: 1,
      parentId: null,
    });
    await appendTestTranscriptMessage({
      eventId: "off-path-sibling",
      role: "assistant",
      content: "abandoned",
      now: 2,
      parentId: "branch-root",
    });
    await appendTestTranscriptMessage({
      eventId: "active-sibling",
      role: "assistant",
      content: "active",
      now: 3,
      parentId: "branch-root",
    });
    await waitForSessionTranscriptIndexReconcile({
      agentId: "main",
      env: suiteFixtureEnv,
      path: suiteDatabasePath,
    });
    const before = loadTranscriptEventsSync(transcriptScope());

    await send({
      idempotencyKey: "idem-off-path-sibling",
      requestParams: {
        expectedLeafEntryId: "off-path-sibling",
        sessionId: mockState.sessionId,
      },
      waitFor: "none",
    });

    expect(lastRespondCall(respond)).toEqual([
      false,
      undefined,
      expect.objectContaining({ details: { reason: "active-leaf-changed" } }),
    ]);
    expect(context.addChatRun).not.toHaveBeenCalled();
    expect(loadTranscriptEventsSync(transcriptScope())).toEqual(before);
  });

  it("allows an expected empty leaf when the transcript is still empty", async () => {
    const { context, respond, send } = await createSqliteChatRequest(
      "openclaw-chat-send-matching-empty-leaf-",
    );

    await send({
      idempotencyKey: "idem-matching-empty-leaf",
      requestParams: { expectedLeafEntryId: null },
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ status: "started" }),
      undefined,
      expect.any(Object),
    );
    expect(context.addChatRun).toHaveBeenCalledTimes(1);
    expect(mockState.lastDispatchOriginatingLeafEntryId).toBeNull();
  });

  it.each([
    ["matching", { expectedLeafEntryId: "current-leaf" }],
    ["absent", {}],
  ])("allows a %s expected active leaf", async (_name, requestParams) => {
    const { context, respond, send } = await createSqliteChatRequest(
      `openclaw-chat-send-${_name}-leaf-`,
    );
    await appendTestTranscriptMessage({
      eventId: "current-leaf",
      role: "user",
      content: "existing",
      now: 1,
      parentId: null,
    });

    await send({
      idempotencyKey: `idem-${_name}-leaf`,
      requestParams,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ status: "started" }),
      undefined,
      expect.any(Object),
    );
    expect(context.addChatRun).toHaveBeenCalledTimes(1);
  });

  it("starts one normal turn when steer admission finds no direct owner", async () => {
    const { context, respond, send } = await createSqliteChatRequest(
      "openclaw-chat-send-stale-steer-no-owner-",
    );
    await appendTestTranscriptMessage({
      eventId: "current-leaf",
      role: "assistant",
      content: "finished",
      now: 1,
      parentId: null,
    });

    await send({
      idempotencyKey: "idem-stale-steer-no-owner",
      requestParams: {
        expectedLeafEntryId: "current-leaf",
        queueMode: "steer",
      },
      waitFor: "none",
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ status: "started" }),
      undefined,
      expect.any(Object),
    );
    await waitForAssertion(() => expect(mockState.lastDispatchCtx?.BodyForAgent).toBe("hello"));
    expect(context.addChatRun).toHaveBeenCalledOnce();
  });

  it("injects targetless steer into the exact direct owner without a client run id", async () => {
    const { context, respond, send } = await createSqliteChatRequest(
      "openclaw-chat-send-targetless-no-leaf-",
    );
    const queueMessage = vi.fn(async () => {});
    const operation = beginMessageInjectionOperation({ queueMessage });

    try {
      await send({
        idempotencyKey: "idem-targetless-no-leaf",
        requestParams: { queueMode: "steer" },
        waitFor: "none",
      });
    } finally {
      operation.complete();
    }

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ status: "started" }),
      undefined,
      expect.any(Object),
    );
    expect(queueMessage).toHaveBeenCalledOnce();
    expect(context.addChatRun).toHaveBeenCalledOnce();
    expect(mockState.lastDispatchCtx).toBeUndefined();
  });

  it.each([
    ["active descendant", "agent:main:main:subagent:child", "descendant"],
    ["different session", "agent:main:telegram:direct:other", "other"],
  ])(
    "starts the selected idle session despite %s activity",
    async (_name, activeSessionKey, slug) => {
      const { context, respond, send } = await createSqliteChatRequest(
        `openclaw-chat-send-idle-${slug}-`,
      );
      const unrelated = beginActiveReplyOperation({
        sessionKey: activeSessionKey,
        sessionId: `${mockState.sessionId}-${slug}`,
      });

      try {
        await send({
          idempotencyKey: `idem-idle-${slug}`,
          requestParams: { queueMode: "steer" },
        });
      } finally {
        unrelated.complete();
      }

      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ status: "started" }),
        undefined,
        expect.any(Object),
      );
      expect(context.addChatRun).toHaveBeenCalledOnce();
      expect(unrelated.result).toEqual({ kind: "completed" });
      expect(mockState.lastMessageInjectionDisposition).toBe("rejected");
    },
  );

  it("falls back visibly when the direct owner has a non-injectable CLI backend", async () => {
    const { context, respond, send } = await createSqliteChatRequest(
      "openclaw-chat-send-cli-steer-fallback-",
    );
    const operation = beginActiveReplyOperation({
      backend: { kind: "cli", runId: "cli-run", cancel: vi.fn() },
    });

    try {
      await send({
        idempotencyKey: "idem-cli-steer-fallback",
        requestParams: { queueMode: "steer" },
      });
    } finally {
      operation.complete();
    }

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ status: "started" }),
      undefined,
      expect.any(Object),
    );
    expect(context.addChatRun).toHaveBeenCalledOnce();
    expect(mockState.lastDispatchCtx?.BodyForAgent).toBe("hello");
    expect(mockState.lastMessageInjectionDisposition).toBe("rejected");
  });

  it("deduplicates a retried targetless steer before a second injection", async () => {
    const { context, send } = await createSqliteChatRequest("openclaw-chat-send-steer-idempotent-");
    const queueMessage = vi.fn(async () => {});
    const operation = beginMessageInjectionOperation({ cancel: vi.fn(), queueMessage });

    try {
      await send({
        idempotencyKey: "idem-steer-idempotent",
        requestParams: { queueMode: "steer" },
      });
      await send({
        idempotencyKey: "idem-steer-idempotent",
        requestParams: { queueMode: "steer" },
      });
    } finally {
      operation.complete();
    }

    expect(queueMessage).toHaveBeenCalledOnce();
    expect(context.addChatRun).toHaveBeenCalledOnce();
  });

  it("injects a matching leaf-bound targetless steer through the legacy backend seam", async () => {
    const { context, respond, send } = await createSqliteChatRequest(
      "openclaw-chat-send-targetless-steer-",
    );
    await appendTestTranscriptMessage({
      eventId: "current-leaf",
      role: "assistant",
      content: "working",
      now: 1,
      parentId: null,
    });
    const queueMessage = vi.fn(async () => {});
    const operation = beginMessageInjectionOperation({
      originatingLeafEntryId: "current-leaf",
      legacy: true,
      isStopped: () => false,
      queueMessage,
    });

    try {
      await send({
        idempotencyKey: "idem-targetless-steer",
        requestParams: { expectedLeafEntryId: "current-leaf", queueMode: "steer" },
      });
    } finally {
      operation.complete();
    }

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ status: "started" }),
      undefined,
      expect.any(Object),
    );
    expect(queueMessage).toHaveBeenCalledOnce();
    expect(mockState.lastDispatchCtx).toBeUndefined();
    expect(context.addChatRun).toHaveBeenCalledOnce();
  });

  it("dispatches tool-bound input instead of injecting it into the active run", async () => {
    const { context, respond, send } = await createSqliteChatRequest(
      "openclaw-chat-send-tool-bound-dispatch-",
    );
    await appendTestTranscriptMessage({
      eventId: "current-leaf",
      role: "assistant",
      content: "working",
      now: 1,
      parentId: null,
    });
    const queueMessage = vi.fn(async () => {});
    const operation = beginMessageInjectionOperation({
      bindToolAuthority: false,
      originatingLeafEntryId: "current-leaf",
      queueMessage,
    });
    const toolBindings = { browser: { kind: "tab", tabId: 1, targetId: "target-1" } };

    try {
      await send({
        idempotencyKey: "idem-tool-bound-dispatch",
        requestParams: {
          expectedLeafEntryId: "current-leaf",
          queueMode: "steer",
          toolBindings,
        },
        client: {
          connId: "copilot",
          pairedClientId: "openclaw-browser-copilot",
          connect: {
            role: "operator",
            scopes: ["operator.read", "operator.write"],
            caps: ["run-tool-bindings"],
            client: {
              id: "openclaw-browser-copilot",
              version: "test",
              platform: "chrome",
              mode: "ui",
            },
          },
        },
        waitFor: "none",
      });
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ status: "started" }),
        undefined,
        expect.any(Object),
      );
      expect(queueMessage).not.toHaveBeenCalled();
      expect(context.addChatRun).toHaveBeenCalledOnce();
      operation.complete();
      await waitForAssertion(() =>
        expect(mockState.lastDispatchCtx?.GatewayRunToolBindings).toEqual(toolBindings),
      );
    } finally {
      operation.complete();
    }
  });

  it("falls back once without touching a successor when the captured owner ends", async () => {
    const { context, respond } = await createSqliteChatRequest(
      "openclaw-chat-send-targetless-operation-aba-",
    );
    await appendTestTranscriptMessage({
      eventId: "current-leaf",
      role: "assistant",
      content: "working",
      now: 1,
      parentId: null,
    });
    const originalQueue = vi.fn(async () => {});
    const successorQueue = vi.fn(async () => {});
    const successorCancel = vi.fn();
    const dispatchCallsBefore = dispatchInboundMessageMock.mock.calls.length;
    const original = beginMessageInjectionOperation({
      originatingLeafEntryId: "current-leaf",
      queueMessage: originalQueue,
    });
    let successor: ReturnType<typeof replyRunRegistry.begin> | undefined;

    try {
      await handleChatSend(
        {
          params: {
            sessionKey: "main",
            message: "hello",
            idempotencyKey: "idem-targetless-operation-aba",
            expectedLeafEntryId: "current-leaf",
            queueMode: "steer",
          },
          respond: respond as never,
          req: {} as never,
          client: {
            connect: {
              client: {
                id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
                mode: GATEWAY_CLIENT_MODES.WEBCHAT,
                version: "dev",
                platform: "web",
              },
              scopes: ["operator.admin"],
            },
          } as never,
          isWebchatConnect: () => false,
          context,
        },
        async () => {
          original.complete();
          successor = beginMessageInjectionOperation({
            originatingLeafEntryId: "current-leaf",
            cancel: successorCancel,
            queueMessage: successorQueue,
          });
          return true;
        },
      );
    } finally {
      original.complete();
      successor?.complete();
    }

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ status: "started" }),
      undefined,
      expect.any(Object),
    );
    await waitForAssertion(() =>
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(dispatchCallsBefore + 1),
    );
    expect(originalQueue).not.toHaveBeenCalled();
    expect(successorQueue).not.toHaveBeenCalled();
    expect(successorCancel).not.toHaveBeenCalled();
    expect(context.addChatRun).toHaveBeenCalledOnce();
    expect(mockState.lastMessageInjectionDisposition).toBe("rejected");
  });

  it("starts captured-operation injection before ACK and does not dispatch after owner clear", async () => {
    const { context, respond, send } = await createSqliteChatRequest(
      "openclaw-chat-send-steer-before-ack-",
    );
    const delivery = createDeferred();
    let reportAcceptance: ((accepted: boolean) => void) | undefined;
    const queueMessage = vi.fn((_text: string, options?: ReplyBackendQueueMessageOptions) => {
      expect(respond).not.toHaveBeenCalled();
      reportAcceptance = options?.onQueueAccepted;
      return delivery.promise;
    });
    const operation = beginMessageInjectionOperation({
      originatingLeafEntryId: null,
      runId: "active-run",
      queueMessage,
    });

    const pendingSend = send({
      idempotencyKey: "idem-steer-before-ack",
      requestParams: { queueMode: "steer" },
      waitFor: "none",
    });

    await waitForAssertion(() => expect(queueMessage).toHaveBeenCalledOnce());
    expect(respond).not.toHaveBeenCalled();
    reportAcceptance?.(true);
    await pendingSend;
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ status: "started" }),
      undefined,
      expect.any(Object),
    );
    expect(mockState.lastDispatchCtx).toBeUndefined();
    operation.complete();
    delivery.resolve();
    await waitForAssertion(() => {
      expect(context.dedupe.get("chat:idem-steer-before-ack")?.payload).toEqual({
        runId: "idem-steer-before-ack",
        status: "ok",
      });
    });
    expect(context.broadcast).toHaveBeenCalledOnce();
  });

  it("records accepted steering once across transcript, hooks, audit, and finalization", async () => {
    const { context, send } = await createSqliteChatRequest("openclaw-chat-send-steer-accounting-");
    mockState.hasMessageReceivedHooks = true;
    setSavedMediaResults(["/tmp/steer.png", "image/png"]);
    const auditEvents: Array<{ reasonCode?: unknown; runId?: unknown }> = [];
    const disposeAudit = onTrustedMessageAuditEvent((event) => auditEvents.push(event));
    const dispatchCallsBefore = dispatchInboundMessageMock.mock.calls.length;
    const queueMessage = vi.fn(async (_text: string, options?: ReplyBackendQueueMessageOptions) => {
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(dispatchCallsBefore);
      await options?.userTurnTranscriptRecorder?.persistApproved();
    });
    const operation = beginMessageInjectionOperation({
      originatingLeafEntryId: null,
      runId: "active-run",
      supportsQueueMessageImages: true,
      taskSuggestionDeliveryMode: "gateway",
      queueMessage,
    });

    try {
      await send({
        idempotencyKey: "idem-steer-accounting",
        requestParams: {
          queueMode: "steer",
          attachments: [createImageAttachment()],
        },
        client: {
          connect: {
            client: {
              id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
              mode: GATEWAY_CLIENT_MODES.WEBCHAT,
              version: "dev",
              platform: "web",
            },
            caps: [GATEWAY_CLIENT_CAPS.TASK_SUGGESTIONS],
            scopes: ["operator.admin"],
          },
        },
      });
    } finally {
      operation.complete();
      disposeAudit();
    }

    await waitForAssertion(() => expect(mockState.messageReceivedCalls).toHaveLength(1));
    expect(readPersistedUserMessages()).toHaveLength(1);
    expect(readPersistedUserMessages()[0]?.content).toBe("hello");
    expect(readPersistedUserMessages()[0]?.["__openclaw"]).toMatchObject({
      steerTargetRunId: "active-run",
    });
    const userUpdates = mockState.emittedTranscriptUpdates.filter(
      (update) => userUpdateMessage(update)?.role === "user",
    );
    expect(userUpdates).toHaveLength(2);
    expect(userUpdateMessage(userUpdates[0])).not.toHaveProperty("__openclaw.steerTargetRunId");
    expect(userUpdateMessage(userUpdates[1])).toHaveProperty(
      "__openclaw.steerTargetRunId",
      "active-run",
    );
    expect(queueMessage).toHaveBeenCalledWith(
      "hello",
      expect.objectContaining({
        images: [expect.objectContaining({ mimeType: "image/png" })],
        imageOrder: ["inline"],
        taskSuggestionDeliveryMode: "gateway",
        userTurnTranscriptRecorder: expect.any(Object),
      }),
    );
    expect(auditEvents).toContainEqual(
      expect.objectContaining({
        reasonCode: "active_run_injected",
        runId: "idem-steer-accounting",
      }),
    );
    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(dispatchCallsBefore);
    expect(context.broadcast).toHaveBeenCalledOnce();
  });

  it("records the resolved run for accepted leaf-only steering", async () => {
    const { send } = await createSqliteChatRequest("openclaw-chat-send-leaf-steer-provenance-");
    const queueMessage = vi.fn(async (_text: string, options?: ReplyBackendQueueMessageOptions) => {
      await options?.userTurnTranscriptRecorder?.persistApproved();
    });
    const operation = beginMessageInjectionOperation({
      originatingLeafEntryId: null,
      runId: "active-run",
      queueMessage,
    });

    try {
      await send({
        idempotencyKey: "idem-leaf-steer-provenance",
        requestParams: { expectedLeafEntryId: null, queueMode: "steer" },
      });
    } finally {
      operation.complete();
    }

    expect(queueMessage).toHaveBeenCalledOnce();
    expect(readPersistedUserMessages()).toHaveLength(1);
    expect(readPersistedUserMessages()[0]?.["__openclaw"]).toMatchObject({
      steerTargetRunId: "active-run",
    });
  });

  it("hydrates and accepts reply injection before ACK without waiting for delivery", async () => {
    const { context, respond, send } = await createSqliteChatRequest(
      "openclaw-chat-send-reply-steer-",
    );
    mockState.hasMessageReceivedHooks = true;
    const hydration = createDeferred();
    mockState.replyContextWait = hydration.promise;
    mockState.replyContextResult = {
      ReplyToId: "prior-message",
      ReplyToBody: "quoted deployment status",
      ReplyToSender: "Alice",
    };
    const auditEvents: Array<{ reasonCode?: unknown }> = [];
    const disposeAudit = onTrustedMessageAuditEvent((event) => auditEvents.push(event));
    const delivery = createDeferred();
    let reportAcceptance: ((accepted: boolean) => void) | undefined;
    const queueMessage = vi.fn((_text: string, options?: ReplyBackendQueueMessageOptions) => {
      reportAcceptance = options?.onQueueAccepted;
      return delivery.promise;
    });
    const operation = beginMessageInjectionOperation({
      originatingLeafEntryId: "current-leaf",
      runId: "run-a",
      queueMessage,
    });

    try {
      const pendingSend = send({
        idempotencyKey: "idem-reply-steer",
        requestParams: {
          queueMode: "steer",
          replyToId: "prior-message",
        },
        waitFor: "none",
      });

      await waitForAssertion(() => expect(mockState.replyContextCalls).toBe(1));
      expect(queueMessage).not.toHaveBeenCalled();
      expect(respond).not.toHaveBeenCalled();

      hydration.resolve();
      await waitForAssertion(() => expect(queueMessage).toHaveBeenCalledOnce());
      expect(queueMessage.mock.calls[0]?.[0]).toContain("Reply target of current user message:");
      expect(queueMessage.mock.calls[0]?.[0]).toContain("quoted deployment status");
      expect(queueMessage.mock.calls[0]?.[0]).toContain("hello");
      expect(respond).not.toHaveBeenCalled();

      reportAcceptance?.(true);
      await pendingSend;
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ status: "started" }),
        undefined,
        expect.any(Object),
      );
      expect(context.broadcast).not.toHaveBeenCalled();
      expect(mockState.lastDispatchCtx).toBeUndefined();

      delivery.resolve();
      await waitForAssertion(() => expect(context.broadcast).toHaveBeenCalledOnce());
    } finally {
      hydration.resolve();
      delivery.resolve();
      operation.complete();
      disposeAudit();
    }

    expect(mockState.messageReceivedCalls).toHaveLength(1);
    expect(readPersistedUserMessages()).toHaveLength(1);
    expect(readPersistedUserMessages()[0]?.["__openclaw"]).toMatchObject({
      replyToId: "prior-message",
      replyToPreview: {
        text: "quoted deployment status",
        senderLabel: "Alice",
      },
    });
    expect(auditEvents.filter((event) => event.reasonCode === "active_run_injected")).toHaveLength(
      1,
    );
    expect(mockState.replyContextCalls).toBe(1);
    expect(mockState.lastDispatchCtx).toBeUndefined();
    expect(context.broadcast).toHaveBeenCalledOnce();
  });

  it("falls back once when reply hydration outlives its captured run", async () => {
    const { context, respond, send } = await createSqliteChatRequest(
      "openclaw-chat-send-reply-steer-race-",
    );
    const hydration = createDeferred();
    mockState.replyContextWait = hydration.promise;
    mockState.replyContextResult = {
      ReplyToId: "prior-message",
      ReplyToBody: "quoted deployment status",
      ReplyToSender: "Alice",
    };
    const dispatchCallsBefore = dispatchInboundMessageMock.mock.calls.length;
    const originalQueue = vi.fn(async () => {});
    const successorQueue = vi.fn(async () => {});
    const successorCancel = vi.fn();
    const original = beginMessageInjectionOperation({
      originatingLeafEntryId: "current-leaf",
      runId: "run-a",
      queueMessage: originalQueue,
    });
    let successor: ReturnType<typeof replyRunRegistry.begin> | undefined;

    try {
      const pendingSend = send({
        idempotencyKey: "idem-reply-steer-race",
        requestParams: {
          queueMode: "steer",
          replyToId: "prior-message",
        },
        waitFor: "none",
      });
      await waitForAssertion(() => expect(mockState.replyContextCalls).toBe(1));
      expect(respond).not.toHaveBeenCalled();
      expect(originalQueue).not.toHaveBeenCalled();
      original.complete();
      successor = beginMessageInjectionOperation({
        originatingLeafEntryId: "current-leaf",
        runId: "run-b",
        cancel: successorCancel,
        queueMessage: successorQueue,
      });
      hydration.resolve();
      await pendingSend;
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ status: "started" }),
        undefined,
        expect.any(Object),
      );
      await waitForAssertion(() => {
        expect(context.dedupe.get("chat:idem-reply-steer-race")?.payload).toMatchObject({
          status: "ok",
        });
      });
    } finally {
      hydration.resolve();
      original.complete();
      successor?.complete();
    }

    expect(originalQueue).not.toHaveBeenCalled();
    expect(successorQueue).not.toHaveBeenCalled();
    expect(successorCancel).not.toHaveBeenCalled();
    expect(mockState.replyContextCalls).toBe(1);
    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(dispatchCallsBefore + 1);
    expect(mockState.lastMessageInjectionDisposition).toBe("rejected");
    expect(readPersistedUserMessages()).toHaveLength(1);
    expect(
      (readPersistedUserMessages()[0]?.["__openclaw"] as Record<string, unknown> | undefined)
        ?.steerTargetRunId,
    ).toBeUndefined();
    const broadcasts = context.broadcast.mock.calls.map(
      ([, payload]) => payload as Record<string, unknown>,
    );
    expect(broadcasts.filter((payload) => payload.state === "error")).toEqual([]);
  });

  it("keeps ordinary reply hydration after ACK when no injection target was captured", async () => {
    const { context, respond, send } = await createSqliteChatRequest(
      "openclaw-chat-send-reply-no-steer-",
    );
    const hydration = createDeferred();
    mockState.replyContextWait = hydration.promise;
    mockState.replyContextResult = {
      ReplyToId: "prior-message",
      ReplyToBody: "quoted deployment status",
      ReplyToSender: "Alice",
    };

    const pendingSend = send({
      idempotencyKey: "idem-reply-no-steer",
      requestParams: { replyToId: "prior-message" },
      waitFor: "none",
    });
    try {
      await waitForAssertion(() => expect(mockState.replyContextCalls).toBe(1));
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ status: "started" }),
        undefined,
        expect.any(Object),
      );
      expect(mockState.lastDispatchCtx).toBeUndefined();
      await pendingSend;

      hydration.resolve();
      await waitForAssertion(() => {
        expect(context.dedupe.get("chat:idem-reply-no-steer")?.payload).toMatchObject({
          status: "ok",
        });
      });
    } finally {
      hydration.resolve();
    }

    expect(mockState.replyContextCalls).toBe(1);
    expect(mockState.lastDispatchCtx).toMatchObject({
      ReplyToId: "prior-message",
      ReplyToBody: "quoted deployment status",
      ReplyToSender: "Alice",
    });
  });

  it("falls back once when captured injection rejects acceptance", async () => {
    const { context, respond, send } = await createSqliteChatRequest(
      "openclaw-chat-send-steer-reject-",
    );
    mockState.finalText = "fallback reply";
    const dispatchCallsBefore = dispatchInboundMessageMock.mock.calls.length;
    const delivery = createDeferred();
    const queueMessage = vi.fn((_text: string, options?: ReplyBackendQueueMessageOptions) => {
      options?.onQueueAccepted?.(false);
      return delivery.promise;
    });
    const operation = beginMessageInjectionOperation({
      originatingLeafEntryId: null,
      runId: "active-run",
      queueMessage,
    });

    await send({
      idempotencyKey: "idem-steer-reject",
      requestParams: { queueMode: "steer" },
      waitFor: "none",
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ status: "started" }),
      undefined,
      expect.any(Object),
    );
    delivery.reject(new Error("native turn ended"));
    operation.complete();

    await waitForAssertion(() => {
      expect(context.dedupe.get("chat:idem-steer-reject")?.payload).toEqual({
        runId: "idem-steer-reject",
        status: "ok",
      });
    });
    expect(queueMessage).toHaveBeenCalledOnce();
    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(dispatchCallsBefore + 1);
    expect(mockState.lastDispatchCtx?.BodyForAgent).toBe("hello");
  });

  it("never aborts or replays onto a successor after unconfirmed acceptance", async () => {
    const { context, send } = await createSqliteChatRequest(
      "openclaw-chat-send-steer-unconfirmed-",
    );
    const delivery = createDeferred<{
      transcriptCommit: "unconfirmed";
      errorMessage: string;
    }>();
    const queueMessage = vi.fn(async (_text: string, options?: ReplyBackendQueueMessageOptions) => {
      options?.onQueueAccepted?.(true);
      await options?.userTurnTranscriptRecorder?.persistApproved();
      return await delivery.promise;
    });
    const first = beginMessageInjectionOperation({
      originatingLeafEntryId: null,
      runId: "active-run",
      cancel: vi.fn(),
      queueMessage,
    });

    await send({
      idempotencyKey: "idem-steer-unconfirmed",
      requestParams: { queueMode: "steer" },
      waitFor: "none",
    });
    await waitForAssertion(() => expect(readPersistedUserMessages()).toHaveLength(1));
    expect(readPersistedUserMessages()[0]).not.toHaveProperty("__openclaw.steerTargetRunId");
    first.complete();
    const successorCancel = vi.fn();
    const successor = beginMessageInjectionOperation({
      originatingLeafEntryId: null,
      runId: "successor-run",
      cancel: successorCancel,
      queueMessage: vi.fn(async () => {}),
    });
    delivery.resolve({
      transcriptCommit: "unconfirmed",
      errorMessage: "receipt timed out",
    });

    await waitForAssertion(() => {
      expect(context.dedupe.get("chat:idem-steer-unconfirmed")?.payload).toEqual({
        runId: "idem-steer-unconfirmed",
        status: "ok",
      });
    });
    expect(successor.result).toBeNull();
    expect(successorCancel).not.toHaveBeenCalled();
    expect(mockState.lastDispatchCtx).toBeUndefined();
    const persistedUsers = readPersistedUserMessages();
    expect(persistedUsers).toHaveLength(1);
    expect(
      (persistedUsers[0]?.["__openclaw"] as Record<string, unknown> | undefined)?.steerTargetRunId,
    ).toBeUndefined();
    successor.complete();
  });

  it("ACKs and dispatches once when captured injection throws synchronously", async () => {
    const { respond, send } = await createSqliteChatRequest(
      "openclaw-chat-send-steer-sync-reject-",
    );
    const dispatchCallsBefore = dispatchInboundMessageMock.mock.calls.length;
    const queueMessage = vi.fn((): Promise<void> => {
      expect(respond).not.toHaveBeenCalled();
      throw new Error("synchronous rejection");
    });
    const operation = beginMessageInjectionOperation({
      originatingLeafEntryId: null,
      runId: "active-run",
      queueMessage,
    });

    try {
      await send({
        idempotencyKey: "idem-steer-sync-reject",
        requestParams: { queueMode: "steer" },
      });
    } finally {
      operation.complete();
    }

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ status: "started" }),
      undefined,
      expect.any(Object),
    );
    expect(queueMessage).toHaveBeenCalledOnce();
    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(dispatchCallsBefore + 1);
  });

  it("falls back once when captured owner evidence is stale", async () => {
    const { context, respond, send } = await createSqliteChatRequest(
      "openclaw-chat-send-steer-stale-owner-",
    );
    await appendTestTranscriptMessage({
      eventId: "current-leaf",
      role: "assistant",
      content: "stale tool work",
      now: 1,
      parentId: null,
    });
    const dispatchCallsBefore = dispatchInboundMessageMock.mock.calls.length;
    vi.useFakeTimers({ toFake: ["Date"] });
    const staleQueue = vi.fn(async () => {});
    const staleCancel = vi.fn();
    const operation = beginMessageInjectionOperation({
      originatingLeafEntryId: "leaf-before-stale-run-output",
      runId: "active-run",
      cancel: staleCancel,
      isStreaming: () => false,
      isStopped: () => false,
      legacy: true,
      queueMessage: staleQueue,
    });

    try {
      vi.advanceTimersByTime(RUN_STALE_TAKEOVER_MS + 1);
      await send({
        idempotencyKey: "idem-steer-stale-owner",
        requestParams: {
          expectedLeafEntryId: "current-leaf",
          queueMode: "steer",
        },
        waitFor: "none",
      });
    } finally {
      operation.complete();
      vi.useRealTimers();
    }

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ status: "started" }),
      undefined,
      expect.any(Object),
    );
    await waitForAssertion(() =>
      expect(context.dedupe.get("chat:idem-steer-stale-owner")?.payload).toMatchObject({
        status: "ok",
      }),
    );
    expect(context.addChatRun).toHaveBeenCalledOnce();
    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(dispatchCallsBefore + 1);
    expect(mockState.lastMessageInjectionDisposition).toBe("rejected");
    expect(staleQueue).not.toHaveBeenCalled();
    expect(staleCancel).not.toHaveBeenCalled();
    expect(readPersistedUserMessages()).toHaveLength(1);
    expect(
      context.broadcast.mock.calls.filter(
        ([, payload]) => (payload as { state?: unknown }).state === "error",
      ),
    ).toEqual([]);
  });

  it("broadcasts session metadata changes reported by chat command dispatch", async () => {
    await createTranscriptFixture("openclaw-chat-send-session-metadata-");
    mockState.sessionEntry = {
      goal: {
        status: "active",
        objective: "ship session updates",
      },
    };
    mockState.sessionMetadataChanges = [
      {
        sessionKey: "agent:main:main",
        reason: "command-metadata",
      },
    ];
    const { context } = await sendNewChatRequest({
      idempotencyKey: "idem-command-session-metadata",
      message: "/goal pause waiting",
      waitFor: "none",
    });

    await waitForAssertion(() => {
      expect(
        context.broadcastToConnIds.mock.calls.map(
          ([, payload]) => (payload as { reason?: unknown }).reason,
        ),
      ).toEqual(["command-metadata", "chat.run.settled"]);
    });
    const call = mockCallAt(context.broadcastToConnIds, 0);
    const payload = call?.[1] as { ts?: unknown } | undefined;
    expect(call?.[0]).toBe("sessions.changed");
    expect(call?.[2]).toEqual(new Set(["conn-1"]));
    expect(call?.[3]).toEqual({ agentId: "main", dropIfSlow: true });
    expect(payload).toMatchObject({
      sessionKey: "agent:main:main",
      reason: "command-metadata",
    });
    expect(typeof payload?.ts).toBe("number");
    expect(mockCallAt(context.broadcastToConnIds, 1)).toEqual([
      "sessions.changed",
      expect.objectContaining({
        sessionKey: "agent:main:main",
        agentId: "main",
        reason: "chat.run.settled",
        ts: expect.any(Number),
      }),
      new Set(["conn-1"]),
      { agentId: "main", dropIfSlow: true },
    ]);
    await waitForAssertion(() => {
      expect(context.dedupe.has("chat:idem-command-session-metadata")).toBe(true);
    });
  });

  it("broadcasts session metadata changes before later command dispatch failure", async () => {
    await createTranscriptFixture("openclaw-chat-send-session-metadata-error-");
    mockState.sessionMetadataChanges = [
      {
        sessionKey: "agent:main:main",
        reason: "command-metadata",
      },
    ];
    mockState.dispatchErrorAfterDelivery = new Error("delivery failed after metadata");
    const { context } = await sendNewChatRequest({
      idempotencyKey: "idem-command-session-metadata-error",
      message: "/goal pause waiting",
      expectBroadcast: false,
    });

    await waitForAssertion(() => {
      expect(context.dedupe.get("chat:idem-command-session-metadata-error")?.ok).toBe(false);
    });
    const call = mockCallAt(context.broadcastToConnIds, 0);
    expect(call?.[0]).toBe("sessions.changed");
    expect(call?.[1]).toMatchObject({
      sessionKey: "agent:main:main",
      reason: "command-metadata",
    });
  });

  it("persists non-agent delivery mirrors with the chat send idempotency key", async () => {
    await createTranscriptFixture("openclaw-chat-send-final-idem-");
    mockState.finalText = "mirror text";
    await sendNewChatRequest({
      idempotencyKey: "idem-final-mirror",
      expectBroadcast: false,
    });

    const persistedAssistant = readTranscriptJsonLines(mockState.transcriptPath)
      .map((entry) => entry.message)
      .find(
        (message): message is Record<string, unknown> =>
          Boolean(message) &&
          typeof message === "object" &&
          (message as { role?: unknown }).role === "assistant",
      );
    expect(persistedAssistant?.idempotencyKey).toBe("idem-final-mirror");
  });

  it("persists non-agent delivery mirrors to SQLite without creating active JSONL", async () => {
    await withSqliteTranscriptFixtureState("openclaw-chat-send-final-sqlite-", async () => {
      mockState.finalText = "sqlite mirror text";
      const { send } = createChatRequestFixture();

      await send({
        idempotencyKey: "idem-final-sqlite",
        expectBroadcast: false,
      });
      expect(fs.existsSync(mockState.transcriptPath)).toBe(false);
      const assistantEntries = await readActiveAssistantTranscriptMessages();
      expect(assistantEntries).toHaveLength(1);
      expect(assistantEntries[0]?.idempotencyKey).toBe("idem-final-sqlite");
      expect(JSON.stringify(assistantEntries[0])).toContain("sqlite mirror text");
    });
  });

  it("persists non-agent plugin-bound replies in the binding-owned session", async () => {
    await createTranscriptFixture("openclaw-chat-send-plugin-binding-history-");
    const targetSessionKey = "plugin-binding:codex:history123";
    const targetSessionId = "plugin-binding-history-session";
    await replaceSessionEntry(
      {
        agentId: "main",
        sessionKey: `agent:main:${targetSessionKey}`,
        storePath: mockState.storePath,
      },
      { sessionId: targetSessionId, updatedAt: Date.now() },
    );
    mockState.sessionIdsByKey.set(targetSessionKey, targetSessionId);
    mockState.finalPayload = setReplyPayloadMetadata(
      {
        text: "bound history reply",
        mediaUrl: `data:image/png;base64,${TINY_PNG_BASE64}`,
      },
      {
        sourceReplyTranscriptMirror: {
          sessionKey: targetSessionKey,
          agentId: "main",
          expectedSessionId: targetSessionId,
        },
      },
    );
    await sendNewChatRequest({
      idempotencyKey: "idem-plugin-binding-history",
      expectBroadcast: false,
    });

    expect(mockState.loadSessionEntryCalls).toContainEqual({
      rawKey: targetSessionKey,
      opts: { agentId: "main" },
    });
    const assistantUpdate = mockState.emittedTranscriptUpdates.find(
      (update) => (update.message as { role?: unknown } | undefined)?.role === "assistant",
    );
    expect(assistantUpdate?.target).toMatchObject({
      agentId: "main",
      sessionKey: `agent:main:${targetSessionKey}`,
    });
    expect(JSON.stringify(assistantUpdate?.message)).toContain(
      `/api/chat/media/outgoing/${encodeURIComponent(targetSessionKey)}/`,
    );
    expect(JSON.stringify(assistantUpdate?.message)).not.toContain(
      "/api/chat/media/outgoing/agent%3Amain%3Amain/",
    );
  });

  it("replaces failed managed media with bounded visible guidance", async () => {
    await createTranscriptFixture("openclaw-chat-send-managed-media-failure-");
    const source = "data:audio/mpeg;base64,not-valid!";
    mockState.finalPayload = { mediaUrl: source };
    const { payload } = await sendNewChatRequest({
      idempotencyKey: "idem-managed-media-failure",
    });

    const serialized = JSON.stringify(payload?.message);
    expect(serialized).toContain('"type":"attachment_error"');
    expect(serialized).toContain('"code":"delivery-failed"');
    expect(serialized).toContain('"label":"Generated audio 1"');
    expect(serialized).not.toContain(source);
    expect(Buffer.byteLength(serialized)).toBeLessThan(1_024);
    const assistantEntries = await readActiveAssistantTranscriptMessages();
    expect(JSON.stringify(assistantEntries)).not.toContain(source);
  });

  it("keeps managed media failures visible when rewriting an existing assistant row", async () => {
    await createTranscriptFixture("openclaw-chat-send-managed-media-partial-failure-");
    const mediaUrl = `data:image/png;base64,${TINY_PNG_BASE64}`;
    const mirrorKey = "idem-managed-media-partial-failure:internal-source-reply:0";
    await appendSourceReplyMirrorEntry({
      idempotencyKey: mirrorKey,
      text: `Artifacts ready\nMEDIA:${mediaUrl}`,
    });
    const sourceReply = createMainSourceReply({
      idempotencyKey: mirrorKey,
      text: "Artifacts ready\n⚠️ report.7z: Delivery failed. Try sending this file again.",
      mediaUrls: [mediaUrl],
    });
    setReplyPayloadMetadata(sourceReply.payload, {
      assistantMediaFailures: [
        {
          code: "delivery-failed",
          kind: "document",
          label: "report.7z",
          mimeType: "application/x-7z-compressed",
        },
      ],
    });
    setAgentRunReplies([sourceReply]);
    const { send } = createChatRequestFixture();

    await send({
      idempotencyKey: "idem-managed-media-partial-failure",
      message: "hello from codex",
    });

    const rawAssistantEntries = await readRawActiveAssistantTranscriptMessages();
    const assistantEntries = rawAssistantEntries.map(projectAssistantDisplayContent);
    expect(JSON.stringify(rawAssistantEntries[0]?.content)).not.toContain("attachment_error");
    expect(JSON.stringify(assistantEntries[0])).toContain('"type":"attachment_error"');
    expect(JSON.stringify(assistantEntries[0])).toContain('"label":"report.7z"');
    expect(JSON.stringify(assistantEntries[0])).not.toContain("Media failed");
    expect(JSON.stringify(assistantEntries[0])).not.toContain("MEDIA:");
  });

  it("does not cross a plugin-bound session rotation during finalization", async () => {
    await createTranscriptFixture("openclaw-chat-send-plugin-binding-rotation-");
    const targetSessionKey = "plugin-binding:codex:rotated";
    mockState.finalPayload = setReplyPayloadMetadata(
      { text: "stale bound reply" },
      {
        sourceReplyTranscriptMirror: {
          sessionKey: targetSessionKey,
          agentId: "main",
          expectedSessionId: "previous-bound-session",
        },
      },
    );
    const { context } = await sendNewChatRequest({
      idempotencyKey: "idem-plugin-binding-rotation",
      expectBroadcast: false,
    });

    expect(
      mockState.emittedTranscriptUpdates.some(
        (update) => (update.message as { role?: unknown } | undefined)?.role === "assistant",
      ),
    ).toBe(false);
    expect(context.logGateway.warn).toHaveBeenCalledWith(
      "webchat transcript append skipped: binding-owned session changed before finalization",
    );
  });

  it("keeps a twice-raced plugin-bound turn out of source history", async () => {
    await createTranscriptFixture("openclaw-chat-send-plugin-binding-blocked-");
    mockState.finalPayload = setReplyPayloadMetadata(
      { text: "live reply without durable turn" },
      {
        sourceReplyTranscriptMirror: {
          sessionKey: "plugin-binding:codex:blocked",
          agentId: "main",
          transcriptWriteBlocked: true,
        },
      },
    );
    const { context } = await sendNewChatRequest({
      idempotencyKey: "idem-plugin-binding-blocked",
      expectBroadcast: false,
    });

    expect(mockState.emittedTranscriptUpdates).toHaveLength(0);
    expect(context.logGateway.warn).toHaveBeenCalledWith(
      "webchat transcript append skipped: binding-owned user turn was not persisted",
    );
  });

  it("does not fall back to source history for partial binding transcript metadata", async () => {
    await createTranscriptFixture("openclaw-chat-send-plugin-binding-partial-");
    const targetSessionKey = "plugin-binding:codex:partial";
    mockState.dispatchedReplies = [
      {
        kind: "final",
        payload: setReplyPayloadMetadata(
          { text: "bound reply" },
          {
            sourceReplyTranscriptMirror: {
              sessionKey: targetSessionKey,
              agentId: "main",
              expectedSessionId: mockState.sessionId,
            },
          },
        ),
      },
      { kind: "final", payload: { text: "derived reply without owner" } },
    ];
    const { context } = await sendNewChatRequest({
      idempotencyKey: "idem-plugin-binding-partial",
      expectBroadcast: false,
    });

    expect(
      mockState.emittedTranscriptUpdates.some(
        (update) => (update.message as { role?: unknown } | undefined)?.role === "assistant",
      ),
    ).toBe(false);
    expect(context.logGateway.warn).toHaveBeenCalledWith(
      "webchat transcript append skipped: inconsistent binding-owned transcript metadata",
    );
  });

  it("keeps legacy source-reply mirror metadata on source history", async () => {
    await createTranscriptFixture("openclaw-chat-send-source-mirror-legacy-");
    mockState.finalPayload = setReplyPayloadMetadata(
      { text: "legacy source reply" },
      {
        sourceReplyTranscriptMirror: {
          sessionKey: "main",
          text: "legacy source reply",
          idempotencyKey: "legacy-source-reply",
        },
      },
    );
    const { context } = await sendNewChatRequest({
      idempotencyKey: "idem-source-mirror-legacy",
      expectBroadcast: false,
    });

    const assistantUpdate = mockState.emittedTranscriptUpdates.find(
      (update) => (update.message as { role?: unknown } | undefined)?.role === "assistant",
    );
    expect(assistantUpdate?.target).toMatchObject({
      agentId: "main",
      sessionKey: "agent:main:main",
    });
    expect(context.logGateway.warn).not.toHaveBeenCalledWith(
      "webchat transcript append skipped: inconsistent binding-owned transcript metadata",
    );
  });

  it("registers tool-event recipients for clients advertising tool-events capability", async () => {
    await createReadyChatTranscript("openclaw-chat-send-tool-events-");
    mockState.triggerAgentRunStart = true;
    mockState.agentRunId = "run-current";
    const { context, send } = createChatRequestFixture();
    context.chatAbortControllers.set("run-same-session", {
      controller: new AbortController(),
      sessionId: "sess-prev",
      sessionKey: "agent:main:main",
      startedAtMs: Date.now(),
      expiresAtMs: Date.now() + 10_000,
    });
    context.chatAbortControllers.set("run-other-session", {
      controller: new AbortController(),
      sessionId: "sess-other",
      sessionKey: "other",
      startedAtMs: Date.now(),
      expiresAtMs: Date.now() + 10_000,
    });

    await send({
      idempotencyKey: "idem-tool-events-on",
      client: {
        connId: "conn-1",
        connect: { caps: [GATEWAY_CLIENT_CAPS.TOOL_EVENTS] },
      },
      expectBroadcast: false,
    });

    const register = context.registerToolEventRecipient;
    expect(register).toHaveBeenCalledWith("run-current", "conn-1");
    expect(register).toHaveBeenCalledWith("run-same-session", "conn-1");
    expect(register).not.toHaveBeenCalledWith("run-other-session", "conn-1");
  });

  it("registers default global tool-event recipients for unscoped global sends", async () => {
    await createTranscriptFixture("openclaw-chat-send-global-tool-events-");
    useGlobalSessionScope();
    mockState.finalText = "ok";
    mockState.triggerAgentRunStart = true;
    mockState.agentRunId = "run-current-global";
    const { context, send } = createChatRequestFixture();
    context.chatAbortControllers.set("run-default-global", {
      controller: new AbortController(),
      sessionId: "sess-default-global",
      sessionKey: "global",
      startedAtMs: Date.now(),
      expiresAtMs: Date.now() + 10_000,
    });
    context.chatAbortControllers.set("run-work-global", {
      controller: new AbortController(),
      sessionId: "sess-work-global",
      sessionKey: "global",
      agentId: "work",
      startedAtMs: Date.now(),
      expiresAtMs: Date.now() + 10_000,
    });

    await send({
      sessionKey: "global",
      idempotencyKey: "idem-global-tool-events",
      client: {
        connId: "conn-global",
        connect: { caps: [GATEWAY_CLIENT_CAPS.TOOL_EVENTS] },
      },
      expectBroadcast: false,
    });

    const register = context.registerToolEventRecipient;
    expect(register).toHaveBeenCalledWith("run-current-global", "conn-global");
    expect(register).toHaveBeenCalledWith("run-default-global", "conn-global");
    expect(register).not.toHaveBeenCalledWith("run-work-global", "conn-global");
  });

  it("registers selected global alias tool-event recipients against the canonical run key", async () => {
    await createTranscriptFixture("openclaw-chat-send-global-alias-tool-events-");
    useGlobalSessionScope();
    mockState.sessionEntry = { canonicalKey: "global" };
    mockState.finalText = "ok";
    mockState.triggerAgentRunStart = true;
    mockState.agentRunId = "run-current-work-global";
    const { context, send } = createChatRequestFixture();
    context.chatAbortControllers.set("run-default-global", {
      controller: new AbortController(),
      sessionId: "sess-default-global",
      sessionKey: "global",
      startedAtMs: Date.now(),
      expiresAtMs: Date.now() + 10_000,
    });
    context.chatAbortControllers.set("run-work-global", {
      controller: new AbortController(),
      sessionId: "sess-work-global",
      sessionKey: "global",
      agentId: "work",
      startedAtMs: Date.now(),
      expiresAtMs: Date.now() + 10_000,
    });

    await send({
      sessionKey: "agent:work:main",
      idempotencyKey: "idem-global-alias-tool-events",
      client: {
        connId: "conn-work",
        connect: { caps: [GATEWAY_CLIENT_CAPS.TOOL_EVENTS] },
      },
      expectBroadcast: false,
    });

    const register = context.registerToolEventRecipient;
    expect(register).toHaveBeenCalledWith("run-current-work-global", "conn-work");
    expect(register).toHaveBeenCalledWith("run-work-global", "conn-work");
    expect(register).not.toHaveBeenCalledWith("run-default-global", "conn-work");
  });

  it("scopes selected-agent global aliases before loading chat session state", async () => {
    await createTranscriptFixture("openclaw-chat-send-global-alias-load-");
    useGlobalSessionScope();
    mockState.sessionEntry = { canonicalKey: "global" };
    const { send } = createChatRequestFixture();

    await send({
      sessionKey: "agent:work:main",
      idempotencyKey: "idem-global-alias-load",
      expectBroadcast: false,
    });

    expect(mockState.loadSessionEntryCalls[0]).toEqual({
      rawKey: "agent:work:main",
      opts: { agentId: "work" },
    });
  });

  it("accepts selected-agent global main aliases before loading chat session state", async () => {
    await createTranscriptFixture("openclaw-chat-send-global-main-alias-load-");
    useGlobalSessionScope();
    mockState.sessionEntry = { canonicalKey: "global" };
    const { respond } = await sendNewChatRequest({
      sessionKey: "main",
      requestParams: { agentId: "work" },
      idempotencyKey: "idem-global-main-alias-load",
      expectBroadcast: false,
    });

    const [ok] = lastRespondCall(respond) ?? [];
    expect(ok).toBe(true);
    expect(mockState.lastDispatchCtx).toMatchObject({
      SessionKey: "global",
      AgentId: "work",
    });
    expect(mockState.loadSessionEntryCalls[0]).toEqual({
      rawKey: "main",
      opts: { agentId: "work" },
    });
  });

  it("resolves per-sender global agent aliases to the canonical agent main session", async () => {
    await createTranscriptFixture("openclaw-chat-send-per-sender-global-alias-");
    mockState.config = {
      agents: { list: [{ id: "main", default: true }] },
      session: { scope: "per-sender" },
    };
    const { respond } = await sendNewChatRequest({
      sessionKey: "global",
      requestParams: { agentId: "main" },
      idempotencyKey: "idem-per-sender-global-alias",
      expectBroadcast: false,
    });

    const [ok] = lastRespondCall(respond) ?? [];
    expect(ok).toBe(true);
    expect(mockState.lastDispatchCtx).toMatchObject({
      SessionKey: "agent:main:main",
      AgentId: "main",
    });
    expect(mockState.loadSessionEntryCalls.length).toBeGreaterThan(0);
    expect(mockState.loadSessionEntryCalls).toEqual(
      expect.arrayContaining([
        {
          rawKey: "agent:main:main",
          opts: { agentId: "main" },
        },
      ]),
    );
    expect(mockState.loadSessionEntryCalls).not.toEqual(
      expect.arrayContaining([
        {
          rawKey: "global",
          opts: { agentId: "main" },
        },
      ]),
    );
  });

  it("registers selected-agent global aliases under the canonical abort key", async () => {
    await createTranscriptFixture("openclaw-chat-send-global-alias-abort-key-");
    useGlobalSessionScope();
    mockState.sessionEntry = { canonicalKey: "global" };
    let releaseDispatch: (() => void) | undefined;
    mockState.dispatchWait = new Promise((resolve) => {
      releaseDispatch = resolve;
    });
    const { context, send } = createChatRequestFixture();

    const pending = send({
      sessionKey: "agent:work:main",
      idempotencyKey: "idem-global-alias-abort-key",
      waitFor: "none",
    });

    await waitForAssertion(() => {
      expect(context.chatAbortControllers.get("idem-global-alias-abort-key")).toMatchObject({
        sessionKey: "global",
        agentId: "work",
      });
    });
    releaseDispatch?.();
    await pending;
  });

  it("scopes chat history global aliases before loading session state", async () => {
    await createTranscriptFixture("openclaw-chat-history-global-alias-load-");
    useGlobalSessionScope();
    mockState.sessionEntry = { canonicalKey: "global" };
    const { context, respond } = createChatRequestFixture();
    mockState.loadSessionEntryCalls = [];

    await expectDefined(
      chatHandlers["chat.history"],
      'chatHandlers["chat.history"] test invariant',
    )({
      params: { sessionKey: "agent:work:main" },
      respond: respond as never,
      req: {} as never,
      client: null,
      isWebchatConnect: () => false,
      context,
    });

    expect(mockState.loadSessionEntryCalls).toContainEqual({
      rawKey: "agent:work:main",
      opts: { agentId: "work", clone: false, includeStoreChildEntries: true, projection: "list" },
    });
  });

  it("returns the rendered history branch leaf in session info", async () => {
    await createGatewayUserTurnSqliteFixture("openclaw-chat-history-active-leaf-");
    await appendTranscriptMessage(transcriptScope(), {
      eventId: "history-active-leaf",
      message: { role: "user", content: "render this branch" },
      now: 1,
      parentId: null,
    });
    const respond = vi.fn();

    await expectDefined(
      chatHandlers["chat.history"],
      'chatHandlers["chat.history"] test invariant',
    )({
      params: { sessionKey: "main" },
      respond: respond as never,
      req: {} as never,
      client: null,
      isWebchatConnect: () => false,
      context: createChatContext(),
    });

    expect(lastRespondCall(respond)?.[1]).toMatchObject({
      sessionInfo: { activeLeafEntryId: "history-active-leaf" },
    });
  });

  it("does not register tool-event recipients without tool-events capability", async () => {
    await createReadyChatTranscript("openclaw-chat-send-tool-events-off-");
    mockState.triggerAgentRunStart = true;
    mockState.agentRunId = "run-no-cap";
    const { context, send } = createChatRequestFixture();

    await send({
      idempotencyKey: "idem-tool-events-off",
      client: {
        connId: "conn-2",
        connect: { caps: [] },
      },
      expectBroadcast: false,
    });

    const register = context.registerToolEventRecipient;
    expect(register).not.toHaveBeenCalled();
  });

  it("persists agent-run audio replies emitted as media-bearing block payloads", async () => {
    const { audioPath } = await createAudioTranscriptFixture(
      "openclaw-chat-send-agent-audio-",
      "reply.mp3",
    );
    setAgentRunReplies([
      {
        kind: "block",
        payload: {
          mediaUrl: audioPath,
          mediaUrls: [audioPath],
          trustedLocalMedia: true,
        },
      },
    ]);
    const { send } = createChatRequestFixture();

    await send({
      idempotencyKey: "idem-agent-audio",
      expectBroadcast: false,
      waitFor: "none",
    });

    await waitForAssertion(() => {
      const assistantUpdate = findAssistantUpdateWithBlock((block) => block.type === "audio");
      const message = assistantUpdate?.message as Record<string, any> | undefined;
      const content = Array.isArray(message?.content)
        ? (message.content as Array<Record<string, any>>)
        : [];
      expect(message?.role).toBe("assistant");
      expect(message?.idempotencyKey).toBe("idem-agent-audio:assistant-media");
      expect(content[0]).toEqual({ type: "text", text: "Audio reply" });
      expect(content[1]).toEqual(
        expect.objectContaining({
          type: "audio",
          artifactId: expect.stringMatching(/^artifact_managed_media_/u),
          fileName: "reply.mp3",
          mimeType: "audio/mpeg",
        }),
      );
      expect(JSON.stringify(content[1])).not.toContain(fs.realpathSync(audioPath));
    });
  });

  it("replaces reply-to-current with an explicit id on a runtime-owned media rewrite", async () => {
    await withTranscriptFixtureState("openclaw-chat-send-owned-media-", async (fixtureDir) => {
      const mediaUrl = `data:image/png;base64,${TINY_PNG_BASE64}`;
      writeSavedPng(fixtureDir, "reply.png");
      await appendSourceReplyMirrorEntry({
        idempotencyKey: "older-distinct-assistant",
        text: "A distinct earlier reply.",
        provider: "openai",
        model: "codex",
      });
      await appendSourceReplyMirrorEntry({
        idempotencyKey: "runtime-owned-assistant",
        openclawDelivery: { audioAsVoice: true, replyToCurrent: true },
        text: `Dinner options\nMEDIA:${mediaUrl}`,
        provider: "openai",
        model: "codex",
      });
      setAgentRunReplies([
        {
          kind: "final",
          payload: setReplyPayloadMetadata(
            {
              text: "Dinner options",
              mediaUrl,
              mediaUrls: [mediaUrl],
              replyToId: "3114cf3c-e628-4c33-9214-894a1d8b6c60",
            },
            {
              assistantTranscriptOwned: true,
              assistantTranscriptIdempotencyKey: "runtime-owned-assistant",
            },
          ),
        },
      ]);
      const { send } = createChatRequestFixture();

      await send({
        idempotencyKey: "idem-owned-media",
        expectBroadcast: false,
        waitFor: "dedupe",
      });

      const messages = await readActiveAssistantTranscriptMessages();
      expect(messages.map((message) => message.idempotencyKey)).toEqual([
        "older-distinct-assistant",
        "runtime-owned-assistant",
      ]);
      const rewritten = messages[1];
      const content = Array.isArray(rewritten?.content)
        ? (rewritten.content as Array<Record<string, unknown>>)
        : [];
      expect(content[0]).toEqual({ type: "text", text: "Dinner options" });
      expect(content.filter((block) => block.type === "image")).toHaveLength(1);
      expect(rewritten?.openclawDelivery).toEqual({
        audioAsVoice: true,
        mediaUrls: [mediaUrl],
        replyToId: "3114cf3c-e628-4c33-9214-894a1d8b6c60",
      });
      expect(JSON.stringify(rewritten)).not.toContain("[[reply_to:");
      expect(JSON.stringify(messages)).not.toContain(":assistant-media");
    });
  });

  it("persists agent media only after a disposed attempt transcript owner has unwound", async () => {
    await withTranscriptFixtureState(
      "openclaw-chat-send-disposed-media-owner-",
      async (fixtureDir) => {
        const mediaUrl = writeSavedPng(fixtureDir, "reply.png");
        await appendSourceReplyMirrorEntry({
          text: `Stale reply\nMEDIA:${mediaUrl}`,
          provider: "openai",
          model: "gpt-5.6-luna",
          now: Date.now(),
        });
        mockState.triggerAgentRunStart = true;
        mockState.disposedTranscriptWriteContext = true;
        mockState.dispatchErrorAfterDelivery = new Error("after media delivery");
        mockState.runtimeAssistantContentBeforeDelivery = [
          { type: "thinking", thinking: "preserve runtime reasoning" },
          { type: "text", text: "Earlier chunk" },
          { type: "text", text: "[[reply_to_current]] Image reply" },
          { type: "text", text: `MEDIA:${mediaUrl}` },
          { type: "toolCall", id: "call-1", name: "read", arguments: {} },
        ];
        mockState.runtimeAssistantTextsBeforeDelivery = [`Later reply\nMEDIA:${mediaUrl}`];
        mockState.dispatchedReplies = [
          {
            kind: "final",
            payload: setReplyPayloadMetadata(
              {
                text: "Image reply",
                mediaUrl,
                mediaUrls: [mediaUrl],
              },
              { assistantMessageIndex: 1, assistantTranscriptMediaUrls: [mediaUrl] },
            ),
          },
        ];
        const { send } = createChatRequestFixture();

        await send({
          idempotencyKey: "idem-disposed-media-owner",
          expectBroadcast: false,
          waitFor: "dedupe",
        });

        const messages = await readActiveAssistantTranscriptMessages();
        const rawMessages = await readRawActiveAssistantTranscriptMessages();
        expect(messages).toHaveLength(3);
        expect(messages[0]?.content).toEqual([
          { type: "text", text: `Stale reply\nMEDIA:${mediaUrl}` },
        ]);
        expect(messages[1]?.idempotencyKey).toBeUndefined();
        const content = Array.isArray(messages[1]?.content)
          ? (messages[1].content as Array<Record<string, unknown>>)
          : [];
        expect(content.filter((block) => block.type === "text")).toEqual([
          { type: "text", text: "Earlier chunk" },
          { type: "text", text: "Image reply" },
        ]);
        expect(content.filter((block) => block.type === "image")).toHaveLength(1);
        expect(content.map((block) => block.type)).toEqual([
          "thinking",
          "text",
          "text",
          "image",
          "toolCall",
        ]);
        expect(rawMessages[1]?.content).toEqual([
          { type: "thinking", thinking: "preserve runtime reasoning" },
          { type: "text", text: "Earlier chunk" },
          { type: "text", text: "Image reply" },
          { type: "toolCall", id: "call-1", name: "read", arguments: {} },
        ]);
        expect(JSON.stringify(content)).toContain("artifact_managed_image_");
        expect(JSON.stringify(content)).not.toContain("MEDIA:");
        expect(messages[1]?.openclawDelivery).toEqual({ mediaUrls: [mediaUrl] });
        expect(JSON.stringify(messages)).not.toContain(":assistant-media");
        expect(messages[2]?.content).toEqual([
          { type: "text", text: `Later reply\nMEDIA:${mediaUrl}` },
        ]);
        expect(mockState.disposedTranscriptWriteAttempts).toBe(0);
      },
    );
  });

  it("materializes each distinct assistant media row once", async () => {
    await withTranscriptFixtureState(
      "openclaw-chat-send-multiple-assistant-media-",
      async (fixtureDir) => {
        const firstMediaUrl = writeSavedPng(fixtureDir, "first.png");
        const secondMediaUrl = writeSavedPng(fixtureDir, "second.png");
        await appendSourceReplyMirrorEntry({
          text: "Older assistant reply",
          provider: "openai",
          model: "gpt-5.6-luna",
          now: Date.now(),
        });
        mockState.triggerAgentRunStart = true;
        mockState.runtimeAssistantTextsBeforeDelivery = [
          `First image\nMEDIA:${firstMediaUrl}`,
          `Second image\nMEDIA:${secondMediaUrl}`,
        ];
        mockState.dispatchedReplies = [
          {
            kind: "block",
            payload: setReplyPayloadMetadata(
              { text: "First image", mediaUrl: firstMediaUrl, mediaUrls: [firstMediaUrl] },
              {
                assistantMessageIndex: 1,
                assistantTranscriptMediaUrls: [firstMediaUrl],
              },
            ),
          },
          {
            kind: "final",
            payload: setReplyPayloadMetadata(
              { text: "Second image", mediaUrl: secondMediaUrl, mediaUrls: [secondMediaUrl] },
              {
                assistantMessageIndex: 2,
                assistantTranscriptMediaUrls: [secondMediaUrl],
              },
            ),
          },
        ];
        const { send } = createChatRequestFixture();

        await send({
          idempotencyKey: "idem-multiple-assistant-media",
          expectBroadcast: false,
          waitFor: "dedupe",
        });

        const messages = await readActiveAssistantTranscriptMessages();
        expect(messages).toHaveLength(3);
        expect(messages[0]?.content).toEqual([{ type: "text", text: "Older assistant reply" }]);
        for (const [index, expectedText] of ["First image", "Second image"].entries()) {
          const message = messages[index + 1];
          const content = Array.isArray(message?.content)
            ? (message.content as Array<Record<string, unknown>>)
            : [];
          expect(content.filter((block) => block.type === "text")).toEqual([
            { type: "text", text: expectedText },
          ]);
          expect(content.filter((block) => block.type === "image")).toHaveLength(1);
          expect(JSON.stringify(content)).not.toContain("MEDIA:");
        }
        expect(JSON.stringify(messages)).not.toContain(":assistant-media");
      },
    );
  });

  it("persists auto-TTS final media as audio-only so webchat does not duplicate assistant text", async () => {
    const { audioPath } = await createAudioTranscriptFixture("openclaw-chat-send-agent-tts-final-");
    setAgentRunReplies([
      {
        kind: "final",
        payload: {
          text: "This text is already in the model transcript.",
          spokenText: "This text is already in the model transcript.",
          mediaUrl: audioPath,
          mediaUrls: [audioPath],
          trustedLocalMedia: true,
          audioAsVoice: true,
          ttsSupplement: { spokenText: "This text is already in the model transcript." },
        },
      },
    ]);
    const { send } = createChatRequestFixture();

    await send({
      idempotencyKey: "idem-agent-tts",
      expectBroadcast: false,
      waitFor: "dedupe",
    });

    const assistantUpdates = findAssistantTranscriptUpdates();
    expect(assistantUpdates).toHaveLength(1);
    const message = assistantUpdates[0]?.message as Record<string, any> | undefined;
    const content = Array.isArray(message?.content)
      ? (message.content as Array<Record<string, any>>)
      : [];
    expect(message?.role).toBe("assistant");
    expect(message?.idempotencyKey).toBe("idem-agent-tts:assistant-media");
    expect(content[0]).toEqual({ type: "text", text: "Audio reply" });
    expect(content[1]).toEqual(
      expect.objectContaining({
        type: "audio",
        artifactId: expect.stringMatching(/^artifact_managed_media_/u),
        fileName: "tts.mp3",
        mimeType: "audio/mpeg",
      }),
    );
    expect(JSON.stringify(content[1])).not.toContain(fs.realpathSync(audioPath));
    expect(JSON.stringify(assistantUpdates[0]?.message)).not.toContain(
      "This text is already in the model transcript.",
    );
  });

  it("keeps text while excluding the failure card from durable history for agent-run media", async () => {
    await expectUnpersistedAgentRunFinal({
      transcriptPrefix: "openclaw-chat-send-agent-stale-tts-",
      idempotencyKey: "idem-stale-agent-media",
      payload: {
        text: "Text-only test: one clean reply, no TTS, no media, no tool narration.",
      },
      staleAudio: true,
      expectedMediaFailure: {
        code: "delivery-failed",
        kind: "audio",
        label: "stale.mp3",
        mimeType: "audio/mpeg",
      },
    });
  });

  it("does not mirror normal agent-run final text from live delivery", async () => {
    await expectUnpersistedAgentRunFinal({
      transcriptPrefix: "openclaw-chat-send-agent-text-only-",
      idempotencyKey: "idem-agent-text-only",
      payload: { text: "It's 11:52 AM EDT." },
    });
  });

  it("broadcasts agent-run internal-ui source replies without duplicating transcript", async () => {
    await createTranscriptFixture("openclaw-chat-send-agent-source-reply-");
    const mirrorIdempotencyKey = "idem-agent-source-reply:internal-source-reply:0";
    await appendSourceReplyMirrorEntry({
      idempotencyKey: mirrorIdempotencyKey,
      text: "Codex source reply",
    });
    const sourceReply = createMainSourceReply({
      idempotencyKey: mirrorIdempotencyKey,
      text: "Codex source reply",
    });
    setAgentRunReplies([sourceReply]);
    const { context, payload: broadcast } = await sendNewChatRequest({
      idempotencyKey: "idem-agent-source-reply",
      message: "hello from codex",
    });

    expect(broadcast).toMatchObject({
      runId: "idem-agent-source-reply",
      sessionKey: "agent:main:main",
      state: "final",
    });
    expect(extractFirstTextBlock(broadcast)).toBe("Codex source reply");
    const nodeSend = lastNodeSendCall(context);
    expect(nodeSend?.[0]).toBe("agent:main:main");
    expect(nodeSend?.[1]).toBe("chat");
    expect(extractFirstTextBlock(nodeSend?.[2])).toBe("Codex source reply");
    const assistantUpdates = findAssistantTranscriptUpdates();
    expect(assistantUpdates).toStrictEqual([]);
    const assistantEntries = await readActiveAssistantTranscriptMessages();
    expect(assistantEntries.map((entry) => entry.idempotencyKey)).toStrictEqual([
      mirrorIdempotencyKey,
    ]);
  });

  it("broadcasts a writer-owned settled fallback that is already in the transcript", async () => {
    await createTranscriptFixture("openclaw-chat-send-settled-fallback-");
    const idempotencyKey = "run-settled:settled-finalization-fallback";
    const text =
      "The tool run finished, but no final summary was produced. I did not repeat any completed actions.";
    await appendSourceReplyMirrorEntry({ idempotencyKey, text });
    mockState.sessionEntry = {
      lifecycleRevision: "revision-a",
      activeWriterRunId: "run-settled",
    };
    setAgentRunReplies([
      {
        kind: "final",
        payload: setReplyPayloadMetadata({ text }, {
          assistantTranscriptOwned: true,
          assistantTranscriptIdempotencyKey: idempotencyKey,
          deliverDespiteSourceReplySuppression: true,
          sessionWriterDeliveryAuthority: {
            agentId: "main",
            expectedLifecycleRevision: "revision-a",
            expectedSessionId: mockState.sessionId,
            expectedWriterRunId: "run-settled",
            sessionKey: "main",
            storePath: mockState.storePath,
          },
        } as never),
      },
    ]);
    const { context, send } = createChatRequestFixture();

    await send({
      idempotencyKey: "idem-settled-fallback",
      waitFor: "dedupe",
    });

    expect(extractFirstTextBlock(lastBroadcastPayload(context))).toBe(text);
    expect(await readActiveAssistantTranscriptMessages()).toHaveLength(1);
  });

  it("drops a settled fallback when its writer is replaced after transcript persistence", async () => {
    await createTranscriptFixture("openclaw-chat-send-stale-settled-fallback-");
    const idempotencyKey = "run-settled:settled-finalization-fallback";
    const text =
      "The tool run finished, but no final summary was produced. I did not repeat any completed actions.";
    await appendSourceReplyMirrorEntry({ idempotencyKey, text });
    mockState.sessionEntry = {
      lifecycleRevision: "revision-a",
      activeWriterRunId: "run-settled",
    };
    mockState.onAfterAgentRunStart = () => {
      mockState.sessionEntry = {
        lifecycleRevision: "revision-a",
        activeWriterRunId: "replacement-run",
      };
    };
    const sourceReply = createMainSourceReply({ idempotencyKey, text });
    setReplyPayloadMetadata(sourceReply.payload, {
      assistantTranscriptOwned: true,
      assistantTranscriptIdempotencyKey: idempotencyKey,
      sessionWriterDeliveryAuthority: {
        agentId: "main",
        expectedLifecycleRevision: "revision-a",
        expectedSessionId: mockState.sessionId,
        expectedWriterRunId: "run-settled",
        sessionKey: "main",
        storePath: mockState.storePath,
      },
    } as never);
    setAgentRunReplies([sourceReply]);
    const { context, send } = createChatRequestFixture();

    await send({
      idempotencyKey: "idem-stale-settled-fallback",
      waitFor: "dedupe",
    });

    expect(context.broadcast).not.toHaveBeenCalled();
    expect(context.nodeSendToSession).not.toHaveBeenCalled();
    expect(await readActiveAssistantTranscriptMessages()).toHaveLength(1);
  });

  it("broadcasts agent-run status notices without source reply mirrors", async () => {
    await createTranscriptFixture("openclaw-chat-send-agent-status-notice-");
    setAgentRunReplies([
      {
        kind: "final",
        payload: {
          text: "⚙️ Codex compaction started • Context 2k/200k",
          isStatusNotice: true,
        },
      },
    ]);
    const { payload: broadcast } = await sendNewChatRequest({
      idempotencyKey: "idem-agent-status-notice",
      message: "/compact",
    });

    expect(broadcast).toMatchObject({
      runId: "idem-agent-status-notice",
      sessionKey: "agent:main:main",
      state: "final",
    });
    expect(extractFirstTextBlock(broadcast)).toBe("⚙️ Codex compaction started • Context 2k/200k");
    const assistantEntries = await readActiveAssistantTranscriptMessages();
    expect(assistantEntries).toStrictEqual([]);
  });

  it("broadcasts a block status once while ignoring an ordinary agent final", async () => {
    await createTranscriptFixture("openclaw-chat-send-agent-block-status-notice-");
    setAgentRunReplies([
      {
        kind: "block",
        payload: {
          text: "Model set to openai/gpt-5.5 for this session.",
          isStatusNotice: true,
        },
      },
      {
        kind: "final",
        payload: {
          text: "ordinary provider final",
        },
      },
    ]);
    const { context, payload: broadcast } = await sendNewChatRequest({
      idempotencyKey: "idem-agent-block-status-notice",
      message: "/model openai/gpt-5.5 keep going",
    });

    expect(broadcast).toMatchObject({
      runId: "idem-agent-block-status-notice",
      sessionKey: "agent:main:main",
      state: "final",
    });
    expect(extractFirstTextBlock(broadcast)).toBe("Model set to openai/gpt-5.5 for this session.");
    expect(context.broadcast.mock.calls).toHaveLength(1);
    expect(findAssistantTranscriptUpdates()).toStrictEqual([]);
    expect(await readActiveAssistantTranscriptMessages()).toStrictEqual([]);
  });

  it("ignores non-status block and final payloads during source finalization", async () => {
    await createTranscriptFixture("openclaw-chat-send-agent-non-status-replies-");
    setAgentRunReplies([
      {
        kind: "block",
        payload: {
          text: "ordinary block",
        },
      },
      {
        kind: "final",
        payload: {
          text: "ordinary final",
        },
      },
    ]);
    const { context } = await sendNewChatRequest({
      idempotencyKey: "idem-agent-non-status-replies",
      expectBroadcast: false,
      waitFor: "dedupe",
    });

    expect(context.broadcast.mock.calls).toStrictEqual([]);
    expect(findAssistantTranscriptUpdates()).toStrictEqual([]);
    expect(await readActiveAssistantTranscriptMessages()).toStrictEqual([]);
  });

  it("replaces an explicit reply id with reply-to-current on a source reply rewrite", async () => {
    await withTranscriptFixtureState(
      "openclaw-chat-send-agent-source-reply-media-",
      async (fixtureDir) => {
        const mediaUrl = `data:image/png;base64,${TINY_PNG_BASE64}`;
        writeSavedPng(fixtureDir, "source-reply.png");
        const mirrorIdempotencyKey = "idem-agent-source-reply-media:internal-source-reply:0";
        const updatedAt = Date.parse("2026-05-18T11:00:00.000Z");
        const rewrittenAt = Date.parse("2026-05-18T11:05:00.000Z");
        await seedSqliteSessionEntry({
          sessionFile: mockState.transcriptPath,
          updatedAt,
          status: "done",
        });
        await appendSourceReplyMirrorEntry({
          idempotencyKey: mirrorIdempotencyKey,
          openclawDelivery: { audioAsVoice: true, replyToId: "stale-reply-id" },
          text: "Codex source reply with media",
        });
        const sourceReply = createMainSourceReply({
          idempotencyKey: mirrorIdempotencyKey,
          text: "Codex source reply with media",
          mediaUrls: [mediaUrl],
          replyToCurrent: true,
        });
        setAgentRunReplies([sourceReply]);
        const { send } = createChatRequestFixture();

        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(rewrittenAt);
        try {
          const broadcast = await send({
            idempotencyKey: "idem-agent-source-reply-media",
            message: "hello from codex",
          });

          expect(broadcast).toMatchObject({
            runId: "idem-agent-source-reply-media",
            sessionKey: "agent:main:main",
            state: "final",
          });
          expect(extractFirstTextBlock(broadcast)).toBe("Codex source reply with media");
          const broadcastContent = getMessageContent(broadcast);
          expect(String(broadcastContent[1]?.url)).toContain("/api/chat/media/outgoing/");
          expect(String(broadcastContent[1]?.openUrl)).toContain("/api/chat/media/outgoing/");
          const assistantUpdates = findAssistantTranscriptUpdates();
          expect(assistantUpdates).toStrictEqual([]);
          const assistantEntries = await readActiveAssistantTranscriptMessages();
          expect(assistantEntries).toHaveLength(1);
          expect(assistantEntries[0]?.idempotencyKey).toBe(mirrorIdempotencyKey);
          expect(JSON.stringify(assistantEntries[0])).toContain("/api/chat/media/outgoing/");
          expect(JSON.stringify(assistantEntries[0]?.content)).not.toContain(mediaUrl);
          expect(assistantEntries[0]?.openclawDelivery).toEqual({
            audioAsVoice: true,
            mediaUrls: [mediaUrl],
            replyToCurrent: true,
          });
          expect(JSON.stringify(assistantEntries[0])).not.toContain("[[reply_to:");
          const entry = readSqliteMainSessionEntry();
          expect(entry?.updatedAt).toBeGreaterThanOrEqual(rewrittenAt);
          expect(entry?.updatedAt).toBeGreaterThan(updatedAt);
          expect(entry?.status).toBe("done");
        } finally {
          vi.useRealTimers();
        }
      },
    );
  });

  it("rewrites source reply mirrors in SQLite without creating active JSONL", async () => {
    await withSqliteTranscriptFixtureState(
      "openclaw-chat-send-agent-source-reply-sqlite-",
      async (fixtureDir) => {
        const mediaUrl = `data:image/png;base64,${TINY_PNG_BASE64}`;
        writeSavedPng(fixtureDir, "source-reply-sqlite.png");
        const mirrorIdempotencyKey = "idem-source-reply-sqlite:internal-source-reply:0";
        await appendSourceReplyMirrorEntry({
          idempotencyKey: mirrorIdempotencyKey,
          text: "SQLite source reply with media",
        });
        setAgentRunReplies([
          createMainSourceReply({
            idempotencyKey: mirrorIdempotencyKey,
            text: "SQLite source reply with media",
            mediaUrls: [mediaUrl],
          }),
        ]);
        const { send } = createChatRequestFixture();

        await send({
          idempotencyKey: "idem-source-reply-sqlite",
          message: "hello from codex",
        });

        expect(fs.existsSync(mockState.transcriptPath)).toBe(false);
        const assistantEntries = await readActiveAssistantTranscriptMessages();
        expect(assistantEntries).toHaveLength(1);
        expect(assistantEntries[0]?.idempotencyKey).toBe(mirrorIdempotencyKey);
        expect(JSON.stringify(assistantEntries[0])).toContain("/api/chat/media/outgoing/");
        expect(JSON.stringify(assistantEntries[0]?.content)).not.toContain(mediaUrl);
      },
    );
  });

  it("backs source reply media with an equivalent deduped delivery mirror", async () => {
    await withTranscriptFixtureState(
      "openclaw-chat-send-agent-source-reply-deduped-",
      async (fixtureDir) => {
        const mediaUrl = `data:image/png;base64,${TINY_PNG_BASE64}`;
        const replyText = "Source reply with media";
        writeSavedPng(fixtureDir, "source-reply-deduped.png");
        const mirrorIdempotencyKey = "idem-agent-source-reply-deduped:internal-source-reply:0";
        await appendSourceReplyMirrorEntry({
          text:
            resolveMirroredTranscriptText({ text: replyText, mediaUrls: [mediaUrl] }) ?? "media",
        });
        setAgentRunReplies([
          createMainSourceReply({
            idempotencyKey: mirrorIdempotencyKey,
            text: replyText,
            mediaUrls: [mediaUrl],
          }),
        ]);
        const { send } = createChatRequestFixture();

        const broadcast = await send({
          idempotencyKey: "idem-agent-source-reply-deduped",
          message: "hello from codex",
        });

        const broadcastContent = getMessageContent(broadcast);
        expect(broadcastContent.filter((block) => block.type === "image")).toHaveLength(1);
        expect(JSON.stringify(broadcastContent)).toContain("/api/chat/media/outgoing/");
        const assistantEntries = await readActiveAssistantTranscriptMessages();
        expect(assistantEntries).toHaveLength(1);
        expect(assistantEntries[0]?.idempotencyKey).toBe(mirrorIdempotencyKey);
        expect(JSON.stringify(assistantEntries[0])).toContain(replyText);
        expect(JSON.stringify(assistantEntries[0])).toContain("/api/chat/media/outgoing/");
        expect(JSON.stringify(assistantEntries[0]?.content)).not.toContain(mediaUrl);
      },
    );
  });

  it("updates each media-bearing source reply mirror independently", async () => {
    await withTranscriptFixtureState(
      "openclaw-chat-send-agent-source-reply-multi-",
      async (fixtureDir) => {
        const firstMediaUrl = `data:image/png;base64,${TINY_PNG_BASE64}`;
        const secondMediaUrl = `data:image/png;base64,${TINY_PNG_BASE64}`;
        writeSavedPng(fixtureDir, "source-reply-1.png");
        writeSavedPng(fixtureDir, "source-reply-2.png");
        const firstMirrorKey = "idem-agent-source-reply-multi:internal-source-reply:0";
        const secondMirrorKey = "idem-agent-source-reply-multi:internal-source-reply:1";
        await appendSourceReplyMirrorEntry({
          idempotencyKey: firstMirrorKey,
          text: "First source reply",
        });
        await appendSourceReplyMirrorEntry({
          idempotencyKey: secondMirrorKey,
          text: "Second source reply",
        });
        setAgentRunReplies([
          createMainSourceReply({
            idempotencyKey: firstMirrorKey,
            text: "First source reply",
            mediaUrls: [firstMediaUrl],
          }),
          createMainSourceReply({
            idempotencyKey: secondMirrorKey,
            text: "Second source reply",
            mediaUrls: [secondMediaUrl],
          }),
        ]);
        const { send } = createChatRequestFixture();

        const broadcast = await send({
          idempotencyKey: "idem-agent-source-reply-multi",
          message: "hello from codex",
        });

        const broadcastContent = getMessageContent(broadcast);
        expect(broadcastContent.filter((block) => block.type === "image")).toHaveLength(2);
        expect(mockState.savedMediaCalls).toHaveLength(2);
        const assistantEntries = await readActiveAssistantTranscriptMessages();
        expect(assistantEntries.map((entry) => entry.idempotencyKey)).toStrictEqual([
          firstMirrorKey,
          secondMirrorKey,
        ]);
        expect(JSON.stringify(assistantEntries[0])).toContain("/api/chat/media/outgoing/");
        expect(JSON.stringify(assistantEntries[1])).toContain("/api/chat/media/outgoing/");
        expect(JSON.stringify(assistantEntries[0]?.content)).not.toContain(firstMediaUrl);
        expect(JSON.stringify(assistantEntries[1]?.content)).not.toContain(secondMediaUrl);
      },
    );
  });

  it("keeps backed media source replies when a sibling mirror is missing", async () => {
    await withTranscriptFixtureState(
      "openclaw-chat-send-agent-source-reply-partial-",
      async (fixtureDir) => {
        const firstMediaUrl = `data:image/png;base64,${TINY_PNG_BASE64}`;
        const secondMediaUrl = `data:image/png;base64,${TINY_PNG_BASE64}`;
        writeSavedPng(fixtureDir, "source-reply-backed.png");
        writeSavedPng(fixtureDir, "source-reply-missing.png");
        const backedMirrorKey = "idem-agent-source-reply-partial:internal-source-reply:0";
        const missingMirrorKey = "idem-agent-source-reply-partial:internal-source-reply:1";
        await appendSourceReplyMirrorEntry({
          idempotencyKey: backedMirrorKey,
          text: "Backed source reply",
        });
        setAgentRunReplies([
          createMainSourceReply({
            idempotencyKey: backedMirrorKey,
            text: "Backed source reply",
            mediaUrls: [firstMediaUrl],
          }),
          createMainSourceReply({
            idempotencyKey: missingMirrorKey,
            text: "Missing mirror source reply",
            mediaUrls: [secondMediaUrl],
          }),
        ]);
        const { send } = createChatRequestFixture();

        const broadcast = await send({
          idempotencyKey: "idem-agent-source-reply-partial",
          message: "hello from codex",
        });

        const broadcastContent = getMessageContent(broadcast);
        expect(broadcastContent.filter((block) => block.type === "image")).toHaveLength(1);
        expect(extractFirstTextBlock(broadcast)).toBe("Backed source reply");
        expect(String(broadcastContent[1]?.url)).toContain("/api/chat/media/outgoing/");
        const assistantEntries = await readActiveAssistantTranscriptMessages();
        expect(assistantEntries).toHaveLength(1);
        expect(assistantEntries[0]?.idempotencyKey).toBe(backedMirrorKey);
        expect(JSON.stringify(assistantEntries[0])).toContain("/api/chat/media/outgoing/");
        expect(JSON.stringify(assistantEntries[0]?.content)).not.toContain(firstMediaUrl);
        expect(JSON.stringify(broadcastContent)).not.toContain(secondMediaUrl);
      },
    );
  });

  it("keeps media source replies when followed by text-only source reply mirrors", async () => {
    await withTranscriptFixtureState(
      "openclaw-chat-send-agent-source-reply-text-tail-",
      async (fixtureDir) => {
        const mediaUrl = `data:image/png;base64,${TINY_PNG_BASE64}`;
        writeSavedPng(fixtureDir, "source-reply-text-tail.png");
        const mediaMirrorKey = "idem-agent-source-reply-text-tail:internal-source-reply:0";
        const textMirrorKey = "idem-agent-source-reply-text-tail:internal-source-reply:1";
        await appendSourceReplyMirrorEntry({
          idempotencyKey: mediaMirrorKey,
          text: "Media source reply",
        });
        await appendSourceReplyMirrorEntry({
          idempotencyKey: textMirrorKey,
          text: "Text-only source reply",
        });
        setAgentRunReplies([
          createMainSourceReply({
            idempotencyKey: mediaMirrorKey,
            text: "Media source reply",
            mediaUrls: [mediaUrl],
          }),
          createMainSourceReply({
            idempotencyKey: textMirrorKey,
            text: "Text-only source reply",
          }),
        ]);
        const { send } = createChatRequestFixture();

        const broadcast = await send({
          idempotencyKey: "idem-agent-source-reply-text-tail",
          message: "hello from codex",
        });

        const broadcastContent = getMessageContent(broadcast);
        expect(broadcastContent.filter((block) => block.type === "image")).toHaveLength(1);
        expect(mockState.savedMediaCalls).toHaveLength(1);
        const assistantEntries = await readActiveAssistantTranscriptMessages();
        expect(assistantEntries.map((entry) => entry.idempotencyKey)).toStrictEqual([
          mediaMirrorKey,
          textMirrorKey,
        ]);
        expect(JSON.stringify(assistantEntries[0])).toContain("/api/chat/media/outgoing/");
        expect(JSON.stringify(assistantEntries[1])).toContain("Text-only source reply");
      },
    );
  });

  it("does not rewrite unrelated assistant messages with colliding source reply keys", async () => {
    await withTranscriptFixtureState(
      "openclaw-chat-send-agent-source-reply-collision-",
      async (fixtureDir) => {
        const mediaUrl = `data:image/png;base64,${TINY_PNG_BASE64}`;
        writeSavedPng(fixtureDir, "source-reply-collision.png");
        const collidingMirrorKey = "idem-agent-source-reply-collision:internal-source-reply:0";
        await appendSourceReplyMirrorEntry({
          idempotencyKey: collidingMirrorKey,
          text: "Existing assistant content",
          model: "gateway-injected",
        });
        setAgentRunReplies([
          createMainSourceReply({
            idempotencyKey: collidingMirrorKey,
            text: "Source reply with media",
            mediaUrls: [mediaUrl],
          }),
        ]);
        const { send } = createChatRequestFixture();

        const broadcast = await send({
          idempotencyKey: "idem-agent-source-reply-collision",
          message: "hello from codex",
        });

        expect(JSON.stringify(getMessageContent(broadcast))).not.toContain(
          "/api/chat/media/outgoing/",
        );
        const assistantEntries = await readActiveAssistantTranscriptMessages();
        expect(assistantEntries).toHaveLength(1);
        expect(assistantEntries[0]?.content).toStrictEqual([
          { type: "text", text: "Existing assistant content" },
        ]);
        expect(assistantEntries[0]?.model).toBe("gateway-injected");
      },
    );
  });

  it("does not expose raw media refs when an unbacked source reply has no text", async () => {
    await withTranscriptFixtureState(
      "openclaw-chat-send-agent-source-reply-media-only-",
      async (fixtureDir) => {
        const mediaUrl = `data:image/png;base64,${TINY_PNG_BASE64}`;
        writeSavedPng(fixtureDir, "source-reply-media-only.png");
        const missingMirrorKey = "idem-agent-source-reply-media-only:internal-source-reply:0";
        setAgentRunReplies([
          createMainSourceReply({ idempotencyKey: missingMirrorKey, mediaUrls: [mediaUrl] }),
        ]);
        const { send } = createChatRequestFixture();

        const broadcast = await send({
          idempotencyKey: "idem-agent-source-reply-media-only",
          message: "hello from codex",
        });

        expect(extractFirstTextBlock(broadcast)).toBe("Media reply could not be displayed.");
        const broadcastJson = JSON.stringify(broadcast);
        expect(broadcastJson).not.toContain("MEDIA:");
        expect(broadcastJson).not.toContain(mediaUrl);
        expect(broadcastJson).not.toContain("/api/chat/media/outgoing/");
        expect(await readActiveAssistantTranscriptMessages()).toStrictEqual([]);
      },
    );
  });

  it("keeps a placeholder for unbacked media-only source reply siblings", async () => {
    await withTranscriptFixtureState(
      "openclaw-chat-send-agent-source-reply-media-only-sibling-",
      async (fixtureDir) => {
        const mediaUrl = `data:image/png;base64,${TINY_PNG_BASE64}`;
        writeSavedPng(fixtureDir, "source-reply-media-only-sibling.png");
        const textMirrorKey = "idem-agent-source-reply-media-only-sibling:internal-source-reply:0";
        const missingMirrorKey =
          "idem-agent-source-reply-media-only-sibling:internal-source-reply:1";
        await appendSourceReplyMirrorEntry({
          idempotencyKey: textMirrorKey,
          text: "Text source reply",
        });
        setAgentRunReplies([
          createMainSourceReply({ idempotencyKey: textMirrorKey, text: "Text source reply" }),
          createMainSourceReply({ idempotencyKey: missingMirrorKey, mediaUrls: [mediaUrl] }),
        ]);
        const { send } = createChatRequestFixture();

        const broadcast = await send({
          idempotencyKey: "idem-agent-source-reply-media-only-sibling",
          message: "hello from codex",
        });

        const broadcastContent = getMessageContent(broadcast);
        expect(broadcastContent).toContainEqual({ type: "text", text: "Text source reply" });
        expect(broadcastContent).toContainEqual({
          type: "text",
          text: "Media reply could not be displayed.",
        });
        const broadcastJson = JSON.stringify(broadcast);
        expect(broadcastJson).not.toContain("MEDIA:");
        expect(broadcastJson).not.toContain(mediaUrl);
        expect(broadcastJson).not.toContain("/api/chat/media/outgoing/");
      },
    );
  });

  it("does not rewrite source reply mirrors when later transcript entries would be replayed", async () => {
    await withTranscriptFixtureState(
      "openclaw-chat-send-agent-source-reply-later-",
      async (fixtureDir) => {
        const mediaUrl = `data:image/png;base64,${TINY_PNG_BASE64}`;
        writeSavedPng(fixtureDir, "source-reply-later.png");
        const mirrorKey = "idem-agent-source-reply-later:internal-source-reply:0";
        await appendSourceReplyMirrorEntry({
          idempotencyKey: mirrorKey,
          text: "Source reply with media",
        });
        await appendSourceReplyMirrorEntry({
          idempotencyKey: "later-assistant-entry",
          text: "Later assistant content",
          model: "gateway-injected",
        });
        setAgentRunReplies([
          createMainSourceReply({
            idempotencyKey: mirrorKey,
            text: "Source reply with media",
            mediaUrls: [mediaUrl],
          }),
        ]);
        const { send } = createChatRequestFixture();

        const broadcast = await send({
          idempotencyKey: "idem-agent-source-reply-later",
          message: "hello from codex",
        });

        expect(JSON.stringify(getMessageContent(broadcast))).not.toContain(
          "/api/chat/media/outgoing/",
        );
        const assistantEntries = await readActiveAssistantTranscriptMessages();
        expect(assistantEntries.map((entry) => entry.idempotencyKey)).toStrictEqual([
          mirrorKey,
          "later-assistant-entry",
        ]);
        expect(assistantEntries[0]?.content).toStrictEqual([
          { type: "text", text: "Source reply with media" },
        ]);
        expect(assistantEntries[1]?.content).toStrictEqual([
          { type: "text", text: "Later assistant content" },
        ]);
      },
    );
  });

  it("does not broadcast an error terminal after an internal-ui source reply final", async () => {
    await createTranscriptFixture("openclaw-chat-send-agent-source-reply-error-");
    const sourceReply = createMainSourceReply({
      idempotencyKey: "idem-agent-source-reply-error:internal-source-reply:0",
      text: "Codex source reply",
    });
    setAgentRunReplies([
      sourceReply,
      {
        kind: "final",
        payload: {
          text: "tool warning",
          isError: true,
        },
      },
    ]);
    const { context, send } = createChatRequestFixture();

    const broadcast = await send({
      idempotencyKey: "idem-agent-source-reply-error",
      message: "hello from codex",
    });

    expect(broadcast).toMatchObject({
      runId: "idem-agent-source-reply-error",
      sessionKey: "agent:main:main",
      state: "final",
    });
    expect(extractFirstTextBlock(broadcast)).toBe("Codex source reply");
    const errorBroadcasts = context.broadcast.mock.calls.filter(
      ([, payload]) => (payload as { state?: unknown })?.state === "error",
    );
    expect(errorBroadcasts).toStrictEqual([]);
    const dedupe = context.dedupe.get("chat:idem-agent-source-reply-error");
    expect(dedupe?.ok).toBe(true);
    expect(dedupe?.payload).toMatchObject({
      runId: "idem-agent-source-reply-error",
      status: "ok",
    });
  });

  it("does not finalize an error-marked source reply as assistant transcript content", async () => {
    const mirrorIdempotencyKey = "idem-agent-source-reply-marked-error:internal-source-reply:0";
    await createTranscriptFixture("openclaw-chat-send-agent-source-reply-marked-error-");
    await appendSourceReplyMirrorEntry({
      idempotencyKey: mirrorIdempotencyKey,
      text: "Original source reply",
    });
    mockState.triggerAgentRunStart = true;
    mockState.dispatchedReplies = [
      {
        kind: "final",
        payload: setReplyPayloadMetadata(
          {
            text: "Model login expired. Re-authenticate, then try again.",
            isError: true,
          },
          {
            sourceReplyTranscriptMirror: {
              sessionKey: "main",
              text: "Model login expired. Re-authenticate, then try again.",
              idempotencyKey: mirrorIdempotencyKey,
            },
          },
        ),
      },
    ];
    const context = createChatContext();

    await runNonStreamingChatSend({
      context,
      respond: vi.fn(),
      idempotencyKey: "idem-agent-source-reply-marked-error",
      waitFor: "dedupe",
    });

    const broadcasts = context.broadcast.mock.calls.map(
      ([, payload]) => payload as Record<string, unknown>,
    );
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toMatchObject({
      state: "error",
      errorMessage: "Model login expired. Re-authenticate, then try again.",
    });
    expect(broadcasts[0]).not.toHaveProperty("message");
    const assistantEntries = await readActiveAssistantTranscriptMessages();
    expect(assistantEntries).toHaveLength(1);
    expect(assistantEntries[0]?.content).toStrictEqual([
      { type: "text", text: "Original source reply" },
    ]);
  });

  it("broadcasts returned agent errors after status notices", async () => {
    await createTranscriptFixture("openclaw-chat-send-agent-status-notice-error-");
    const errorMessage = "LLM idle timeout (120s): no response from model";
    mockState.triggerAgentRunStart = true;
    mockState.dispatchedReplies = [
      {
        kind: "block",
        payload: {
          text: "⚙️ Codex compaction started • Context 2k/200k",
          isStatusNotice: true,
        },
      },
      {
        kind: "final",
        payload: {
          text: errorMessage,
          isError: true,
        },
      },
    ];
    const { context, send } = createChatRequestFixture();

    const broadcast = await send({
      idempotencyKey: "idem-agent-status-notice-error",
      message: "/compact",
    });

    expect(broadcast).toMatchObject({
      runId: "idem-agent-status-notice-error",
      sessionKey: "agent:main:main",
      state: "error",
      errorMessage,
    });
    expect(broadcast).not.toHaveProperty("message");
    const finalBroadcasts = context.broadcast.mock.calls.filter(
      ([, payload]) => (payload as { state?: unknown })?.state === "final",
    );
    expect(finalBroadcasts).toStrictEqual([]);
  });

  it("labels additional returned agent errors instead of flattening them", async () => {
    await createTranscriptFixture("openclaw-chat-send-multiple-agent-errors-");
    mockState.triggerAgentRunStart = true;
    mockState.dispatchedReplies = [
      { kind: "final", payload: { text: "Primary execution failed", isError: true } },
      { kind: "final", payload: { text: "Workspace recovery failed", isError: true } },
      { kind: "final", payload: { text: "Workspace recovery failed", isError: true } },
    ];
    const { send } = createChatRequestFixture();

    const broadcast = await send({
      idempotencyKey: "idem-multiple-agent-errors",
      message: "run on the worker",
    });

    expect(broadcast).toMatchObject({
      state: "error",
      errorMessage: "Primary execution failed\n\nAdditional error: Workspace recovery failed",
    });
  });

  it.each([
    ["error payload after start", true, "error", undefined],
    ["error payload before launch", false, "error", undefined],
    ["recorded failure with ordinary output", true, "ordinary", "failed"],
    ["recorded failure without output", true, "empty", "failed"],
    ["recorded failure with source reply", true, "source", "failed"],
    ["recorded success with ordinary output", true, "ordinary", "completed"],
    ["recorded success with a recoverable warning", true, "warning", "completed"],
    ["recorded success with only a tool warning", true, "warning-only", "completed"],
    ["recorded success with source reply plus warning", true, "source-warning", "completed"],
  ] as const)(
    "projects agent-run terminal: $0",
    async (name, agentStarted, presentation, outcome) => {
      const fixtureDir = await createGatewayUserTurnSqliteFixture(
        "openclaw-chat-send-agent-terminal-",
      );
      const runId = `idem-agent-terminal-${name.replaceAll(" ", "-")}`;
      const failed = outcome === "failed" || presentation === "error";
      const sourceReply = presentation === "source" || presentation === "source-warning";
      const replyText = presentation === "warning-only" ? "⚠️ Exec failed" : "Partial agent reply";
      const errorMessage =
        presentation === "error"
          ? agentStarted
            ? "LLM idle timeout (120s): no response from model"
            : STALE_WORKER_BUILD_REASON
          : "agent run failed";
      const mirrorIdempotencyKey = `${runId}:internal-source-reply:0`;
      const mediaUrl = `data:image/png;base64,${TINY_PNG_BASE64}`;
      mockState.triggerAgentRunStart = agentStarted;
      if (outcome) {
        await appendTestTranscriptMessage({
          eventId: `${runId}:user`,
          role: "user",
          content: "please keep working",
          now: 0,
          parentId: null,
        });
        mockState.triggerUserMessagePersisted = true;
      }
      if (sourceReply) {
        writeSavedPng(fixtureDir, "source-terminal.png");
        await appendSourceReplyMirrorEntry({
          idempotencyKey: mirrorIdempotencyKey,
          text: replyText,
        });
        mockState.dispatchedReplies = [
          createMainSourceReply({
            idempotencyKey: mirrorIdempotencyKey,
            text: replyText,
            mediaUrls: [mediaUrl],
          }),
        ];
      } else if (presentation === "empty" || presentation === "warning-only") {
        mockState.finalText = "";
      } else if (presentation === "error") {
        mockState.dispatchedReplies = [
          {
            kind: "final",
            payload: { text: errorMessage, isError: true },
          },
        ];
      } else {
        mockState.runtimeAssistantTextsBeforeDelivery = [replyText];
        mockState.dispatchedReplies = [{ kind: "final", payload: { text: replyText } }];
      }
      if (
        presentation === "warning" ||
        presentation === "warning-only" ||
        presentation === "source-warning"
      ) {
        mockState.dispatchedReplies.push({
          kind: "final",
          payload: { text: "⚠️ Exec failed", isError: true },
        });
      }
      if (outcome) {
        const dispatch = expectDefined(
          dispatchInboundMessageMock.getMockImplementation(),
          "default chat dispatch fixture",
        );
        dispatchInboundMessageMock.mockImplementationOnce(async (params: TestDispatchParams) =>
          recordAgentRunTerminalOutcome(await dispatch(params), outcome),
        );
      }
      const { context, send } = createChatRequestFixture();

      await send({
        idempotencyKey: runId,
        message: "please keep working",
        waitFor: "none",
      });
      // Admission already owns a dedupe entry; observe the first terminal write, not key presence.
      await waitForAssertion(() => {
        expect(["ok", "error"]).toContain(context.dedupe.get(`chat:${runId}`)?.payload?.status);
      });
      const dedupe = context.dedupe.get(`chat:${runId}`);
      expect(dedupe?.ok).toBe(!failed);
      expect(dedupe?.payload).toMatchObject({
        runId,
        status: failed ? "error" : "ok",
        ...(failed ? { summary: errorMessage } : {}),
      });
      const waitRespond = vi.fn<RespondFn>();
      await agentWaitHandler({
        params: { runId, timeoutMs: 0 },
        respond: waitRespond,
        context,
        req: {} as never,
        client: null,
        isWebchatConnect: () => false,
      });
      expect(waitRespond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ runId, status: failed ? "error" : "ok" }),
      );
      const broadcasts = context.broadcast.mock.calls
        .filter(([event]) => event === "chat")
        .map(([, payload]) => payload);
      if (failed) {
        expect(broadcasts).toEqual([
          expect.objectContaining({
            runId,
            sessionKey: "agent:main:main",
            state: "error",
            errorMessage,
          }),
        ]);
        expect(broadcasts[0]).not.toHaveProperty("message");
      } else if (sourceReply || presentation === "warning-only") {
        expect(broadcasts).toEqual([expect.objectContaining({ runId, state: "final" })]);
        expect(extractFirstTextBlock(broadcasts[0])).toBe(replyText);
      } else {
        expect(broadcasts).toEqual([]);
      }
      const assistantEntries = await readActiveAssistantTranscriptMessages();
      if (presentation === "error" || presentation === "empty") {
        expect(assistantEntries).toEqual([]);
        expect(findAssistantTranscriptUpdates()).toEqual([]);
      } else {
        expect(assistantEntries).toHaveLength(1);
        expect(JSON.stringify(assistantEntries[0]?.content)).toContain(replyText);
      }
      if (sourceReply) {
        expect(assistantEntries[0]?.idempotencyKey).toBe(mirrorIdempotencyKey);
        expect(JSON.stringify(assistantEntries[0])).toContain("/api/chat/media/outgoing/");
        expect(JSON.stringify(assistantEntries[0]?.content)).not.toContain(mediaUrl);
        expect(fs.existsSync(mockState.transcriptPath)).toBe(false);
      }
      if (presentation === "error") {
        expectUserUpdateIdentity(findUserUpdate());
      } else {
        expect(readPersistedUserMessages()).toHaveLength(1);
      }
    },
  );

  it("keeps visible text on non-agent TTS final media because no model transcript exists", async () => {
    const transcriptDir = await createTranscriptFixture("openclaw-chat-send-command-tts-final-");
    const audioPath = path.join(transcriptDir, "tts.mp3");
    fs.writeFileSync(audioPath, Buffer.from([0xff, 0xfb, 0x90, 0x00]));
    mockState.config = {
      agents: {
        defaults: {
          workspace: transcriptDir,
        },
      },
    };
    mockState.finalPayload = {
      text: "Command result with TTS.",
      spokenText: "Command result with TTS.",
      mediaUrl: audioPath,
      mediaUrls: [audioPath],
      trustedLocalMedia: true,
      audioAsVoice: true,
    };
    const { send } = createChatRequestFixture();

    const payload = await send({
      idempotencyKey: "idem-command-tts",
    });

    const content = getMessageContent(payload);
    expect(getMessage(payload)?.role).toBe("assistant");
    expect(content[0]).toEqual({ type: "text", text: "Command result with TTS." });
    expectManagedAudioBlock(content[1], "tts.mp3", true);
    expect(JSON.stringify(content[1])).not.toContain(fs.realpathSync(audioPath));
    const assistantUpdates = findAssistantTranscriptUpdates();
    expect(assistantUpdates).toHaveLength(1);
    expect(JSON.stringify(assistantUpdates[0]?.message)).toContain("Command result with TTS.");
  });

  it("folds block-only non-agent command replies into the final WebChat message", async () => {
    await createTranscriptFixture("openclaw-chat-send-command-block-final-");
    mockState.dispatchedReplies = [
      {
        kind: "block",
        payload: {
          text: [
            "Trajectory exports can include prompts, model messages, tool schemas, tool results, runtime events, and local paths.",
            "Trajectory bundle: requested `openclaw sessions export-trajectory` through exec approval. Approve once to create the bundle; do not use allow-all for trajectory exports.",
          ].join("\n"),
        },
      },
    ];
    const { context, send } = createChatRequestFixture();

    const payload = await send({
      idempotencyKey: "idem-command-block",
      message: "/export-trajectory bundle",
    });

    const text = getMessageContent(payload)
      .map((block) => (typeof block.text === "string" ? block.text : ""))
      .filter(Boolean)
      .join("\n");
    expect(text).toContain("Trajectory exports can include");
    expect(text).toContain("through exec approval");
    expect(text).toContain("Approve once");
    const broadcast = lastBroadcastPayload(context);
    expect(broadcast?.runId).toBe("idem-command-block");
    expect(broadcast?.state).toBe("final");
    const broadcastText = getMessageContent(broadcast)
      .map((block) => (typeof block.text === "string" ? block.text : ""))
      .filter(Boolean)
      .join("\n");
    expect(broadcastText).toContain("Trajectory exports can include");
    expect(broadcastText).toContain("through exec approval");
    expect(broadcastText).toContain("Approve once");
  });

  it("keeps slash-command block text when the final payload only adds media", async () => {
    const transcriptDir = await createTranscriptFixture(
      "openclaw-chat-send-command-block-media-final-",
    );
    const audioPath = path.join(transcriptDir, "tts.mp3");
    fs.writeFileSync(audioPath, Buffer.from([0xff, 0xfb, 0x90, 0x00]));
    mockState.config = {
      agents: {
        defaults: {
          workspace: transcriptDir,
        },
      },
    };
    mockState.dispatchedReplies = [
      {
        kind: "block",
        payload: { text: "Trajectory exports can include prompts." },
      },
      {
        kind: "final",
        payload: {
          mediaUrl: audioPath,
          mediaUrls: [audioPath],
          trustedLocalMedia: true,
          audioAsVoice: true,
          replyToCurrent: true,
        },
      },
    ];
    const { send } = createChatRequestFixture();

    const payload = await send({
      idempotencyKey: "idem-command-block-media",
      message: "/export-trajectory bundle",
    });

    const content = getMessageContent(payload);
    expect(content[0]).toEqual({ type: "text", text: "Trajectory exports can include prompts." });
    expectManagedAudioBlock(content[1], "tts.mp3", true);
    const transcriptUpdate = mockState.emittedTranscriptUpdates.find(
      (update) =>
        typeof update.message === "object" &&
        update.message !== null &&
        (update.message as { role?: unknown }).role === "assistant" &&
        (update.message as { openclawDelivery?: { replyToCurrent?: boolean } }).openclawDelivery
          ?.replyToCurrent === true,
    );
    expect(transcriptUpdate).toBeTruthy();
    expect(JSON.stringify(transcriptUpdate)).not.toContain("[[reply_to_current]]");
  });

  it("broadcasts sensitive pairing QR display without persisting QR content", async () => {
    await createTranscriptFixture("openclaw-chat-send-command-pair-qr-");
    const setupCode = "openclaw-test-pairing-setup-code";
    mockState.dispatchedReplies = [
      {
        kind: "final",
        payload: {
          text: "Scan this QR code with the OpenClaw iOS app:",
          channelData: {
            openclawPairingQr: {
              setupCode,
              expiresAtMs: Date.now() + 10 * 60_000,
            },
          },
          sensitiveMedia: true,
        },
      },
    ];
    const { send } = createChatRequestFixture();

    const payload = await send({
      idempotencyKey: "idem-command-pair-qr",
      message: "/pair qr",
    });

    const content = getMessageContent(payload);
    expect(content[0]).toEqual({
      type: "text",
      text: "Scan this QR code with the OpenClaw iOS app:",
    });
    expect(content[1]).toEqual(
      expect.objectContaining({
        type: "openclaw_pairing_qr",
        image_url: expect.stringMatching(/^data:image\/png;base64,/u),
        terminalText: expect.stringContaining("█"),
        sensitive: true,
      }),
    );
    const transcriptMessages = await readActiveAssistantTranscriptMessages();
    const serializedTranscript = JSON.stringify(transcriptMessages);
    expect(serializedTranscript).toContain("Scan this QR code with the OpenClaw iOS app:");
    expect(serializedTranscript).not.toContain("openclaw_pairing_qr");
    expect(serializedTranscript).not.toContain("data:image/png");
    expect(serializedTranscript).not.toContain("terminalText");
    expect(serializedTranscript).not.toContain(setupCode);
  });

  it("keeps visible slash-command finals alongside earlier block text", async () => {
    await createTranscriptFixture("openclaw-chat-send-command-block-text-final-");
    mockState.dispatchedReplies = [
      {
        kind: "block",
        payload: { text: "Trajectory exports can include prompts." },
      },
      {
        kind: "final",
        payload: { text: "Approve once to create the bundle." },
      },
    ];
    const { send } = createChatRequestFixture();

    const payload = await send({
      idempotencyKey: "idem-command-block-text",
      message: "/export-trajectory bundle",
    });

    const text = getMessageContent(payload)
      .map((block) => (typeof block.text === "string" ? block.text : ""))
      .filter(Boolean)
      .join("\n");
    expect(text).toContain("Trajectory exports can include prompts.");
    expect(text).toContain("Approve once to create the bundle.");
  });

  it("deduplicates exact slash-command final text echoes", async () => {
    await createTranscriptFixture("openclaw-chat-send-command-block-duplicate-text-final-");
    mockState.dispatchedReplies = [
      {
        kind: "block",
        payload: { text: "Trajectory exports can include prompts." },
      },
      {
        kind: "final",
        payload: {
          text: "Trajectory exports can include prompts.[[reply_to_current]]",
        },
      },
    ];
    const { send } = createChatRequestFixture();

    const payload = await send({
      idempotencyKey: "idem-command-block-duplicate-text",
      message: "/export-trajectory bundle",
    });

    const text = getMessageContent(payload)
      .map((block) => (typeof block.text === "string" ? block.text : ""))
      .filter(Boolean)
      .join("\n");
    expect(text.match(/Trajectory exports/gu)).toHaveLength(1);
    const transcriptUpdate = mockState.emittedTranscriptUpdates.find(
      (update) =>
        typeof update.message === "object" &&
        update.message !== null &&
        (update.message as { role?: unknown }).role === "assistant",
    );
    expect(transcriptUpdate?.message).toMatchObject({
      openclawDelivery: { replyToCurrent: true },
    });
    expect(JSON.stringify(transcriptUpdate?.message)).not.toContain("[[reply_to_current]]");
  });

  it("keeps slash-command block text when the final payload only carries a reply directive", async () => {
    await createTranscriptFixture("openclaw-chat-send-command-block-reply-directive-final-");
    mockState.dispatchedReplies = [
      {
        kind: "block",
        payload: { text: "Trajectory exports can include prompts." },
      },
      {
        kind: "final",
        payload: { text: "[[reply_to_current]]" },
      },
    ];
    const { send } = createChatRequestFixture();

    const payload = await send({
      idempotencyKey: "idem-command-block-reply-directive",
      message: "/export-trajectory bundle",
    });

    expect(extractFirstTextBlock(payload)).toBe("Trajectory exports can include prompts.");
    const transcriptUpdate = mockState.emittedTranscriptUpdates.find(
      (update) =>
        typeof update.message === "object" &&
        update.message !== null &&
        (update.message as { role?: unknown }).role === "assistant",
    );
    expect(transcriptUpdate?.message).toMatchObject({
      openclawDelivery: { replyToCurrent: true },
    });
    expect(JSON.stringify(transcriptUpdate?.message)).not.toContain("[[reply_to_current]]");
    expect(JSON.stringify(transcriptUpdate?.message)).toContain(
      "Trajectory exports can include prompts.",
    );
  });

  it.each([
    {
      name: "keeps media from duplicate slash-command finals without duplicating block text",
      id: "media-dupe",
      files: ["tts.mp3"],
      replies: ([audio]) => [
        createSlashCommandMediaReply("block", [audio], {
          text: "Trajectory exports can include prompts.",
          mediaUrl: audio,
        }),
        createSlashCommandMediaReply("final", [audio], {
          text: "[[audio_as_voice]]",
          mediaUrl: audio,
        }),
      ],
      verify: (content) => {
        const text = content
          .map((block) => (typeof block.text === "string" ? block.text : ""))
          .filter(Boolean)
          .join("\n");
        expect(text.match(/Trajectory exports/gu)).toHaveLength(1);
        expectManagedAudioBlock(content[1], "tts.mp3", true);
      },
    },
    {
      name: "deduplicates slash-command media when file URLs and paths reference the same attachment",
      id: "media-file-url",
      files: ["voice.mp3"],
      replies: ([audio]) => [
        createSlashCommandMediaReply("block", [audio], {
          text: "Trajectory exports can include prompts.",
        }),
        createSlashCommandMediaReply("final", [pathToFileURL(audio).href], {
          audioAsVoice: true,
        }),
      ],
      verify: (content) => {
        expect(content).toHaveLength(2);
        expectManagedAudioBlock(content[1], "voice.mp3", true);
      },
    },
    {
      name: "does not downgrade a voice-note block when a duplicate final has normalized false flags",
      id: "voice-sticky",
      files: ["voice.mp3"],
      replies: ([audio]) => [
        createSlashCommandMediaReply("block", [audio], {
          text: "Trajectory exports can include prompts.",
          audioAsVoice: true,
        }),
        createSlashCommandMediaReply("final", [audio], { audioAsVoice: false }),
      ],
      verify: (content) => {
        const attachments = managedAudioBlocks(content);
        expect(attachments).toHaveLength(1);
        expectManagedAudioBlock(attachments[0], "voice.mp3", true);
      },
    },
    {
      name: "keeps final text when only the slash-command media is duplicated",
      id: "media-different-final-text",
      files: ["voice.mp3"],
      replies: ([audio]) => [
        createSlashCommandMediaReply("block", [audio], { text: "preview" }),
        createSlashCommandMediaReply("final", [audio], {
          text: "done",
          replyToCurrent: true,
        }),
      ],
      verify: (content) => {
        const text = content
          .map((block) => (typeof block.text === "string" ? block.text : ""))
          .filter(Boolean)
          .join("\n");
        expect(text).toContain("preview");
        expect(text).toContain("done");
        expect(managedAudioBlocks(content)).toHaveLength(1);
        const transcriptUpdate = mockState.emittedTranscriptUpdates.find(
          (update) =>
            typeof update.message === "object" &&
            update.message !== null &&
            (update.message as { role?: unknown }).role === "assistant",
        );
        expect(transcriptUpdate?.message).toMatchObject({
          openclawDelivery: { replyToCurrent: true },
        });
        expect(JSON.stringify(transcriptUpdate?.message)).not.toContain("[[reply_to_current]]");
        expect(JSON.stringify(transcriptUpdate?.message)).toContain("done");
      },
    },
    {
      name: "keeps same-caption slash-command finals when media differs",
      id: "same-caption-different-media",
      files: ["block.mp3", "final.mp3"],
      replies: ([first, second]) => [
        createSlashCommandMediaReply("block", [first], { text: "shared caption" }),
        createSlashCommandMediaReply("final", [second], {
          text: "shared caption",
          audioAsVoice: true,
        }),
      ],
      verify: (content) => {
        const attachments = managedAudioBlocks(content);
        expect(attachments).toHaveLength(2);
        expectManagedAudioBlock(attachments[0], "block.mp3");
        expect(attachments[0]?.isVoiceNote).not.toBe(true);
        expectManagedAudioBlock(attachments[1], "final.mp3", true);
      },
    },
    {
      name: "deduplicates slash-command final echoes against the same text and media block",
      id: "same-caption-same-media",
      files: ["first.mp3", "second.mp3"],
      replies: ([first, second]) => [
        createSlashCommandMediaReply("block", [first], { text: "shared caption" }),
        createSlashCommandMediaReply("block", [second], { text: "shared caption" }),
        createSlashCommandMediaReply("final", [second], {
          text: "shared caption",
          audioAsVoice: true,
        }),
      ],
      verify: (content) => {
        const text = content
          .map((block) => (typeof block.text === "string" ? block.text : ""))
          .filter(Boolean)
          .join("\n");
        expect(text.match(/shared caption/gu)).toHaveLength(2);
        const attachments = managedAudioBlocks(content);
        expect(attachments).toHaveLength(2);
        expectManagedAudioBlock(attachments[0], "first.mp3");
        expectManagedAudioBlock(attachments[1], "second.mp3", true);
      },
    },
    {
      name: "uses canonical mediaUrls when deduplicating slash-command block media",
      id: "media-canonical",
      files: ["block.mp3", "final.mp3"],
      replies: ([first, second]) => [
        createSlashCommandMediaReply("block", [first], {
          text: "Trajectory exports can include prompts.",
          mediaUrl: second,
          audioAsVoice: true,
        }),
        createSlashCommandMediaReply("final", [second], { audioAsVoice: true }),
      ],
      verify: (content) => {
        expect(content[0]).toMatchObject({
          type: "text",
          text: expect.stringContaining("Trajectory exports can include prompts."),
        });
        const attachments = managedAudioBlocks(content);
        expect(attachments).toHaveLength(2);
        expectManagedAudioBlock(attachments[0], "block.mp3", true);
        expectManagedAudioBlock(attachments[1], "final.mp3", true);
      },
    },
    {
      name: "does not spread duplicate final media flags across multi-media command blocks",
      id: "media-partial",
      files: ["first.mp3", "second.mp3"],
      replies: ([first, second]) => [
        createSlashCommandMediaReply("block", [first, second], {
          text: "Trajectory exports can include prompts.",
        }),
        createSlashCommandMediaReply("final", [first], { audioAsVoice: true }),
      ],
      verify: (content) => {
        const attachments = managedAudioBlocks(content);
        expect(attachments).toHaveLength(3);
        expectManagedAudioBlock(attachments[0], "first.mp3");
        expect(attachments[0]?.isVoiceNote).not.toBe(true);
        expectManagedAudioBlock(attachments[1], "second.mp3");
        expect(attachments[1]?.isVoiceNote).not.toBe(true);
        expectManagedAudioBlock(attachments[2], "first.mp3", true);
      },
    },
    {
      name: "keeps sensitive overlapping slash-command media out of transcripts",
      id: "media-sensitive-overlap",
      files: ["secret.mp3", "public.mp3"],
      replies: ([secret, publicAudio]) => [
        createSlashCommandMediaReply("block", [secret, publicAudio], { text: "preview" }),
        createSlashCommandMediaReply("final", [secret], { sensitiveMedia: true }),
      ],
      verify: (_content, [secret]) => {
        const transcriptUpdate = mockState.emittedTranscriptUpdates.find(
          (update) =>
            typeof update.message === "object" &&
            update.message !== null &&
            (update.message as { role?: unknown }).role === "assistant",
        );
        expect(JSON.stringify(transcriptUpdate?.message)).not.toContain(secret);
      },
    },
    {
      name: "keeps reordered slash-command final media instead of treating it as duplicate",
      id: "media-reordered",
      files: ["first.mp3", "second.mp3"],
      replies: ([first, second]) => [
        createSlashCommandMediaReply("block", [first, second], {
          text: "Trajectory exports can include prompts.",
        }),
        createSlashCommandMediaReply("final", [second, first], { audioAsVoice: true }),
      ],
      verify: (content) => {
        const attachments = managedAudioBlocks(content);
        expect(attachments.map((block) => block.fileName)).toEqual([
          "first.mp3",
          "second.mp3",
          "second.mp3",
          "first.mp3",
        ]);
        expect(attachments.slice(0, 2).every((block) => block.isVoiceNote !== true)).toBe(true);
        expect(attachments.slice(2).every((block) => block.isVoiceNote === true)).toBe(true);
      },
    },
  ] satisfies SlashCommandMediaCase[])("$name", async ({ id, files, replies, verify }) => {
    const transcriptDir = await createTranscriptFixture(`openclaw-chat-send-command-block-${id}-`);
    const audioPaths = files.map((file, index) => {
      const audioPath = path.join(transcriptDir, file);
      fs.writeFileSync(audioPath, Buffer.from([0xff, 0xfb, 0x90, index]));
      return audioPath;
    });
    const firstAudioPath = expectDefined(audioPaths[0], "slash-command media fixture");
    const fixturePaths: [string, string] = [firstAudioPath, audioPaths[1] ?? firstAudioPath];
    mockState.config = { agents: { defaults: { workspace: transcriptDir } } };
    mockState.dispatchedReplies = replies(fixturePaths);

    const payload = await runNonStreamingChatSend({
      context: createChatContext(),
      respond: vi.fn(),
      idempotencyKey: `idem-command-block-${id}`,
      message: "/export-trajectory bundle",
    });

    verify(getMessageContent(payload), fixturePaths);
  });

  it("renders image reply payloads as assistant image content instead of MEDIA text", async () => {
    await createTranscriptFixture("openclaw-chat-send-agent-image-");
    mockState.finalPayload = {
      text: "Scan this QR code with the OpenClaw iOS app:",
      mediaUrl: `data:image/png;base64,${TINY_PNG_BASE64}`,
    };
    const { send } = createChatRequestFixture();

    const payload = await send({
      idempotencyKey: "idem-agent-image",
    });

    const content = getMessageContent(payload);
    const image = content.find((block) => block.type === "image");
    expect(getMessage(payload)?.role).toBe("assistant");
    expect(content[0]).toEqual({
      type: "text",
      text: "Scan this QR code with the OpenClaw iOS app:",
    });
    expect(image).toMatchObject({
      type: "image",
      artifactId: expect.stringMatching(/^artifact_managed_image_/u),
      mimeType: "image/png",
      url: expect.stringMatching(/\/api\/chat\/media\/outgoing\//u),
      openUrl: expect.stringMatching(/\/api\/chat\/media\/outgoing\//u),
    });
    expect(JSON.stringify(payload?.message)).not.toContain(
      `MEDIA:data:image/png;base64,${TINY_PNG_BASE64}`,
    );
  });

  it("suppresses reasoning payloads from webchat transcript replies", async () => {
    await createTranscriptFixture("openclaw-chat-send-reasoning-hidden-");
    mockState.dispatchedReplies = [
      {
        kind: "final",
        payload: { text: "step", isReasoning: true },
      },
      {
        kind: "final",
        payload: { text: "final answer" },
      },
    ];
    const { send } = createChatRequestFixture();

    const payload = await send({
      idempotencyKey: "idem-reasoning-hidden",
    });

    expect(JSON.stringify(payload?.message)).toContain("final answer");
    expect(JSON.stringify(payload?.message)).not.toContain("Reasoning");
  });

  it("chat.inject keeps message defined when directive tag is the only content", async () => {
    await createTranscriptFixture("openclaw-chat-inject-directive-only-");
    const { context, respond, inject } = createChatRequestFixture();

    await inject({ sessionKey: "main", message: "[[reply_to_current]]" });

    expect(respond).toHaveBeenCalled();
    const [ok, payload] = lastRespondCall(respond) ?? [];
    expect(ok).toBe(true);
    expect(payload?.ok).toBe(true);
    const broadcastPayload = lastBroadcastPayload(context);
    expect(broadcastPayload?.state).toBe("final");
    if (!getMessage(broadcastPayload)) {
      throw new Error("Expected broadcast message");
    }
    expect(extractFirstTextBlock(broadcastPayload)).toBe("");
  });

  it("chat.inject rejects archived sessions without appending", async () => {
    await createTranscriptFixture("openclaw-chat-inject-archived-");
    mockState.sessionEntry = { archivedAt: Date.now() };
    const { context, respond, inject } = createChatRequestFixture();

    await inject({ sessionKey: "main", message: "must stay read-only" });

    const response = lastRespondCall(respond);
    expect(response?.[0]).toBe(false);
    expect(response?.[2]?.message).toMatch(/archived/i);
    expect(context.broadcast).not.toHaveBeenCalled();
    expect(readTranscriptJsonLines(mockState.transcriptPath)).toHaveLength(1);
  });

  it("chat.inject rechecks archive state after lifecycle admission waits", async () => {
    await createTranscriptFixture("openclaw-chat-inject-archive-race-");
    const storePath = mockState.storePath;
    const mutationStarted = createDeferred();
    const releaseMutation = createDeferred();
    const mutation = runExclusiveSessionLifecycleMutation({
      scope: storePath,
      identities: ["main", mockState.sessionId],
      run: async () => {
        mutationStarted.resolve();
        await releaseMutation.promise;
      },
    });
    await mutationStarted.promise;
    const { context, respond } = createChatRequestFixture();

    try {
      const inject = expectDefined(
        chatHandlers["chat.inject"],
        'chatHandlers["chat.inject"] test invariant',
      )({
        params: { sessionKey: "main", message: "must lose the archive race" },
        respond,
        req: {} as never,
        client: null as never,
        isWebchatConnect: () => false,
        context,
      });
      await waitForAssertion(() => expect(mockState.loadSessionEntryCalls).toHaveLength(1));
      mockState.sessionEntry = { archivedAt: Date.now() };
      releaseMutation.resolve();
      await mutation;
      await inject;

      const response = lastRespondCall(respond);
      expect(response?.[0]).toBe(false);
      expect(response?.[2]?.message).toMatch(/archived/i);
      expect(context.broadcast).not.toHaveBeenCalled();
      expect(readTranscriptJsonLines(mockState.transcriptPath)).toHaveLength(1);
    } finally {
      releaseMutation.resolve();
      await mutation;
    }
  });

  it("chat.inject persists to SQLite without creating active JSONL", async () => {
    await withSqliteTranscriptFixtureState("openclaw-chat-inject-sqlite-", async () => {
      const { respond, inject } = createChatRequestFixture();

      await inject({ sessionKey: "main", message: "hello sqlite inject" });

      const [ok, payload] = lastRespondCall(respond) ?? [];
      expect(ok).toBe(true);
      expect(payload?.ok).toBe(true);
      expect(fs.existsSync(mockState.transcriptPath)).toBe(false);
      const assistantEntries = await readActiveAssistantTranscriptMessages();
      expect(assistantEntries).toHaveLength(1);
      expect(JSON.stringify(assistantEntries[0])).toContain("hello sqlite inject");
    });
  });

  it("chat.send non-streaming final keeps message defined for directive-only assistant text", async () => {
    await createTranscriptFixture("openclaw-chat-send-directive-only-");
    mockState.finalText = "[[reply_to_current]]";
    const { send } = createChatRequestFixture();

    const payload = await send({
      idempotencyKey: "idem-directive-only",
    });

    expect(payload?.runId).toBe("idem-directive-only");
    expect(payload?.state).toBe("final");
    if (!getMessage(payload)) {
      throw new Error("Expected directive-only final message");
    }
    expect(extractFirstTextBlock(payload)).toBe("");
  });

  it("persists inline reply directives as typed facts while stripping them from text", async () => {
    await createTranscriptFixture("openclaw-chat-send-inline-reply-transcript-");
    mockState.finalText = "see[[reply_to_current]]now  with  spacing";
    const { send } = createChatRequestFixture();

    const payload = await send({
      idempotencyKey: "idem-inline-reply-transcript",
    });

    expect(extractFirstTextBlock(payload)).toBe("see now with spacing");
    const transcriptUpdate = mockState.emittedTranscriptUpdates.find(
      (update) =>
        typeof update.message === "object" &&
        update.message !== null &&
        (update.message as { role?: unknown }).role === "assistant",
    );
    expect(transcriptUpdate?.message).toMatchObject({
      openclawDelivery: { replyToCurrent: true },
    });
    expect(JSON.stringify(transcriptUpdate?.message)).not.toContain("[[reply_to_current]]");
    expect(JSON.stringify(transcriptUpdate?.message)).toContain("see now with spacing");
  });

  it("rejects oversized chat.send session keys before dispatch", async () => {
    await createTranscriptFixture("openclaw-chat-send-session-key-too-long-");
    const { context, respond } = createChatRequestFixture();

    await expectDefined(
      chatHandlers["chat.send"],
      'chatHandlers["chat.send"] test invariant',
    )({
      params: {
        sessionKey: `agent:main:${"x".repeat(CHAT_SEND_SESSION_KEY_MAX_LENGTH)}`,
        message: "hello",
        idempotencyKey: "idem-session-key-too-long",
      },
      respond,
      req: {} as never,
      client: null as never,
      isWebchatConnect: () => false,
      context,
    });

    const response = lastRespondCall(respond);
    expect(response?.[0]).toBe(false);
    expect(response?.[1]).toBeUndefined();
    expect(response?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(context.broadcast).not.toHaveBeenCalled();
  });

  it("rejects chat.send creation in an agent harness-owned namespace", async () => {
    await createTranscriptFixture("openclaw-chat-send-harness-reserved-");
    mockState.sessionMissing = true;
    const { context, respond } = createChatRequestFixture();

    await expectDefined(
      chatHandlers["chat.send"],
      'chatHandlers["chat.send"] test invariant',
    )({
      params: {
        sessionKey: "agent:main:harness:codex:supervision:native-thread",
        message: "claim reserved session",
        idempotencyKey: "idem-harness-reserved",
      },
      respond,
      req: {} as never,
      client: null as never,
      isWebchatConnect: () => false,
      context,
    });

    const response = lastRespondCall(respond);
    expect(response?.[0]).toBe(false);
    expect(response?.[2]).toMatchObject({
      code: ErrorCodes.INVALID_REQUEST,
      message: "Session key namespace is reserved for agent harness-owned sessions.",
    });
    expect(mockState.lastDispatchCtx).toBeUndefined();
    expect(context.broadcast).not.toHaveBeenCalled();
  });

  it("chat.inject strips external untrusted wrapper metadata from final payload text", async () => {
    await createTranscriptFixture("openclaw-chat-inject-untrusted-meta-");
    const { context, respond, inject } = createChatRequestFixture();

    await inject({
      sessionKey: "main",
      message: `hello\n\n${UNTRUSTED_CONTEXT_SUFFIX}`,
    });

    expect(respond).toHaveBeenCalled();
    const chatCall = mockCallAt(context.broadcast, -1);
    expect(chatCall?.[0]).toBe("chat");
    expect(extractFirstTextBlock(chatCall?.[1])).toBe("hello");
  });

  it("chat.inject broadcasts and routes on the canonical session key", async () => {
    await createTranscriptFixture("openclaw-chat-inject-canonical-key-");
    mockState.sessionEntry = {
      canonicalKey: "agent:main:canon",
    };
    const { context, respond, inject } = createChatRequestFixture();

    await inject({
      sessionKey: "legacy-key",
      message: "hello",
    });

    const response = lastRespondCall(respond);
    expect(response?.[0]).toBe(true);
    expect(response?.[1]?.ok).toBe(true);
    expect(lastBroadcastPayload(context)?.sessionKey).toBe("agent:main:canon");
    const nodeSend = lastNodeSendCall(context);
    expect(nodeSend?.[0]).toBe("agent:main:canon");
    expect(nodeSend?.[1]).toBe("chat");
    expect(nodeSend?.[2].sessionKey).toBe("agent:main:canon");
  });

  it("chat.inject advances the session registry marker after transcript append", async () => {
    await createTranscriptFixture("openclaw-chat-inject-registry-marker-");
    const updatedAt = Date.parse("2026-05-18T11:00:00.000Z");
    const appendedAt = Date.parse("2026-05-18T11:05:00.000Z");
    await seedSqliteSessionEntry({
      sessionFile: mockState.transcriptPath,
      updatedAt,
      status: "done",
    });
    const { respond, inject } = createChatRequestFixture();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(appendedAt);
    try {
      await inject({
        sessionKey: "main",
        message: "hello with registry marker",
      });

      const response = lastRespondCall(respond);
      expect(response?.[0]).toBe(true);
      const entry = readSqliteMainSessionEntry();
      expect(entry?.updatedAt).toBe(appendedAt);
      expect(entry?.status).toBe("done");
    } finally {
      vi.useRealTimers();
    }
  });

  it("chat.inject scopes selected-agent global sessions before appending", async () => {
    await createTranscriptFixture("openclaw-chat-inject-selected-global-", {
      agentId: "work",
      sessionKey: "agent:work:global",
    });
    useGlobalSessionScope();
    mockState.sessionEntry = { canonicalKey: "global" };
    const { context, respond, inject } = createChatRequestFixture();

    await inject({
      sessionKey: "main",
      agentId: "work",
      message: "hello selected global",
    });

    const response = lastRespondCall(respond);
    expect(response?.[0]).toBe(true);
    expect(mockState.loadSessionEntryCalls[0]).toEqual({
      rawKey: "main",
      opts: { agentId: "work" },
    });
    const broadcastPayload = lastBroadcastPayload(context);
    expect(broadcastPayload).toMatchObject({
      sessionKey: "global",
      agentId: "work",
      state: "final",
    });
    const nodeSend = lastNodeSendCall(context);
    expect(nodeSend?.[0]).toBe("agent:work:global");
    expect(nodeSend?.[2]).toMatchObject({ sessionKey: "global", agentId: "work" });
  });

  it("chat.send non-streaming final strips external untrusted wrapper metadata from final payload text", async () => {
    await createTranscriptFixture("openclaw-chat-send-untrusted-meta-");
    mockState.finalText = `hello\n\n${UNTRUSTED_CONTEXT_SUFFIX}`;
    const { send } = createChatRequestFixture();

    const payload = await send({
      idempotencyKey: "idem-untrusted-context",
    });
    expect(extractFirstTextBlock(payload)?.trim()).toBe("hello");
  });

  it("chat.send non-streaming final broadcasts and routes on the canonical session key", async () => {
    await createTranscriptFixture("openclaw-chat-send-canonical-key-");
    mockState.sessionEntry = {
      canonicalKey: "agent:main:canon",
    };
    mockState.finalText = "hello";
    const { context, send } = createChatRequestFixture();

    const payload = await send({
      idempotencyKey: "idem-canonical-key",
      sessionKey: "legacy-key",
    });

    expect(payload?.sessionKey).toBe("agent:main:canon");
    const nodeSend = lastNodeSendCall(context);
    expect(nodeSend?.[0]).toBe("agent:main:canon");
    expect(nodeSend?.[1]).toBe("chat");
    expect(nodeSend?.[2].sessionKey).toBe("agent:main:canon");
  });

  it("chat.send broadcasts final replies for telegram-shaped session keys", async () => {
    await createTranscriptFixture("openclaw-chat-send-telegram-final-");
    mockState.finalText = "telegram ok";
    const { context, send } = createChatRequestFixture();
    const sessionKey = "agent:main:telegram:direct:123456";

    const payload = await send({
      idempotencyKey: "idem-telegram-final",
      sessionKey,
    });

    expect(payload?.runId).toBe("idem-telegram-final");
    expect(payload?.sessionKey).toBe(sessionKey);
    expect(payload?.state).toBe("final");
    if (!getMessage(payload)) {
      throw new Error("Expected Telegram final message");
    }
    expect(extractFirstTextBlock(payload)).toBe("telegram ok");
    const nodeSend = lastNodeSendCall(context);
    expect(nodeSend?.[0]).toBe(sessionKey);
    expect(nodeSend?.[1]).toBe("chat");
    expect(nodeSend?.[2].sessionKey).toBe(sessionKey);
    expect(nodeSend?.[2].state).toBe("final");
  });

  it("chat.send marks user slash commands as text command sources", async () => {
    await createReadyChatTranscript("openclaw-chat-send-text-command-source-");
    const { send } = createChatRequestFixture();

    await send({
      idempotencyKey: "idem-text-command-source",
      message: "/codex status",
      expectBroadcast: false,
    });

    expectDispatchContextFields({
      BodyForCommands: "/codex status",
      CommandSource: "text",
    });
  });

  it("chat.send keeps thinking metadata out of command text for normal messages", async () => {
    await createReadyChatTranscript("openclaw-chat-send-thinking-normal-message-");
    const { send } = createChatRequestFixture();

    await send({
      idempotencyKey: "idem-thinking-normal-message",
      message: "hello from phone",
      requestParams: {
        thinking: "low",
      },
      expectBroadcast: false,
    });

    expect(mockState.lastDispatchCtx?.BodyForCommands).toBe("hello from phone");
    expect(mockState.lastDispatchCtx?.CommandBody).toBe("hello from phone");
    expect(mockState.lastDispatchCtx?.CommandTurn).toEqual({
      kind: "normal",
      source: "message",
      authorized: false,
      body: "hello from phone",
    });
    const userTurnInput = mockState.lastDispatchUserTurnInput as
      | {
          content?: unknown;
        }
      | undefined;
    expect(userTurnInput?.content).toBe("hello from phone");
    expect(mockState.lastDispatchThinkingLevelOverride).toBe("low");
  });

  it.each([
    [
      "keeps explicit delivery routes for channel-scoped sessions",
      "origin-routing",
      { channel: "telegram", to: "telegram:6812765697", accountId: "default", threadId: 42 },
      "agent:main:telegram:direct:6812765697",
      { deliver: true, external: true },
    ],
    [
      "keeps explicit delivery routes for Feishu channel-scoped sessions",
      "feishu-origin-routing",
      { channel: "feishu", to: "ou_feishu_direct_123", accountId: "default" },
      "agent:main:feishu:direct:ou_feishu_direct_123",
      { deliver: true, external: true },
    ],
    [
      "keeps explicit delivery routes for per-account channel-peer sessions",
      "per-account-channel-peer-routing",
      { channel: "telegram", to: "telegram:6812765697", accountId: "account-a" },
      "agent:main:telegram:account-a:direct:6812765697",
      { deliver: true, external: true },
    ],
    [
      "keeps explicit delivery routes for legacy channel-peer sessions",
      "legacy-channel-peer-routing",
      { channel: "telegram", to: "telegram:6812765697", accountId: "default" },
      "agent:main:telegram:6812765697",
      { deliver: true, external: true },
    ],
    [
      "keeps explicit delivery routes for legacy thread sessions",
      "legacy-thread-channel-peer-routing",
      { channel: "telegram", to: "telegram:6812765697", accountId: "default", threadId: "42" },
      "agent:main:telegram:6812765697:thread:42",
      { deliver: true, external: true },
    ],
    [
      "does not inherit external delivery context for shared main sessions",
      "main-no-cross-route",
      { channel: "discord", to: "discord:1234567890", accountId: "default" },
      "main",
    ],
    [
      "does not inherit external delivery context for UI clients on main sessions",
      "main-ui-routes",
      { channel: "whatsapp", to: "whatsapp:+8613800138000", accountId: "default" },
      "agent:main:main",
      { clientMode: GATEWAY_CLIENT_MODES.UI },
    ],
    [
      "does not inherit external delivery context for UI clients on main sessions when deliver is enabled",
      "main-ui-deliver-no-route",
      { channel: "telegram", to: "telegram:200482621", accountId: "default" },
      "agent:main:main",
      { clientMode: GATEWAY_CLIENT_MODES.UI, deliver: true },
    ],
    [
      "inherits external delivery context for CLI clients on configured main sessions",
      "config-main-cli-routes",
      { channel: "whatsapp", to: "whatsapp:+8613800138000", accountId: "default" },
      "agent:main:work",
      {
        clientMode: GATEWAY_CLIENT_MODES.CLI,
        mainSessionKey: "work",
        deliver: true,
        external: true,
      },
    ],
    [
      "inherits canonical origin-backed routing for configured main CLI sessions",
      "config-main-origin-provider-routes",
      { channel: "whatsapp", to: "whatsapp:+8613800138000", accountId: "default" },
      "agent:main:work",
      {
        clientMode: GATEWAY_CLIENT_MODES.CLI,
        mainSessionKey: "work",
        origin: { provider: "whatsapp", accountId: "default" },
        deliver: true,
        external: true,
      },
    ],
    [
      "inherits canonical origin-backed thread routing for configured main CLI sessions",
      "config-main-origin-thread-routes",
      { channel: "telegram", to: "telegram:6812765697", accountId: "default", threadId: "42" },
      "agent:main:work",
      {
        clientMode: GATEWAY_CLIENT_MODES.CLI,
        mainSessionKey: "work",
        origin: { provider: "telegram", accountId: "default", threadId: "42" },
        deliver: true,
        external: true,
      },
    ],
    [
      "keeps configured main delivery inheritance when connect metadata omits client details",
      "config-main-connect-no-client",
      { channel: "whatsapp", to: "whatsapp:+8613800138000", accountId: "default" },
      "agent:main:work",
      { mainSessionKey: "work", omitClientDetails: true, deliver: true, external: true },
    ],
    // Two custom tokens exercise legacy-shape detection; a single token does not.
    [
      "does not inherit external delivery context for non-channel custom sessions",
      "custom-no-cross-route",
      { channel: "discord", to: "discord:1234567890", accountId: "default" },
      "agent:main:work:ticket-123",
    ],
    [
      "keeps replies on the internal surface when deliver is not enabled",
      "no-deliver-internal-surface",
      { channel: "discord", to: "user:1234567890", accountId: "default" },
      "agent:main:discord:direct:1234567890",
      { deliver: false },
    ],
    [
      "does not inherit external routes for webchat clients on channel-scoped sessions",
      "webchat-channel-scoped-no-inherit",
      { channel: "imessage", to: "+8619800001234", accountId: "default" },
      "agent:main:imessage:direct:+8619800001234",
      { clientMode: GATEWAY_CLIENT_MODES.WEBCHAT, deliver: true },
    ],
    [
      "still inherits external routes for UI clients on channel-scoped sessions",
      "ui-channel-scoped-inherit",
      { channel: "imessage", to: "+8619800001234", accountId: "default" },
      "agent:main:imessage:direct:+8619800001234",
      { clientMode: GATEWAY_CLIENT_MODES.UI, deliver: true, external: true },
    ],
  ] satisfies ChatDeliveryRoutingCase[])(
    "chat.send %s",
    async (...[_name, id, delivery, sessionKey, options = {}]: ChatDeliveryRoutingCase) => {
      await createTranscriptFixture(`openclaw-chat-send-${id}-`, { agentId: "main", sessionKey });
      mockState.finalText = "ok";
      mockState.mainSessionKey = options.mainSessionKey ?? "main";
      mockState.sessionEntry = {
        delivery: normalizeSessionDeliveryState({
          context: delivery,
          ...(options.origin ? { origin: options.origin } : {}),
        }),
      };
      const client = options.clientMode
        ? {
            connect: {
              client: {
                mode: options.clientMode,
                id:
                  options.clientMode === GATEWAY_CLIENT_MODES.CLI
                    ? "cli"
                    : options.clientMode === GATEWAY_CLIENT_MODES.WEBCHAT
                      ? "openclaw-webchat"
                      : "openclaw-tui",
              },
            },
          }
        : options.omitClientDetails
          ? { connect: {} }
          : undefined;

      await runNonStreamingChatSend({
        context: createChatContext(),
        respond: vi.fn(),
        idempotencyKey: `idem-${id}`,
        sessionKey,
        ...(client ? { client } : {}),
        ...(typeof options.deliver === "boolean" ? { deliver: options.deliver } : {}),
        expectBroadcast: false,
      });

      expectDispatchContextFields({
        OriginatingChannel: options.external ? delivery.channel : "webchat",
        OriginatingTo: options.external ? delivery.to : undefined,
        ExplicitDeliverRoute: Boolean(options.external && options.deliver),
        AccountId: options.external ? delivery.accountId : undefined,
        ...(options.external && delivery.threadId !== undefined
          ? { MessageThreadId: delivery.threadId }
          : {}),
      });
    },
  );

  it("chat.send accepts admin-scoped synthetic originating routes without external delivery", async () => {
    await createReadyChatTranscript("openclaw-chat-send-synthetic-origin-admin-");
    const { send } = createChatRequestFixture();

    await send({
      idempotencyKey: "idem-synthetic-origin-admin",
      client: createScopedCliClient(["operator.admin"]),
      requestParams: {
        originatingChannel: "slack",
        originatingTo: "D123",
        originatingAccountId: "default",
        originatingThreadId: "thread-42",
      },
      deliver: false,
      expectBroadcast: false,
    });

    expectDispatchContextFields({
      OriginatingChannel: "slack",
      OriginatingTo: "D123",
      ExplicitDeliverRoute: false,
      AccountId: "default",
      MessageThreadId: "thread-42",
    });
  });

  it("rejects synthetic originating routes when the caller lacks admin scope", async () => {
    await createReadyChatTranscript("openclaw-chat-send-synthetic-origin-reject-");
    const { respond, send } = createChatRequestFixture();

    await send({
      idempotencyKey: "idem-synthetic-origin-reject",
      client: createScopedCliClient(["operator.write"]),
      requestParams: {
        originatingChannel: "slack",
        originatingTo: "D123",
      },
      expectBroadcast: false,
      waitForCompletion: false,
    });

    const [ok, _payload, error] = lastRespondCall(respond) ?? [];
    expect(ok).toBe(false);
    expect(error?.message).toBe("originating route fields require admin scope");
    expect(mockState.lastDispatchCtx).toBeUndefined();
  });

  it("rejects reserved system provenance fields for non-ACP clients", async () => {
    await createReadyChatTranscript("openclaw-chat-send-system-provenance-reject-");
    const { respond, send } = createChatRequestFixture();

    await send({
      idempotencyKey: "idem-system-provenance-reject",
      requestParams: {
        systemInputProvenance: { kind: "external_user", sourceChannel: "acp" },
        systemProvenanceReceipt: "[Source Receipt]\nbridge=openclaw-acp\n[/Source Receipt]",
      },
      expectBroadcast: false,
      waitForCompletion: false,
    });

    const [ok, _payload, error] = lastRespondCall(respond) ?? [];
    expect(ok).toBe(false);
    expect(error?.message).toBe("system provenance fields require admin scope");
    expect(mockState.lastDispatchCtx).toBeUndefined();
  });

  it("rejects forged ACP metadata when the caller lacks admin scope", async () => {
    await createReadyChatTranscript("openclaw-chat-send-system-provenance-spoof-reject-");
    const { respond, send } = createChatRequestFixture();

    await send({
      idempotencyKey: "idem-system-provenance-spoof-reject",
      client: createScopedCliClient(["operator.write"], {
        id: "cli",
        displayName: "ACP",
        version: "acp",
      }),
      requestParams: {
        systemInputProvenance: {
          kind: "external_user",
          originSessionId: "acp-session-spoof",
          sourceChannel: "acp",
          sourceTool: "openclaw_acp",
        },
        systemProvenanceReceipt:
          "[Source Receipt]\nbridge=openclaw-acp\noriginSessionId=acp-session-spoof\n[/Source Receipt]",
      },
      expectBroadcast: false,
      waitForCompletion: false,
    });

    const [ok, _payload, error] = lastRespondCall(respond) ?? [];
    expect(ok).toBe(false);
    expect(error?.message).toBe("system provenance fields require admin scope");
    expect(mockState.lastDispatchCtx).toBeUndefined();
  });

  it("allows admin-scoped clients to inject system provenance without ACP metadata", async () => {
    await createReadyChatTranscript("openclaw-chat-send-system-provenance-admin-");
    const { send } = createChatRequestFixture();

    await send({
      idempotencyKey: "idem-system-provenance-admin",
      message: "ops update",
      client: createScopedCliClient(["operator.admin"], {
        id: "custom-operator",
      }),
      requestParams: {
        systemInputProvenance: {
          kind: "external_user",
          originSessionId: "admin-session-1",
          sourceChannel: "acp",
          sourceTool: "openclaw_acp",
        },
        systemProvenanceReceipt:
          "[Source Receipt]\nbridge=openclaw-acp\noriginSessionId=admin-session-1\n[/Source Receipt]",
      },
      expectBroadcast: false,
    });

    expect(mockState.lastDispatchCtx?.InputProvenance).toEqual({
      kind: "external_user",
      originSessionId: "admin-session-1",
      sourceChannel: "acp",
      sourceTool: "openclaw_acp",
    });
    expect(mockState.lastDispatchCtx?.Body).toBe(
      "[Source Receipt]\nbridge=openclaw-acp\noriginSessionId=admin-session-1\n[/Source Receipt]\n\nops update",
    );
    expect(mockState.lastDispatchCtx?.RawBody).toBe("ops update");
    expect(mockState.lastDispatchCtx?.CommandBody).toBe("ops update");
  });

  it("forwards gateway caller scopes into the dispatch context", async () => {
    await createReadyChatTranscript("openclaw-chat-send-gateway-client-scopes-");
    const { send } = createChatRequestFixture();

    await send({
      idempotencyKey: "idem-gateway-client-scopes",
      message: "/scopecheck",
      client: createScopedCliClient(["operator.write", "operator.pairing"]),
      expectBroadcast: false,
    });

    expect(mockState.lastDispatchCtx?.GatewayClientScopes).toEqual([
      "operator.write",
      "operator.pairing",
    ]);
    expect(mockState.lastDispatchCtx?.CommandBody).toBe("/scopecheck");
  });

  it("forwards gateway client capabilities into the dispatch context", async () => {
    await createReadyChatTranscript("openclaw-chat-send-gateway-client-caps-");
    const { send } = createChatRequestFixture();

    await send({
      idempotencyKey: "idem-gateway-client-caps",
      message: "show a widget",
      client: createScopedCliClient([], {}, [GATEWAY_CLIENT_CAPS.INLINE_WIDGETS]),
      expectBroadcast: false,
    });

    expect(mockState.lastDispatchCtx?.GatewayClientCaps).toEqual([
      GATEWAY_CLIENT_CAPS.INLINE_WIDGETS,
    ]);
  });

  it("normalizes missing gateway caller scopes to an empty array before dispatch", async () => {
    await createReadyChatTranscript("openclaw-chat-send-missing-gateway-client-scopes-");
    const { send } = createChatRequestFixture();

    await send({
      idempotencyKey: "idem-gateway-client-scopes-missing",
      message: "/scopecheck",
      client: createScopedCliClient(),
      expectBroadcast: false,
    });

    expect(mockState.lastDispatchCtx?.GatewayClientScopes).toStrictEqual([]);
    expect(mockState.lastDispatchCtx?.GatewayClientCaps).toStrictEqual([]);
    expect(mockState.lastDispatchCtx?.CommandBody).toBe("/scopecheck");
  });

  it("injects ACP system provenance into the agent-visible body", async () => {
    await createReadyChatTranscript("openclaw-chat-send-system-provenance-acp-");
    const { send } = createChatRequestFixture();
    const provenance = {
      kind: "external_user" as const,
      originSessionId: "acp-session-1",
      sourceChannel: "acp",
      sourceTool: "openclaw_acp",
    };

    await send({
      idempotencyKey: "idem-system-provenance-acp",
      message: "bench update",
      client: createScopedCliClient(["operator.admin"], {
        id: "cli",
        displayName: "ACP",
        version: "acp",
      }),
      requestParams: {
        systemInputProvenance: provenance,
        systemProvenanceReceipt:
          "[Source Receipt]\nbridge=openclaw-acp\noriginSessionId=acp-session-1\n[/Source Receipt]",
      },
      expectBroadcast: false,
    });

    expect(mockState.lastDispatchCtx?.InputProvenance).toEqual(provenance);
    expect(mockState.lastDispatchCtx?.Body).toBe(
      "[Source Receipt]\nbridge=openclaw-acp\noriginSessionId=acp-session-1\n[/Source Receipt]\n\nbench update",
    );
    expect(mockState.lastDispatchCtx?.RawBody).toBe("bench update");
    expect(mockState.lastDispatchCtx?.CommandBody).toBe("bench update");
    expect(mockState.lastDispatchUserTurnInput).toEqual({
      role: "user",
      content: "bench update",
      timestamp: expect.any(Number),
      idempotencyKey: "idem-system-provenance-acp:user",
      __openclaw: { senderIsOwner: true },
      provenance: {
        ...provenance,
        sourceSessionKey: undefined,
      },
    });
  });

  it("prepares clean text-only chat.send user turns for Pi persistence", async () => {
    await createReadyChatTranscript("openclaw-chat-send-user-transcript-agent-run-");
    mockState.triggerAgentRunStart = true;
    const { context, send } = createChatRequestFixture();

    await send({
      idempotencyKey: "idem-user-transcript-agent-run",
      message: "hello from dashboard",
      expectBroadcast: false,
    });

    expect(findUserUpdate()).toBeUndefined();
    expect(mockState.lastDispatchUserTurnInput).toEqual({
      role: "user",
      content: "hello from dashboard",
      timestamp: expect.any(Number),
      idempotencyKey: "idem-user-transcript-agent-run:user",
    });
    const finalBroadcast = context.broadcast.mock.calls.find(
      (call) =>
        call[0] === "chat" && (call[1] as { state?: unknown } | undefined)?.state === "final",
    )?.[1];
    expect(finalBroadcast).toBeUndefined();
  });

  it("does not emit pre-gate user transcript content when before_agent_run hooks are registered", async () => {
    await createReadyChatTranscript("openclaw-chat-send-user-transcript-before-run-gate-");
    mockState.triggerAgentRunStart = true;
    mockState.hasBeforeAgentRunHooks = true;
    let userUpdateCountAtAgentStart = 0;
    mockState.onAfterAgentRunStart = () => {
      userUpdateCountAtAgentStart = mockState.emittedTranscriptUpdates.filter(
        (update) =>
          typeof update.message === "object" &&
          update.message !== null &&
          (update.message as { role?: unknown }).role === "user",
      ).length;
    };
    const { send } = createChatRequestFixture();

    await send({
      idempotencyKey: "idem-user-transcript-before-run-gate",
      message: "secret prompt that may be blocked",
      expectBroadcast: false,
    });

    expect(userUpdateCountAtAgentStart).toBe(0);
    const userUpdates = mockState.emittedTranscriptUpdates.filter(
      (update) =>
        typeof update.message === "object" &&
        update.message !== null &&
        (update.message as { role?: unknown }).role === "user",
    );
    expect(userUpdates).toHaveLength(0);
  });

  it("does not persist raw user transcript content when a delivered before_agent_run block is followed by a dispatch error", async () => {
    await createTranscriptFixture("openclaw-chat-send-user-transcript-blocked-delivery-error-");
    mockState.triggerAgentRunStart = true;
    mockState.hasBeforeAgentRunHooks = true;
    mockState.dispatchBlockedByBeforeAgentRun = true;
    mockState.dispatchErrorAfterDelivery = new Error("delivery failed after block");
    mockState.dispatchedReplies = [
      {
        kind: "block",
        payload: setReplyPayloadMetadata(
          { text: "The agent cannot read this message." },
          { beforeAgentRunBlocked: true },
        ),
      },
    ];
    const { context, send } = createChatRequestFixture();

    await send({
      idempotencyKey: "idem-user-transcript-blocked-delivery-error",
      message: "secret prompt blocked before persistence then delivery failed",
      expectBroadcast: false,
    });

    await waitForAssertion(() => {
      expect(context.dedupe.get("chat:idem-user-transcript-blocked-delivery-error")?.ok).toBe(
        false,
      );
    });
    expect(findUserUpdate()).toBeUndefined();
    expect(readPersistedUserMessages()).toHaveLength(0);
  });

  it("emits a user transcript update when hooks pass and the started agent throws before runtime persistence", async () => {
    await createGatewayUserTurnSqliteFixture("openclaw-chat-send-user-transcript-gate-pass-error-");
    mockState.triggerAgentRunStart = true;
    mockState.hasBeforeAgentRunHooks = true;
    mockState.dispatchErrorAfterAgentRunStart = new Error("model unavailable");
    const { context, send } = createChatRequestFixture();

    await send({
      idempotencyKey: "idem-user-transcript-gate-pass-error",
      message: "prompt allowed before model error",
      expectBroadcast: false,
    });

    await waitForAssertion(() => {
      expect(context.dedupe.get("chat:idem-user-transcript-gate-pass-error")?.ok).toBe(false);
      const userUpdate = findUserUpdate();
      const message = userUpdateMessage(userUpdate);
      expectUserUpdateIdentity(userUpdate);
      expect(message?.role).toBe("user");
      expect(message?.content).toBe("prompt allowed before model error");
    });
  });

  it("prepares managed image claims for Pi user-turn persistence", async () => {
    await createReadyChatTranscript("openclaw-chat-send-user-transcript-images-");
    mockState.triggerAgentRunStart = true;
    setSavedMediaResults(
      ["/tmp/chat-send-image-a.png", "image/png", "chat-send-image-a.png"],
      ["/tmp/chat-send-image-b.jpg", "image/jpeg", "chat-send-image-b.jpg"],
    );
    const { send } = createChatRequestFixture();

    await send({
      idempotencyKey: "idem-user-transcript-images",
      message: "edit these",
      requestParams: {
        attachments: [
          createImageAttachment({ content: INLINE_PNG_BASE64 }),
          createImageAttachment({ content: TINY_JPEG_BASE64, mimeType: "image/jpeg" }),
        ],
      },
      expectBroadcast: false,
      waitForCompletion: false,
    });

    await waitForAssertion(() => {
      expect(mockState.savedMediaCalls).toEqual([
        {
          contentType: "image/png",
          subdir: "inbound",
          size: mockState.savedMediaCalls[0]?.size ?? 0,
        },
        {
          contentType: "image/jpeg",
          subdir: "inbound",
          size: mockState.savedMediaCalls[1]?.size ?? 0,
        },
      ]);
      expect(typeof mockState.savedMediaCalls[0]?.size).toBe("number");
      expect(typeof mockState.savedMediaCalls[1]?.size).toBe("number");
      const userTurnInput = mockState.lastDispatchUserTurnInput as
        | { content?: unknown }
        | undefined;
      if (!userTurnInput) {
        throw new Error("expected user turn input with media metadata");
      }
      expect(findUserUpdate()).toBeUndefined();
      expect(userTurnInput.content).toBe("edit these");
      expectClaimOnlyTranscriptMedia(
        userTurnInput,
        [
          expect.objectContaining({
            url: "media://inbound/chat-send-image-a.png",
            contentType: "image/png",
            kind: "image",
          }),
          expect.objectContaining({
            url: "media://inbound/chat-send-image-b.jpg",
            contentType: "image/jpeg",
            kind: "image",
          }),
        ],
        ["/tmp/chat-send-image-a.png", "/tmp/chat-send-image-b.jpg"],
      );
      expect(mockState.lastDispatchCtx?.media).toBeUndefined();
      expect(mockState.lastDispatchImages).toHaveLength(2);
    });
  });

  it("prepares non-image chat.send attachments as claim-only media refs without dispatch images", async () => {
    await createReadyChatTranscript("openclaw-chat-send-user-transcript-file-");
    mockState.triggerAgentRunStart = true;
    setSavedMediaResults(["/tmp/chat-send-brief.pdf", "application/pdf"]);
    const { send } = createChatRequestFixture();

    await send({
      idempotencyKey: "idem-user-transcript-file",
      message: "summarize this",
      requestParams: {
        attachments: [
          createFileAttachment(
            "brief.pdf",
            "application/pdf",
            Buffer.from("%PDF-1.4\n").toString("base64"),
          ),
        ],
      },
      expectBroadcast: false,
      waitForCompletion: false,
    });

    await waitForAssertion(() => {
      const userTurnInput = mockState.lastDispatchUserTurnInput as
        | { content?: unknown }
        | undefined;
      expect(mockState.lastDispatchImages).toBeUndefined();
      expect(mockState.lastDispatchImageOrder).toBeUndefined();
      expect(mockState.lastDispatchCtx?.Body).toBe(
        "summarize this\n[media attached: media://inbound/saved-media]",
      );
      expect(mockState.savedMediaCalls[0]?.contentType).toBe("application/pdf");
      expect(mockState.savedMediaCalls[0]?.subdir).toBe("inbound");
      expect(typeof mockState.savedMediaCalls[0]?.size).toBe("number");
      expect(findUserUpdate()).toBeUndefined();
      expect(userTurnInput?.content).toBe("summarize this");
      expectClaimOnlyTranscriptMedia(
        userTurnInput,
        [
          {
            url: "media://inbound/saved-media",
            contentType: "application/pdf",
            kind: "document",
            fileName: "brief.pdf",
            sizeBytes: 9,
            hydrationSuppressed: true,
          },
        ],
        ["/tmp/chat-send-brief.pdf", "%PDF-1.4"],
      );
    });
  });

  it("preserves managed attachment claims in transcript order", async () => {
    await createReadyChatTranscript("openclaw-chat-send-user-transcript-offloaded-");
    mockState.triggerAgentRunStart = true;
    useChatTestModel("vision-model", true);
    setSavedMediaResults(
      ["/tmp/offloaded-big.png", "image/png", "offloaded-big.png"],
      ["/tmp/chat-send-inline.png", "image/png", "chat-send-inline.png"],
    );
    const { send } = createChatRequestFixture();
    const bigPng = createPngBuffer(2_100_000);

    await send({
      idempotencyKey: "idem-user-transcript-offloaded",
      message: "edit both",
      requestParams: {
        attachments: [
          createImageAttachment({ content: INLINE_PNG_BASE64 }),
          createImageAttachment({ content: bigPng.toString("base64") }),
        ],
      },
      expectBroadcast: false,
      waitForCompletion: false,
    });

    await waitForAssertion(() => {
      const userTurnInput = mockState.lastDispatchUserTurnInput as
        | { content?: unknown }
        | undefined;
      expect(findUserUpdate()).toBeUndefined();
      expect(userTurnInput?.content).toBe("edit both");
      expectClaimOnlyTranscriptMedia(
        userTurnInput,
        [
          expect.objectContaining({
            url: "media://inbound/chat-send-inline.png",
            contentType: "image/png",
            kind: "image",
          }),
          expect.objectContaining({
            url: "media://inbound/offloaded-big.png",
            contentType: "image/png",
            kind: "image",
          }),
        ],
        ["/tmp/chat-send-inline.png", "/tmp/offloaded-big.png"],
      );
      expect(userTurnInput?.content).not.toContain("media://");
    });
  });

  it("leaves ACP bridge user persistence to the agent runtime", async () => {
    await createReadyChatTranscript("openclaw-chat-send-user-transcript-acp-images-");
    mockState.triggerAgentRunStart = true;
    setSavedMediaResults(["/tmp/should-not-be-used.png", "image/png"]);
    const { send } = createChatRequestFixture();

    await send({
      idempotencyKey: "idem-user-transcript-acp-images",
      message: "bridge image",
      client: {
        connect: {
          client: {
            id: GATEWAY_CLIENT_NAMES.CLI,
            mode: GATEWAY_CLIENT_MODES.CLI,
            displayName: "ACP",
            version: "acp",
          },
        },
      },
      requestParams: {
        attachments: [createImageAttachment({ content: INLINE_PNG_BASE64 })],
      },
      expectBroadcast: false,
    });

    await waitForAssertion(() => {
      expect(mockState.savedMediaCalls).toStrictEqual([]);
      expect(findUserUpdate()).toBeUndefined();
      expect(mockState.lastDispatchUserTurnInput).toEqual({
        role: "user",
        content: "bridge image",
        timestamp: expect.any(Number),
        idempotencyKey: "idem-user-transcript-acp-images:user",
      });
    });
  });

  it("waits for the user transcript update before final broadcast on non-agent attachment sends", async () => {
    await createGatewayUserTurnSqliteFixture("openclaw-chat-send-no-agent-images-order-");
    mockState.finalText = "ok";
    setSavedMediaResults(["/tmp/chat-send-image-a.png", "image/png"]);
    let releaseSave = () => {};
    mockState.saveMediaWait = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const { context, send } = createChatRequestFixture();

    await send({
      idempotencyKey: "idem-no-agent-images-order",
      message: "quick command",
      requestParams: {
        attachments: [createImageAttachment({ content: INLINE_PNG_BASE64 })],
      },
      expectBroadcast: false,
      waitForCompletion: false,
    });

    expect(context.broadcast.mock.calls.length).toBe(0);
    releaseSave();

    await waitForAssertion(() => {
      expect(context.broadcast.mock.calls.length).toBe(1);
      const userUpdate = findUserUpdate();
      if (userUpdate?.message === undefined) {
        throw new Error("Expected streamed user transcript update message");
      }
      expectUserUpdateIdentity(userUpdate);
    });
  });

  it("preserves media-only final replies in the final broadcast message", async () => {
    await expectImageOnlyFinal({
      transcriptPrefix: "openclaw-chat-send-media-only-final-",
      idempotencyKey: "idem-media-only-final",
      finalPayload: { mediaUrl: `data:image/png;base64,${TINY_PNG_BASE64}` },
    });
  });

  it("strips NO_REPLY from transcript text when final replies only carry media", async () => {
    await expectImageOnlyFinal({
      transcriptPrefix: "openclaw-chat-send-media-only-silent-final-",
      idempotencyKey: "idem-media-only-silent-final",
      finalPayload: { text: "NO_REPLY", mediaUrl: `data:image/png;base64,${TINY_PNG_BASE64}` },
    });
  });

  it("persists typed reply facts for media replies without leaking tags", async () => {
    await expectImageOnlyFinal({
      transcriptPrefix: "openclaw-chat-send-media-reply-tags-",
      idempotencyKey: "idem-media-reply-tags",
      finalPayload: {
        replyToCurrent: true,
        mediaUrl: `data:image/png;base64,${TINY_PNG_BASE64}`,
      },
    });
    const transcriptUpdate = mockState.emittedTranscriptUpdates.find(
      (update) =>
        typeof update.message === "object" &&
        update.message !== null &&
        (update.message as { role?: unknown }).role === "assistant" &&
        Array.isArray((update.message as { content?: unknown }).content) &&
        (update.message as { openclawDelivery?: { replyToCurrent?: boolean } }).openclawDelivery
          ?.replyToCurrent === true,
    );
    const transcriptMessage = transcriptUpdate?.message as Record<string, any> | undefined;
    const displayContent = Array.isArray(transcriptMessage?.openclawDisplayContent)
      ? transcriptMessage.openclawDisplayContent
      : transcriptMessage?.content;
    expect(transcriptMessage?.role).toBe("assistant");
    expect(displayContent?.[0]).toEqual({
      type: "text",
      text: "Image reply",
    });
    expect(displayContent?.[1]).toMatchObject({
      type: "image",
      artifactId: expect.stringMatching(/^artifact_managed_image_/u),
      mimeType: "image/png",
    });
    expect(JSON.stringify(transcriptUpdate)).not.toContain("[[reply_to_current]]");
    expect(JSON.stringify(transcriptUpdate)).not.toContain(TINY_PNG_BASE64);
  });

  it("does not persist sensitive image media into transcript updates", async () => {
    await createTranscriptFixture("openclaw-chat-send-sensitive-media-final-");
    mockState.finalPayload = {
      text: "Scan this QR code with the OpenClaw iOS app:",
      mediaUrl: "data:image/png;base64,cG5n",
      sensitiveMedia: true,
    };
    const { send } = createChatRequestFixture();

    const payload = await send({
      idempotencyKey: "idem-sensitive-media-final",
    });

    const content = getMessageContent(payload);
    expect(getMessage(payload)?.role).toBe("assistant");
    expect(content[0]).toEqual({
      type: "text",
      text: "Scan this QR code with the OpenClaw iOS app:",
    });
    expect(content[1]).toEqual({ type: "input_image", image_url: "data:image/png;base64,cG5n" });
    const transcriptUpdate = mockState.emittedTranscriptUpdates.find(
      (update) =>
        typeof update.message === "object" &&
        update.message !== null &&
        (update.message as { role?: unknown }).role === "assistant",
    );
    const transcriptMessage = transcriptUpdate?.message as Record<string, any> | undefined;
    expect(transcriptMessage?.role).toBe("assistant");
    expect(transcriptMessage?.content?.[0]).toEqual({
      type: "text",
      text: "Scan this QR code with the OpenClaw iOS app:",
    });
    expect(JSON.stringify(transcriptUpdate)).not.toContain("input_image");
    expect(JSON.stringify(transcriptUpdate)).not.toContain("data:image/png;base64,cG5n");
    expect(JSON.stringify(payload?.message)).not.toContain("/api/chat/media/outgoing/");
  });

  it("sanitizes replyToId before emitting inline reply directives", async () => {
    await createTranscriptFixture("openclaw-chat-send-sanitized-reply-id-");
    mockState.finalPayload = {
      text: "hello",
      replyToId: "abc]]\n[[audio_as_voice]]",
    };
    const { send } = createChatRequestFixture();

    const payload = await send({
      idempotencyKey: "idem-sanitized-reply-id",
    });

    expect(extractFirstTextBlock(payload)?.trim()).toBe("hello");
    const transcriptUpdate = mockState.emittedTranscriptUpdates.find(
      (update) =>
        typeof update.message === "object" &&
        update.message !== null &&
        (update.message as { role?: unknown }).role === "assistant",
    );
    expect(transcriptUpdate?.message).toMatchObject({
      openclawDelivery: { replyToId: "abcaudio_as_voice" },
    });
    expect(JSON.stringify(transcriptUpdate)).not.toContain("[[reply_to:");
    expect(JSON.stringify(transcriptUpdate)).not.toContain("[[audio_as_voice]]");
  });

  it("falls back to inline reply id when structured replyToId sanitizes empty", async () => {
    await createTranscriptFixture("openclaw-chat-send-inline-reply-id-fallback-");
    mockState.finalPayload = {
      text: "hello[[reply_to:inline-id]]",
      replyToId: "]]\n[[",
    };
    const { send } = createChatRequestFixture();

    const payload = await send({
      idempotencyKey: "idem-inline-reply-id-fallback",
    });

    expect(extractFirstTextBlock(payload)?.trim()).toBe("hello");
    const transcriptUpdate = mockState.emittedTranscriptUpdates.find(
      (update) =>
        typeof update.message === "object" &&
        update.message !== null &&
        (update.message as { role?: unknown }).role === "assistant",
    );
    expect(transcriptUpdate?.message).toMatchObject({
      openclawDelivery: { replyToId: "inline-id" },
    });
    expect(JSON.stringify(transcriptUpdate)).not.toContain("[[reply_to:");
  });

  it("routes text-only image offloads into media-understanding fields", async () => {
    await createReadyChatTranscript("openclaw-chat-send-text-only-attachments-");
    useChatTestModel("text-only");
    const { send } = createChatRequestFixture();

    await send({
      idempotencyKey: "idem-text-only-attachments",
      message: "describe image",
      requestParams: {
        attachments: [createImageAttachment({ content: OFFLOAD_PNG_BASE64 })],
      },
      expectBroadcast: false,
      waitFor: "none",
    });

    await waitForAssertion(() => {
      expect(mockState.lastDispatchCtx?.Body).toBe("describe image");
    });
    expect(mockState.lastDispatchImages).toBeUndefined();
    expect(mockState.lastDispatchImageOrder).toEqual(["offloaded"]);
    expect(mockState.lastDispatchCtx?.Body).toBe("describe image");
    expect(mockState.lastDispatchCtx?.Body).not.toContain("media://");
    expect(mockState.lastDispatchCtx?.media).toEqual([
      {
        path: "/tmp/1.png",
        contentType: "image/png",
        workspaceDir: "/tmp",
      },
    ]);
    expect(mockState.savedMediaCalls).toEqual([
      {
        contentType: "image/png",
        subdir: "inbound",
        size: mockState.savedMediaCalls[0]?.size ?? 0,
      },
    ]);
  });

  it("keeps image attachments inline for configured custom vision models", async () => {
    await createReadyChatTranscript("openclaw-chat-send-configured-custom-vision-");
    mockState.sessionEntry = {
      modelProvider: "modelscope",
      model: "Qwen/Qwen3.5-35B-A3B",
      providerOverride: "modelscope",
      modelOverride: "Qwen/Qwen3.5-35B-A3B",
    };
    mockState.modelCatalog = [
      {
        provider: "modelscope",
        id: "qwen/qwen3.5-35b-a3b",
        name: "Qwen3.5 35B",
        input: ["text", "image"],
      },
    ];
    const { send } = createChatRequestFixture();

    await send({
      idempotencyKey: "idem-configured-custom-vision",
      message: "describe image",
      requestParams: {
        attachments: [createImageAttachment({ content: OFFLOAD_PNG_BASE64 })],
      },
      expectBroadcast: false,
    });

    expect(mockState.lastDispatchImages?.[0]?.mimeType).toBe("image/png");
    expect(typeof mockState.lastDispatchImages?.[0]?.data).toBe("string");
    expect(mockState.lastDispatchImageOrder).toEqual(["inline"]);
    expect(mockState.lastDispatchCtx?.Body).toBe("describe image");
    expect(mockState.savedMediaCalls).toEqual([
      {
        contentType: "image/png",
        subdir: "inbound",
        size: mockState.savedMediaCalls[0]?.size ?? 0,
      },
    ]);
  });

  it("keeps image attachments for text-only sessions bound to ACP", async () => {
    await createReadyChatTranscript("openclaw-chat-send-text-only-acp-bound-attachments-");
    useChatTestModel("text-only");
    bindingMocks.resolveByConversation.mockReturnValue({
      targetSessionKey: "agent:claude:acp:spawned",
    });
    const { send } = createChatRequestFixture();

    await send({
      idempotencyKey: "idem-text-only-acp-bound-attachments",
      message: "describe image",
      client: createScopedCliClient(["operator.admin"]),
      requestParams: {
        originatingChannel: "slack",
        originatingTo: "user:U123",
        originatingAccountId: "default",
        attachments: [createImageAttachment({ content: OFFLOAD_PNG_BASE64 })],
      },
      expectBroadcast: false,
    });

    expect(bindingMocks.resolveByConversation).toHaveBeenCalledWith({
      channel: "slack",
      accountId: "default",
      conversationId: "user:U123",
    });
    expect(mockState.lastDispatchImages).toHaveLength(1);
    expect(mockState.lastDispatchImageOrder).toEqual(["inline"]);
  });

  it("resolves attachment image support from the session agent model", async () => {
    await createReadyChatTranscript("openclaw-chat-send-agent-scoped-text-only-attachments-");
    mockState.config = {
      agents: {
        list: [
          {
            id: "vision",
            default: true,
            model: "test-provider/vision-model",
          },
          {
            id: "writer",
            model: "test-provider/text-only",
          },
        ],
      },
    };
    mockState.modelCatalog = [
      {
        provider: "test-provider",
        id: "vision-model",
        name: "Vision model",
        input: ["text", "image"],
      },
      {
        provider: "test-provider",
        id: "text-only",
        name: "Text only",
        input: ["text"],
      },
    ];
    const { send } = createChatRequestFixture();

    await send({
      sessionKey: "agent:writer:main",
      idempotencyKey: "idem-agent-scoped-text-only-attachments",
      message: "describe image",
      requestParams: {
        attachments: [createImageAttachment({ content: OFFLOAD_PNG_BASE64 })],
      },
      expectBroadcast: false,
      waitFor: "none",
    });

    await waitForAssertion(() => {
      expect(mockState.lastDispatchCtx?.Body).toBe("describe image");
    });
    expect(mockState.lastDispatchImages).toBeUndefined();
    expect(mockState.lastDispatchImageOrder).toEqual(["offloaded"]);
    expect(mockState.lastDispatchCtx?.Body).toBe("describe image");
    expect(mockState.lastDispatchCtx?.Body).not.toContain("media://");
    expect(mockState.lastDispatchCtx?.media).toEqual([
      {
        path: "/tmp/1.png",
        contentType: "image/png",
        workspaceDir: "/tmp",
      },
    ]);
    expect(mockState.savedMediaCalls).toEqual([
      {
        contentType: "image/png",
        subdir: "inbound",
        size: mockState.savedMediaCalls[0]?.size ?? 0,
      },
    ]);
  });

  it("routes non-image offloaded refs into media facts for chat.send", async () => {
    await createReadyChatTranscript("openclaw-chat-send-non-image-ctx-media-paths-");
    useChatTestModel("vision-model");
    setSavedMediaResults(["/home/user/.openclaw/media/inbound/report.pdf", "application/pdf"]);
    const { send } = createChatRequestFixture();
    const pdf = Buffer.from("%PDF-1.4\n%µ¶\n1 0 obj\n<<>>\nendobj\n").toString("base64");

    await send({
      idempotencyKey: "idem-non-image-ctx-media",
      message: "read this",
      requestParams: {
        attachments: [createFileAttachment("report.pdf", "application/pdf", pdf)],
      },
      expectBroadcast: false,
    });

    expect(mockState.lastDispatchCtx?.media).toEqual([
      {
        path: "/home/user/.openclaw/media/inbound/report.pdf",
        contentType: "application/pdf",
        workspaceDir: "/home/user/.openclaw/media/inbound",
      },
    ]);
    // Non-image offloads retain their claim-check line while the staged path
    // also travels structurally for media tools and transcript persistence.
    expect(mockState.lastDispatchCtx?.Body).toContain(
      "[media attached: media://inbound/saved-media]",
    );
    expect(mockState.lastDispatchCtx?.BodyForAgent).toContain(
      "[media attached: media://inbound/saved-media]",
    );
    expect(mockState.lastDispatchImages).toBeUndefined();
    // The fact workspace is the explicit skip contract for later staging.
  });

  it("routes image-named generic container bytes as non-image media paths for chat.send", async () => {
    await createReadyChatTranscript("openclaw-chat-send-spoofed-image-container-");
    useChatTestModel("vision-model");
    setSavedMediaResults(["/home/user/.openclaw/media/inbound/fake.zip", "application/zip"]);
    const { send } = createChatRequestFixture();
    const zip = Buffer.from("PK\u0003\u0004zip-archive-bytes").toString("base64");

    await send({
      idempotencyKey: "idem-spoofed-image-container",
      message: "inspect this",
      requestParams: {
        attachments: [createFileAttachment("fake.png", "image/png", zip, "image")],
      },
      expectBroadcast: false,
    });

    expect(mockState.savedMediaCalls).toEqual([
      {
        contentType: "application/zip",
        subdir: "inbound",
        size: mockState.savedMediaCalls[0]?.size ?? 0,
      },
    ]);
    expect(mockState.lastDispatchCtx?.media).toEqual([
      {
        path: "/home/user/.openclaw/media/inbound/fake.zip",
        contentType: "application/zip",
        workspaceDir: "/home/user/.openclaw/media/inbound",
      },
    ]);
    expect(mockState.lastDispatchImages).toBeUndefined();
    expect(mockState.lastDispatchCtx?.Body).toContain(
      "[media attached: media://inbound/saved-media]",
    );
  });

  it("preserves sandbox-relative fact paths and workspace context for media-understanding", async () => {
    await createReadyChatTranscript("openclaw-chat-send-non-image-absolutize-");
    useChatTestModel("vision-model");
    setSavedMediaResults(["/home/user/.openclaw/media/inbound/report.pdf", "application/pdf"]);
    mockState.sandboxWorkspace = { workspaceDir: "/sandbox/workspace" };
    mockState.stagedRelativePaths = ["media/inbound/report.pdf"];
    const { send } = createChatRequestFixture();
    const pdf = Buffer.from("%PDF-1.4\n%µ¶\n1 0 obj\n<<>>\nendobj\n").toString("base64");

    await send({
      idempotencyKey: "idem-non-image-absolutize",
      message: "read this",
      requestParams: {
        attachments: [createFileAttachment("report.pdf", "application/pdf", pdf)],
      },
      expectBroadcast: false,
    });

    const { ensureSandboxWorkspaceForSession } = await import("../../agents/sandbox/context.js");
    const { stageSandboxMedia } = await import("../../auto-reply/reply/stage-sandbox-media.js");
    expect(ensureSandboxWorkspaceForSession).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "main" }),
    );
    expect(stageSandboxMedia).toHaveBeenCalledWith(expect.objectContaining({ agentId: "main" }));

    expect(mockState.lastDispatchCtx?.media).toEqual([
      {
        path: "media/inbound/report.pdf",
        contentType: "application/pdf",
        workspaceDir: "/sandbox/workspace",
      },
    ]);
  });

  it("preserves staged non-image paths when plugin-bound sessions also carry inline images", async () => {
    await createReadyChatTranscript("openclaw-chat-send-plugin-bound-mixed-media-staging-");
    useChatTestModel("vision-model");
    bindingMocks.resolveByConversation.mockReturnValue({
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "demo-plugin",
        pluginRoot: "/plugins/demo-plugin",
      },
    });
    setSavedMediaResults(
      ["/home/user/.openclaw/media/inbound/report.pdf", "application/pdf"],
      ["/home/user/.openclaw/media/inbound/screenshot.png", "image/png"],
    );
    mockState.sandboxWorkspace = { workspaceDir: "/sandbox/workspace" };
    mockState.stagedRelativePaths = ["media/inbound/report.pdf"];
    const { send } = createChatRequestFixture();
    const pdf = Buffer.from("%PDF-1.4\n").toString("base64");

    await send({
      idempotencyKey: "idem-plugin-bound-mixed-media-staging",
      message: "inspect these",
      client: createScopedCliClient(["operator.admin"]),
      requestParams: {
        originatingChannel: "slack",
        originatingTo: "user:U123",
        originatingAccountId: "default",
        attachments: [
          createFileAttachment("screenshot.png", "image/png", TINY_PNG_BASE64, "image"),
          createFileAttachment("report.pdf", "application/pdf", pdf),
        ],
      },
      expectBroadcast: false,
    });

    expect(bindingMocks.resolveByConversation).toHaveBeenCalledWith({
      channel: "slack",
      accountId: "default",
      conversationId: "user:U123",
    });
    expect(mockState.lastDispatchImages).toHaveLength(1);
    expect(mockState.lastDispatchImageOrder).toEqual(["inline"]);
    expect(mockState.lastDispatchCtx?.media).toEqual([
      {
        path: "media/inbound/report.pdf",
        contentType: "application/pdf",
        workspaceDir: "/sandbox/workspace",
      },
    ]);
  });

  it("wraps stageSandboxMedia infrastructure errors as 5xx UNAVAILABLE for non-fallback refs and cleans up media-store files", async () => {
    // A non-PDF managed offload cannot fall back to a managed path, so an infra
    // staging error stays a retryable 5xx. (Managed PDFs fall back instead — see
    // the staging-throw fallback test below.) #90097
    await createReadyChatTranscript("openclaw-chat-send-stage-unavailable-");
    useChatTestModel("vision-model");
    setSavedMediaResults([
      "/home/user/.openclaw/media/inbound/report.bin",
      "application/octet-stream",
    ]);
    mockState.sandboxWorkspace = { workspaceDir: "/sandbox/workspace" };
    const stageError = Object.assign(new Error("ENOSPC: no space left on device"), {
      code: "ENOSPC",
    });
    stageError.stack =
      "Error: ENOSPC: no space left on device\n    at stageSandboxMedia (stage-sandbox-media.ts:1:1)";
    mockState.stageSandboxMediaError = stageError;
    const { context, respond, send } = createChatRequestFixture();
    const binPayload = Buffer.from("OPENCLAW-BINARY\n").toString("base64");

    await send({
      idempotencyKey: "idem-stage-unavailable",
      message: "read this",
      requestParams: {
        attachments: [createFileAttachment("report.bin", "application/octet-stream", binPayload)],
      },
      expectBroadcast: false,
      waitFor: "none",
    });

    // Plain Error from stageSandboxMedia would be misclassified as INVALID_REQUEST
    // by the outer catch. Wrapping it in MediaOffloadError routes it to UNAVAILABLE
    // so the client retries instead of treating it as a bad request.
    expect(mockState.lastDispatchCtx).toBeUndefined();
    expect(respond).toHaveBeenCalledTimes(1);
    const [ok, payload, error] = lastRespondCall(respond) ?? [];
    expect(ok).toBe(false);
    expect(payload).toBeUndefined();
    expect(error?.code).toBe(ErrorCodes.UNAVAILABLE);
    expect(responseErrorMessage(error)).toMatch(/ENOSPC|non-image attachments/i);
    const unavailableLogCall = mockCallAt(context.logGateway.error, 0) as
      | [string, Record<string, string>]
      | undefined;
    expect(unavailableLogCall?.[0]).toBe("chat.send attachment parse/stage failed");
    expect(unavailableLogCall?.[1].consoleMessage).toContain(
      "chat.send attachment parse/stage failed: MediaOffloadError",
    );
    expect(unavailableLogCall?.[1].error).toContain(
      "Caused by: Error: ENOSPC: no space left on device\n    at stageSandboxMedia",
    );
    // Orphaned media-store files are cleaned up before the 5xx surfaces.
    expect(mockState.deleteMediaBufferCalls).toEqual([{ id: "saved-media", subdir: "inbound" }]);
  });

  it("logs chat.send attachment parse failures with stack details", async () => {
    await createTranscriptFixture("openclaw-chat-send-attachment-parse-stack-");
    const { context, respond, send } = createChatRequestFixture();

    await send({
      idempotencyKey: "idem-chat-send-attachment-parse-stack",
      message: "inspect this",
      requestParams: {
        attachments: [createFileAttachment("broken.png", "image/png", "not-base64")],
      },
      expectBroadcast: false,
      waitFor: "none",
    });

    expect(mockState.lastDispatchCtx).toBeUndefined();
    const response = lastRespondCall(respond);
    expect(response?.[0]).toBe(false);
    expect(response?.[1]).toBeUndefined();
    expect(response?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(response?.[2]?.message).toContain("attachment broken.png: invalid base64 content");
    expect(getAgentRunContext("idem-chat-send-attachment-parse-stack")).toBeUndefined();
    const parseLogCall = context.logGateway.error.mock.calls[0] as
      | [string, Record<string, string>]
      | undefined;
    expect(parseLogCall?.[0]).toBe("chat.send attachment parse/stage failed");
    expect(parseLogCall?.[1].consoleMessage).toContain(
      "chat.send attachment parse/stage failed: Error: attachment broken.png",
    );
    expect(parseLogCall?.[1].error).toContain(
      "Error: attachment broken.png: invalid base64 content",
    );
    const logMeta = context.logGateway.error.mock.calls[0]?.[1] as { error?: string } | undefined;
    expect(logMeta?.error).toContain("\n    at ");
  });

  it("surfaces partial non-image staging failures as 5xx UNAVAILABLE", async () => {
    // Regression: stageSandboxMedia keeps unstaged entries as their original
    // absolute path, so a simple `stagedPaths.length === nonImage.length`
    // check could not detect when one of the files silently fell out (e.g. a
    // file between the RPC cap and the staging cap). Prestage must compare
    // the returned `staged` map against the input refs. Non-PDF refs cannot fall
    // back to a managed path, so an incomplete stage stays a 5xx. (Managed PDFs
    // fall back instead — see the staging-skip fallback test below.) #90097
    await createReadyChatTranscript("openclaw-chat-send-partial-stage-");
    useChatTestModel("vision-model");
    setSavedMediaResults(
      ["/home/user/.openclaw/media/inbound/report.bin", "application/octet-stream"],
      ["/home/user/.openclaw/media/inbound/data.bin", "application/octet-stream"],
    );
    mockState.sandboxWorkspace = { workspaceDir: "/sandbox/workspace" };
    mockState.stagedRelativePaths = ["media/inbound/report.bin", "media/inbound/data.bin"];
    mockState.unstagedSources = ["/home/user/.openclaw/media/inbound/data.bin"];
    const { respond, send } = createChatRequestFixture();
    const binPayload = Buffer.from("OPENCLAW-BINARY\n").toString("base64");

    await send({
      idempotencyKey: "idem-partial-stage",
      message: "read these",
      requestParams: {
        attachments: [
          createFileAttachment("report.bin", "application/octet-stream", binPayload),
          createFileAttachment("data.bin", "application/octet-stream", binPayload),
        ],
      },
      expectBroadcast: false,
      waitFor: "none",
    });

    expect(mockState.lastDispatchCtx).toBeUndefined();
    expect(respond).toHaveBeenCalledTimes(1);
    const [ok, payload, error] = lastRespondCall(respond) ?? [];
    expect(ok).toBe(false);
    expect(payload).toBeUndefined();
    expect(error?.code).toBe(ErrorCodes.UNAVAILABLE);
    expect(responseErrorMessage(error)).toMatch(/staging incomplete/i);
    // Both media-store entries are cleaned up before the 5xx surfaces.
    expect(mockState.deleteMediaBufferCalls.map((c) => c.id).toSorted()).toEqual([
      "saved-media",
      "saved-media",
    ]);
  });

  it("stages already-managed PDFs above the generic media-store limit", async () => {
    // #90097: the sandbox staging ceiling is intentionally higher than the
    // generic media-store limit, so a 6 MiB PDF should still land in the
    // workspace rather than taking the oversized host-path fallback.
    await createReadyChatTranscript("openclaw-chat-send-managed-pdf-pass-through-");
    useChatTestModel("vision-model");
    setSavedMediaResults(["/home/user/.openclaw/media/inbound/huge.pdf", "application/pdf"]);
    mockState.sandboxWorkspace = { workspaceDir: "/sandbox/workspace" };
    mockState.stagedRelativePaths = ["media/inbound/huge.pdf"];
    const { send } = createChatRequestFixture();
    // 6 MiB PDF — above MEDIA_MAX_BYTES (5 MiB) but below both the default
    // 20 MiB parser cap and the 50 MiB sandbox staging cap.
    const oversized = Buffer.alloc(6 * 1024 * 1024);
    oversized.set(Buffer.from("%PDF-1.4\n"), 0);

    await send({
      idempotencyKey: "idem-managed-pdf-pass-through",
      message: "read this",
      requestParams: {
        attachments: [
          createFileAttachment("huge.pdf", "application/pdf", oversized.toString("base64")),
        ],
      },
      expectBroadcast: false,
    });

    // Reaches dispatch through the same staged workspace path as other files.
    expect(mockState.lastDispatchCtx?.media).toEqual([
      {
        path: "media/inbound/huge.pdf",
        contentType: "application/pdf",
        workspaceDir: "/sandbox/workspace",
      },
    ]);
    expect(mockState.deleteMediaBufferCalls).toEqual([]);
  });

  it("falls back to the managed path when sandbox staging throws for an already-managed PDF", async () => {
    // #90097: an already-managed inbound PDF below the staging cap normally
    // stages into the sandbox, but if staging throws (e.g. workspace mkdir
    // ENOSPC) the PDF must still reach the agent via its managed media path
    // instead of failing the send — host-side media-understanding reads it from
    // the media-store root.
    await createReadyChatTranscript("openclaw-chat-send-managed-pdf-stage-throw-");
    useChatTestModel("vision-model");
    setSavedMediaResults(["/home/user/.openclaw/media/inbound/report.pdf", "application/pdf"]);
    mockState.sandboxWorkspace = { workspaceDir: "/sandbox/workspace" };
    mockState.stageSandboxMediaError = Object.assign(new Error("ENOSPC: no space left on device"), {
      code: "ENOSPC",
    });
    const { send } = createChatRequestFixture();
    // Small PDF (below the 5MB staging cap) so it takes the staging path, not the
    // oversized pass-through path.
    const pdf = Buffer.from("%PDF-1.4\n%µ¶\nendobj\n").toString("base64");

    await send({
      idempotencyKey: "idem-managed-pdf-stage-throw",
      message: "read this",
      requestParams: {
        attachments: [createFileAttachment("report.pdf", "application/pdf", pdf)],
      },
      expectBroadcast: false,
    });

    // Falls back to the absolute managed path; nothing staged (so no workspace
    // dir) and the media-store entry is preserved for host-side extraction.
    expect(mockState.lastDispatchCtx?.media).toEqual([
      {
        path: "/home/user/.openclaw/media/inbound/report.pdf",
        contentType: "application/pdf",
        workspaceDir: "/home/user/.openclaw/media/inbound",
      },
    ]);
    expect(mockState.deleteMediaBufferCalls).toEqual([]);
  });

  it("falls back to the managed path when sandbox staging silently skips an already-managed PDF", async () => {
    // #90097: stageSandboxMedia can silently skip a file (keeping its absolute
    // path) and return it absent from the staged map. An already-managed PDF in
    // that state falls back to its managed media path rather than failing the
    // send; the staged workspace dir is still carried for any files that landed.
    await createReadyChatTranscript("openclaw-chat-send-managed-pdf-stage-skip-");
    useChatTestModel("vision-model");
    setSavedMediaResults(["/home/user/.openclaw/media/inbound/report.pdf", "application/pdf"]);
    mockState.sandboxWorkspace = { workspaceDir: "/sandbox/workspace" };
    // No stagedRelativePaths → staged map is empty and the fact keeps the
    // absolute path, mirroring stageSandboxMedia silently skipping the file.
    const { send } = createChatRequestFixture();
    const pdf = Buffer.from("%PDF-1.4\n%µ¶\nendobj\n").toString("base64");

    await send({
      idempotencyKey: "idem-managed-pdf-stage-skip",
      message: "read this",
      requestParams: {
        attachments: [createFileAttachment("report.pdf", "application/pdf", pdf)],
      },
      expectBroadcast: false,
    });

    expect(mockState.lastDispatchCtx?.media).toEqual([
      {
        path: "/home/user/.openclaw/media/inbound/report.pdf",
        contentType: "application/pdf",
        workspaceDir: "/sandbox/workspace",
      },
    ]);
    expect(mockState.deleteMediaBufferCalls).toEqual([]);
  });

  it("still fails the send when staging skips a non-PDF in a mixed managed batch", async () => {
    // #90097: the PDF fallback is per-ref. A managed PDF that stages does not
    // rescue a sibling non-PDF that silently fell out of staging; that batch must
    // still surface a retryable 5xx and clean up every offloaded entry.
    await createReadyChatTranscript("openclaw-chat-send-mixed-stage-skip-");
    useChatTestModel("vision-model");
    setSavedMediaResults(
      ["/home/user/.openclaw/media/inbound/report.pdf", "application/pdf"],
      ["/home/user/.openclaw/media/inbound/data.bin", "application/octet-stream"],
    );
    mockState.sandboxWorkspace = { workspaceDir: "/sandbox/workspace" };
    mockState.stagedRelativePaths = ["media/inbound/report.pdf", "media/inbound/data.bin"];
    mockState.unstagedSources = ["/home/user/.openclaw/media/inbound/data.bin"];
    const { respond, send } = createChatRequestFixture();
    const pdf = Buffer.from("%PDF-1.4\n").toString("base64");
    const bin = Buffer.from("OPENCLAW-BINARY\n").toString("base64");

    await send({
      idempotencyKey: "idem-mixed-stage-skip",
      message: "read these",
      requestParams: {
        attachments: [
          createFileAttachment("report.pdf", "application/pdf", pdf),
          createFileAttachment("data.bin", "application/octet-stream", bin),
        ],
      },
      expectBroadcast: false,
      waitFor: "none",
    });

    expect(mockState.lastDispatchCtx).toBeUndefined();
    expect(respond).toHaveBeenCalledTimes(1);
    const [ok, payload, error] = lastRespondCall(respond) ?? [];
    expect(ok).toBe(false);
    expect(payload).toBeUndefined();
    expect(error?.code).toBe(ErrorCodes.UNAVAILABLE);
    expect(responseErrorMessage(error)).toMatch(/staging incomplete/i);
    // The whole batch is cleaned up — including the PDF that would have fallen
    // back on its own — because the non-PDF cannot be delivered.
    expect(mockState.deleteMediaBufferCalls.map((c) => c.id).toSorted()).toEqual([
      "saved-media",
      "saved-media",
    ]);
  });

  it("stages non-image attachments above the generic media-store limit", async () => {
    // Regression: Gateway used MEDIA_MAX_BYTES (5 MiB) as a pre-staging cap
    // even though stageSandboxMedia accepts files up to 50 MiB.
    await createReadyChatTranscript("openclaw-chat-send-sandbox-oversize-");
    useChatTestModel("vision-model");
    setSavedMediaResults([
      "/home/user/.openclaw/media/inbound/huge.bin",
      "application/octet-stream",
    ]);
    mockState.sandboxWorkspace = { workspaceDir: "/sandbox/workspace" };
    mockState.stagedRelativePaths = ["media/inbound/huge.bin"];
    const { send } = createChatRequestFixture();
    // 6 MiB buffer — above MEDIA_MAX_BYTES but below the default 20 MiB parser
    // cap and the canonical 50 MiB sandbox staging cap.
    const oversized = Buffer.alloc(6 * 1024 * 1024);
    oversized.set(Buffer.from("OPENCLAW-BINARY\n"), 0);
    const oversizedPayload = oversized.toString("base64");

    await send({
      idempotencyKey: "idem-sandbox-oversize",
      message: "read this",
      requestParams: {
        attachments: [
          createFileAttachment("huge.bin", "application/octet-stream", oversizedPayload),
        ],
      },
      expectBroadcast: false,
    });

    expect(mockState.lastDispatchCtx?.media).toEqual([
      {
        path: "media/inbound/huge.bin",
        contentType: "application/octet-stream",
        workspaceDir: "/sandbox/workspace",
      },
    ]);
    expect(mockState.deleteMediaBufferCalls).toEqual([]);
  });

  it("passes imageOrder for mixed inline and offloaded chat.send attachments", async () => {
    await createReadyChatTranscript("openclaw-chat-send-image-order-");
    useChatTestModel("vision-model", true);
    setSavedMediaResults(["/tmp/offloaded-big.png", "image/png"]);
    const { send } = createChatRequestFixture();
    const bigPng = createPngBuffer(2_100_000);

    await send({
      idempotencyKey: "idem-image-order",
      message: "describe both",
      requestParams: {
        attachments: [
          createImageAttachment({ content: OFFLOAD_PNG_BASE64 }),
          createImageAttachment({ content: bigPng.toString("base64") }),
        ],
      },
      expectBroadcast: false,
    });

    expect(mockState.lastDispatchImages).toHaveLength(1);
    expect(mockState.lastDispatchImageOrder).toEqual(["inline", "offloaded"]);
  });

  it("maps media offload failures to UNAVAILABLE in chat.send", async () => {
    await createTranscriptFixture("openclaw-chat-send-media-offload-error-");
    useChatTestModel("vision-model");
    mockState.saveMediaError = new Error("disk full");
    const { respond, send } = createChatRequestFixture();
    const bigPng = createPngBuffer(2_100_000);

    await send({
      idempotencyKey: "idem-media-offload-error",
      message: "describe image",
      requestParams: {
        attachments: [createImageAttachment({ content: bigPng.toString("base64") })],
      },
      waitFor: "none",
    });

    const response = lastRespondCall(respond);
    expect(response?.[0]).toBe(false);
    expect(response?.[1]).toBeUndefined();
    expect(response?.[2]?.code).toBe(ErrorCodes.UNAVAILABLE);
  });

  it("persists chat.send attachments one at a time", async () => {
    await createReadyChatTranscript("openclaw-chat-send-image-serial-save-");
    setSavedMediaResults(
      ["/tmp/chat-send-image-a.png", "image/png"],
      ["/tmp/chat-send-image-b.jpg", "image/jpeg"],
    );
    let releaseSave = () => {};
    mockState.saveMediaWait = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const { context, send } = createChatRequestFixture();

    await send({
      idempotencyKey: "idem-image-serial-save",
      message: "serial please",
      requestParams: {
        attachments: [
          createImageAttachment({ content: INLINE_PNG_BASE64 }),
          createImageAttachment({ content: TINY_JPEG_BASE64, mimeType: "image/jpeg" }),
        ],
      },
      expectBroadcast: false,
      waitForCompletion: false,
    });

    expect(mockState.activeSaveMediaCalls).toBe(1);
    expect(mockState.maxActiveSaveMediaCalls).toBe(1);
    expect(mockState.savedMediaCalls).toHaveLength(0);
    releaseSave();

    await waitForAssertion(() => {
      expect(mockState.maxActiveSaveMediaCalls).toBe(1);
      expect(mockState.savedMediaCalls).toHaveLength(2);
      expect(context.dedupe.has("chat:idem-image-serial-save")).toBe(true);
    });
  });

  it("does not parse or offload attachments for stop commands", async () => {
    await createTranscriptFixture("openclaw-chat-send-stop-command-attachments-");
    setSavedMediaResults(["/tmp/should-not-exist.png", "image/png"]);
    const { context, respond, send } = createChatRequestFixture();
    context.chatAbortControllers.set("run-same-session", {
      controller: new AbortController(),
      sessionId: "sess-prev",
      sessionKey: "main",
      startedAtMs: Date.now(),
      expiresAtMs: Date.now() + 10_000,
    });

    await send({
      idempotencyKey: "idem-stop-command-attachments",
      message: "/stop",
      requestParams: {
        attachments: [createImageAttachment({ content: OFFLOAD_PNG_BASE64 })],
      },
      expectBroadcast: false,
      waitFor: "none",
    });

    expect(mockState.savedMediaCalls).toStrictEqual([]);
    expect(mockState.lastDispatchImages).toBeUndefined();
    expect(respond).toHaveBeenCalledWith(true, {
      ok: true,
      aborted: true,
      runIds: ["run-same-session"],
    });
  });

  it("emits a user transcript update when chat.send completes without an agent run", async () => {
    await createGatewayUserTurnSqliteFixture("openclaw-chat-send-user-transcript-no-run-");
    mockState.finalText = "ok";
    const { send } = createChatRequestFixture();

    await send({
      idempotencyKey: "idem-user-transcript-no-run",
      message: "quick command",
      expectBroadcast: false,
    });

    const userUpdate = findUserUpdate();
    const message = userUpdateMessage(userUpdate);
    expectUserUpdateIdentity(userUpdate);
    expect(message?.role).toBe("user");
    expect(message?.content).toBe("quick command");
    expect(typeof message?.timestamp).toBe("number");
    const persistedUser = readPersistedUserMessages()[0];
    expect(persistedUser?.content).toBe("quick command");
    expect(
      (persistedUser?.["__openclaw"] as Record<string, unknown> | undefined)?.steerTargetRunId,
    ).toBeUndefined();
    expect(getTotalPendingReplies()).toBe(0);
  });

  it("persists a Gateway user turn under the durable owner when its loaded key is stale", async () => {
    createFixturePaths("openclaw-chat-send-stale-transcript-owner-");
    const canonicalSessionKey = "agent:main:canonical-transcript-owner";
    const staleSessionKey = "agent:main:stale-transcript-owner";
    await replaceSessionEntry(
      {
        agentId: "main",
        sessionKey: canonicalSessionKey,
        storePath: mockState.storePath,
      },
      { sessionId: mockState.sessionId, updatedAt: 1 },
    );
    mockState.finalText = "ok";
    const { send } = createChatRequestFixture();

    await send({
      idempotencyKey: "idem-stale-transcript-owner",
      message: "keep this Gateway turn",
      sessionKey: staleSessionKey,
      expectBroadcast: false,
    });

    const persistedEvents = loadTranscriptEventsSync({
      agentId: "main",
      sessionId: mockState.sessionId,
      sessionKey: canonicalSessionKey,
      storePath: mockState.storePath,
    });
    expect(persistedEvents).toContainEqual(
      expect.objectContaining({
        type: "message",
        message: expect.objectContaining({
          role: "user",
          content: "keep this Gateway turn",
        }),
      }),
    );
    expect(
      loadSqliteSessionEntry({
        agentId: "main",
        sessionKey: staleSessionKey,
        storePath: mockState.storePath,
      }),
    ).toBeUndefined();
    expect(findUserUpdate()?.target).toEqual({
      agentId: "main",
      sessionId: mockState.sessionId,
      sessionKey: staleSessionKey,
      storePath: mockState.storePath,
    });
  });

  it("emits a user transcript update when chat.send fails before an agent run starts", async () => {
    await createGatewayUserTurnSqliteFixture("openclaw-chat-send-user-transcript-error-no-run-");
    mockState.dispatchError = new Error("upstream unavailable");
    const { context, send } = createChatRequestFixture();

    await send({
      idempotencyKey: "idem-user-transcript-error-no-run",
      message: "hello from failed dispatch",
      expectBroadcast: false,
    });

    await waitForAssertion(() => {
      expect(context.dedupe.get("chat:idem-user-transcript-error-no-run")?.ok).toBe(false);
      const userUpdate = findUserUpdate();
      const message = userUpdateMessage(userUpdate);
      expectUserUpdateIdentity(userUpdate);
      expect(message?.role).toBe("user");
      expect(message?.content).toBe("hello from failed dispatch");
      expect(typeof message?.timestamp).toBe("number");
      const persistedUser = readPersistedUserMessages()[0];
      expect(persistedUser?.content).toBe("hello from failed dispatch");
    });
    expect(getTotalPendingReplies()).toBe(0);
  });

  it("emits a user transcript update when a slash-prefixed turn fails before command delivery", async () => {
    await createGatewayUserTurnSqliteFixture(
      "openclaw-chat-send-user-transcript-slash-error-no-run-",
    );
    mockState.dispatchError = new Error("slash command continued into unavailable runtime");
    const { context, send } = createChatRequestFixture();

    await send({
      idempotencyKey: "idem-user-transcript-slash-error-no-run",
      message: "/unknown keep this user turn",
      expectBroadcast: false,
    });

    await waitForAssertion(() => {
      expect(context.dedupe.get("chat:idem-user-transcript-slash-error-no-run")?.ok).toBe(false);
      const userUpdate = findUserUpdate();
      const message = userUpdateMessage(userUpdate);
      expectUserUpdateIdentity(userUpdate);
      expect(message?.role).toBe("user");
      expect(message?.content).toBe("/unknown keep this user turn");
      const persistedUser = readPersistedUserMessages()[0];
      expect(persistedUser?.content).toBe("/unknown keep this user turn");
    });
  });

  it("does not duplicate fallback user transcript rows when chat.send is replayed", async () => {
    await createGatewayUserTurnSqliteFixture("openclaw-chat-send-user-transcript-error-replay-");
    mockState.dispatchError = new Error("upstream unavailable");

    await runNonStreamingChatSend({
      context: createChatContext(),
      respond: vi.fn(),
      idempotencyKey: "idem-user-transcript-error-replay",
      message: "hello from replayed failed dispatch",
      expectBroadcast: false,
    });
    await runNonStreamingChatSend({
      context: createChatContext(),
      respond: vi.fn(),
      idempotencyKey: "idem-user-transcript-error-replay",
      message: "hello from replayed failed dispatch",
      expectBroadcast: false,
    });

    await waitForAssertion(() => {
      expect(readPersistedUserMessages()).toEqual([
        expect.objectContaining({
          role: "user",
          content: "hello from replayed failed dispatch",
          idempotencyKey: "idem-user-transcript-error-replay:user",
        }),
      ]);
      const userUpdates = mockState.emittedTranscriptUpdates.filter(
        (update) => userUpdateMessage(update)?.role === "user",
      );
      expect(userUpdates).toHaveLength(1);
    });
  });

  it("emits a user transcript update on pre-start failures even when before_agent_run hooks exist", async () => {
    await createGatewayUserTurnSqliteFixture(
      "openclaw-chat-send-user-transcript-error-hook-pre-start-",
    );
    mockState.hasBeforeAgentRunHooks = true;
    mockState.dispatchError = new Error("resolver unavailable");
    const { context, send } = createChatRequestFixture();

    await send({
      idempotencyKey: "idem-user-transcript-error-hook-pre-start",
      message: "hello before hooked startup failure",
      expectBroadcast: false,
    });

    await waitForAssertion(() => {
      expect(context.dedupe.get("chat:idem-user-transcript-error-hook-pre-start")?.ok).toBe(false);
      const userUpdate = findUserUpdate();
      const message = userUpdateMessage(userUpdate);
      expectUserUpdateIdentity(userUpdate);
      expect(message?.role).toBe("user");
      expect(message?.content).toBe("hello before hooked startup failure");
    });
  });

  it("emits a user transcript update when chat.send fails after agent start but before runtime persistence", async () => {
    await createGatewayUserTurnSqliteFixture(
      "openclaw-chat-send-user-transcript-error-before-runtime-persist-",
    );
    mockState.triggerAgentRunStart = true;
    mockState.dispatchErrorAfterAgentRunStart = new Error("cli backend unavailable");
    const { context, send } = createChatRequestFixture();

    await send({
      idempotencyKey: "idem-user-transcript-error-before-runtime-persist",
      message: "hello before cli startup failure",
      expectBroadcast: false,
    });

    await waitForAssertion(() => {
      expect(context.dedupe.get("chat:idem-user-transcript-error-before-runtime-persist")?.ok).toBe(
        false,
      );
      const userUpdate = findUserUpdate();
      const message = userUpdateMessage(userUpdate);
      expectUserUpdateIdentity(userUpdate);
      expect(message?.role).toBe("user");
      expect(message?.content).toBe("hello before cli startup failure");
      const persistedUser = readPersistedUserMessages()[0];
      expect(persistedUser?.content).toBe("hello before cli startup failure");
    });
  });

  it("applies before_message_write redaction to gateway fallback user transcript persistence", async () => {
    await createGatewayUserTurnSqliteFixture(
      "openclaw-chat-send-user-transcript-error-before-write-redact-",
    );
    mockState.triggerAgentRunStart = true;
    mockState.dispatchErrorAfterAgentRunStart = new Error("cli backend unavailable");
    mockState.beforeMessageWriteContent = "[redacted by hook]";
    const { send } = createChatRequestFixture();

    await send({
      idempotencyKey: "idem-user-transcript-error-before-write-redact",
      message: "raw sensitive prompt",
      expectBroadcast: false,
    });

    await waitForAssertion(() => {
      const userUpdate = findUserUpdate();
      expectUserUpdateIdentity(userUpdate);
      const message = userUpdateMessage(userUpdate);
      expect(message?.content).toBe("[redacted by hook]");
      expect(mockState.beforeMessageWriteCalls).toHaveLength(1);
      const persistedUser = readPersistedUserMessages()[0];
      expect(persistedUser?.content).toBe("[redacted by hook]");
      expect(JSON.stringify(persistedUser)).not.toContain("raw sensitive prompt");
    });
  });

  it("does not persist gateway fallback user transcripts blocked by before_message_write", async () => {
    await createGatewayUserTurnSqliteFixture(
      "openclaw-chat-send-user-transcript-error-before-write-block-",
    );
    mockState.triggerAgentRunStart = true;
    mockState.dispatchErrorAfterAgentRunStart = new Error("cli backend unavailable");
    mockState.beforeMessageWriteBlock = true;
    const { context, send } = createChatRequestFixture();

    await send({
      idempotencyKey: "idem-user-transcript-error-before-write-block",
      message: "blocked sensitive prompt",
      expectBroadcast: false,
    });

    await waitForAssertion(() => {
      expect(context.dedupe.get("chat:idem-user-transcript-error-before-write-block")?.ok).toBe(
        false,
      );
      expect(mockState.beforeMessageWriteCalls).toHaveLength(1);
    });
    expect(findUserUpdate()).toBeUndefined();
    expect(readPersistedUserMessages()).toHaveLength(0);
  });

  it("emits a user transcript update when a started agent returns an error before runtime persistence", async () => {
    await createGatewayUserTurnSqliteFixture(
      "openclaw-chat-send-user-transcript-agent-error-no-runtime-persist-",
    );
    mockState.triggerAgentRunStart = true;
    mockState.finalPayload = { text: "agent failed before prompt append", isError: true };
    const { context, send } = createChatRequestFixture();

    await send({
      idempotencyKey: "idem-user-transcript-agent-error-no-runtime-persist",
      message: "hello before agent error payload",
      expectBroadcast: false,
    });

    await waitForAssertion(() => {
      expect(
        context.dedupe.get("chat:idem-user-transcript-agent-error-no-runtime-persist")?.ok,
      ).toBe(false);
      const userUpdate = findUserUpdate();
      const message = userUpdateMessage(userUpdate);
      expectUserUpdateIdentity(userUpdate);
      expect(message?.role).toBe("user");
      expect(message?.content).toBe("hello before agent error payload");
    });
  });

  it("falls back to gateway user persistence when successful runtime persistence fails", async () => {
    await createGatewayUserTurnSqliteFixture(
      "openclaw-chat-send-user-transcript-success-runtime-persist-failed-",
    );
    mockState.triggerAgentRunStart = true;
    mockState.runtimeUserMessagePersistencePending = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("runtime prompt mirror failed")), 0);
    });
    mockState.finalPayload = { text: "agent still answered" };
    const { context, send } = createChatRequestFixture();

    await send({
      idempotencyKey: "idem-user-transcript-success-runtime-persist-failed",
      message: "hello before successful fallback",
      expectBroadcast: false,
    });

    await waitForAssertion(() => {
      expect(
        context.dedupe.get("chat:idem-user-transcript-success-runtime-persist-failed")?.ok,
      ).toBe(true);
      const userUpdate = findUserUpdate();
      expectUserUpdateIdentity(userUpdate);
      const message = userUpdateMessage(userUpdate);
      expect(message?.role).toBe("user");
      expect(message?.content).toBe("hello before successful fallback");
      expect(message?.idempotencyKey).toBe(
        "idem-user-transcript-success-runtime-persist-failed:user",
      );
    });
  });

  it("emits a user transcript update when hooks pass and a started agent returns an error", async () => {
    await createGatewayUserTurnSqliteFixture(
      "openclaw-chat-send-user-transcript-agent-error-hook-pass-",
    );
    mockState.triggerAgentRunStart = true;
    mockState.hasBeforeAgentRunHooks = true;
    mockState.finalPayload = { text: "agent failed before prompt append", isError: true };
    const { context, send } = createChatRequestFixture();

    await send({
      idempotencyKey: "idem-user-transcript-agent-error-hook-pass",
      message: "hello before hooked agent error payload",
      expectBroadcast: false,
    });

    await waitForAssertion(() => {
      expect(context.dedupe.get("chat:idem-user-transcript-agent-error-hook-pass")?.ok).toBe(false);
      const userUpdate = findUserUpdate();
      const message = userUpdateMessage(userUpdate);
      expectUserUpdateIdentity(userUpdate);
      expect(message?.role).toBe("user");
      expect(message?.content).toBe("hello before hooked agent error payload");
    });
  });
});

describe("chat.send local operator client sender context", () => {
  it.each([
    [GATEWAY_CLIENT_NAMES.CONTROL_UI, GATEWAY_CLIENT_MODES.WEBCHAT, "web"],
    [GATEWAY_CLIENT_NAMES.MACOS_APP, GATEWAY_CLIENT_MODES.UI, "darwin"],
    [GATEWAY_CLIENT_NAMES.CLI, GATEWAY_CLIENT_MODES.CLI, "darwin"],
  ] as const)(
    "binds lazy configured-MCP cron authority to an admitted local %s turn",
    async (clientId, mode, platform) => {
      await createGatewayUserTurnSqliteFixture(`openclaw-chat-send-cron-authority-${clientId}-`);
      const { send } = createChatRequestFixture();
      let retainedResolver: ReturnType<typeof bindActiveCronCreatorAuthorityResolver>;
      let resolvedGrant: { runId: string; token: string } | undefined;
      mockState.cronAuthorityProbe = async (runId, capability) => {
        await new Promise<void>((resolveTick) => {
          setTimeout(resolveTick, 0);
        });
        const resolve = async () =>
          ({
            tools: ["read", { name: "configured__lookup", pluginId: "bundle-mcp" }],
            provenance: { version: 1, source: "final-executable-surface" },
          }) as const;
        runWithCronCreatorAuthorityCapabilityResolver({
          capability,
          runId: "other-run",
          resolve,
          run: () => {
            expect(bindActiveCronCreatorAuthorityResolver(runId)).toBeUndefined();
          },
        });
        await runWithCronCreatorAuthorityCapabilityResolver({
          capability,
          runId,
          resolve,
          run: async () => {
            retainedResolver = bindActiveCronCreatorAuthorityResolver(runId);
            const snapshot = await retainedResolver!();
            resolvedGrant = snapshot.grant;
            expect(snapshot.tools).toEqual([
              "read",
              { name: "configured__lookup", pluginId: "bundle-mcp" },
            ]);
          },
        });
      };

      await send({
        idempotencyKey: `idem-cron-authority-${clientId}`,
        client: {
          connect: {
            client: { id: clientId, mode, version: "dev", platform },
            scopes: ["operator.admin"],
          },
          internal: { isLocalClient: true },
        },
        expectBroadcast: false,
      });

      expect(resolvedGrant).toMatchObject({ runId: `idem-cron-authority-${clientId}` });
      await expect(retainedResolver!()).rejects.toThrow(
        "Configured MCP cron authority is no longer active",
      );
      expect(() => consumeCronCreatorAuthorityGrant(resolvedGrant!)).toThrow(
        "Configured MCP cron authority is no longer active",
      );
    },
  );

  it("denies otherwise-eligible internal chat.send re-entry, including Talk consults", async () => {
    await createGatewayUserTurnSqliteFixture("openclaw-chat-send-cron-authority-internal-reentry-");
    let boundResolver: ReturnType<typeof bindActiveCronCreatorAuthorityResolver>;
    mockState.cronAuthorityProbe = async (runId, capability) => {
      runWithCronCreatorAuthorityCapabilityResolver({
        capability,
        runId,
        resolve: async () => ({
          tools: ["read", "configured__lookup"],
          provenance: { version: 1, source: "final-executable-surface" },
        }),
        run: () => {
          boundResolver = bindActiveCronCreatorAuthorityResolver(runId);
        },
      });
    };
    const { send } = createChatRequestFixture();

    await send({
      idempotencyKey: "idem-cron-authority-internal-reentry",
      message: "Talk realtime agent consult prompt",
      directExternal: false,
      client: {
        connect: {
          client: {
            id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
            mode: GATEWAY_CLIENT_MODES.WEBCHAT,
            version: "dev",
            platform: "web",
          },
          scopes: ["operator.admin"],
        },
        internal: { isLocalClient: true },
      },
      expectBroadcast: false,
    });

    expect(boundResolver!).toBeUndefined();
  });

  it.each([
    {
      name: "remote client",
      client: { internal: {}, scopes: ["operator.admin"] },
    },
    {
      name: "non-admin client",
      client: { internal: { isLocalClient: true }, scopes: ["operator.write"] },
    },
    {
      name: "incognito session",
      client: { internal: { isLocalClient: true }, scopes: ["operator.admin"] },
      sessionEntry: { incognito: true },
    },
    {
      name: "synthetic client",
      client: {
        internal: { isLocalClient: true, syntheticClient: true },
        scopes: ["operator.admin"],
      },
    },
    {
      name: "input provenance",
      client: { internal: { isLocalClient: true }, scopes: ["operator.admin"] },
      requestParams: { systemInputProvenance: { kind: "external_user" } },
    },
    {
      name: "explicit origin",
      client: { internal: { isLocalClient: true }, scopes: ["operator.admin"] },
      requestParams: { originatingChannel: "slack", originatingTo: "D123" },
    },
    {
      name: "delegated handoff",
      client: {
        internal: { isLocalClient: true, delegatedToolPolicyHandoffId: "handoff-1" },
        scopes: ["operator.admin"],
      },
    },
    {
      name: "spawned lineage",
      client: { internal: { isLocalClient: true }, scopes: ["operator.admin"] },
      sessionEntry: { spawnedBy: "agent:main:parent" },
    },
    {
      name: "synthetic cron continuation",
      client: {
        internal: { isLocalClient: true, cronRunContinuation: true },
        scopes: ["operator.admin"],
      },
    },
    {
      name: "persisted cron continuation",
      client: { internal: { isLocalClient: true }, scopes: ["operator.admin"] },
      sessionEntry: {
        cronRunContinuation: { lifecycleRevision: "revision-1", phase: "running" },
      },
    },
  ])("does not mint configured-MCP cron authority for $name", async (testCase) => {
    await createGatewayUserTurnSqliteFixture("openclaw-chat-send-cron-authority-negative-");
    mockState.sessionEntry = testCase.sessionEntry ?? {};
    let boundResolver: ReturnType<typeof bindActiveCronCreatorAuthorityResolver>;
    mockState.cronAuthorityProbe = async (runId, capability) => {
      runWithCronCreatorAuthorityCapabilityResolver({
        capability,
        runId,
        resolve: async () => ({
          tools: ["read"],
          provenance: { version: 1, source: "final-executable-surface" },
        }),
        run: () => {
          boundResolver = bindActiveCronCreatorAuthorityResolver(runId);
        },
      });
    };
    const { send } = createChatRequestFixture();

    await send({
      idempotencyKey: `idem-cron-authority-negative-${testCase.name.replaceAll(" ", "-")}`,
      client: {
        connect: {
          client: {
            id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
            mode: GATEWAY_CLIENT_MODES.WEBCHAT,
            version: "dev",
            platform: "web",
          },
          scopes: testCase.client.scopes,
        },
        internal: testCase.client.internal,
      },
      requestParams: testCase.requestParams,
      expectBroadcast: false,
    });

    expect(boundResolver!).toBeUndefined();
  });

  it("does not inject sender identity fields for Control UI clients", async () => {
    await createGatewayUserTurnSqliteFixture("openclaw-chat-send-control-ui-sender-");
    const { send } = createChatRequestFixture();

    await send({
      idempotencyKey: "idem-control-ui-sender",
      message: "hello from control ui",
      client: {
        connect: {
          client: {
            id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
            mode: GATEWAY_CLIENT_MODES.WEBCHAT,
            version: "dev",
            platform: "web",
          },
          caps: [GATEWAY_CLIENT_CAPS.TASK_SUGGESTIONS],
          scopes: ["operator.admin"],
        },
      },
      expectBroadcast: false,
    });

    expect(mockState.lastDispatchCtx?.SenderId).toBeUndefined();
    expect(mockState.lastDispatchCtx?.SenderName).toBeUndefined();
    expect(mockState.lastDispatchCtx?.SenderUsername).toBeUndefined();
    expect(mockState.lastTaskSuggestionDeliveryMode).toBe("gateway");
  });

  it.each([
    {
      name: "enables task suggestions for TUI clients",
      id: "tui",
      message: "hello from tui",
      clientId: GATEWAY_CLIENT_NAMES.TUI,
      mode: GATEWAY_CLIENT_MODES.UI,
      platform: "terminal",
      scopes: ["operator.admin"],
      caps: [GATEWAY_CLIENT_CAPS.TASK_SUGGESTIONS],
      expected: "gateway",
    },
    {
      name: "withholds task suggestions from operator UI clients that cannot accept them",
      id: "write-only-tui",
      message: "hello from a write-only tui",
      clientId: GATEWAY_CLIENT_NAMES.TUI,
      mode: GATEWAY_CLIENT_MODES.UI,
      platform: "terminal",
      scopes: ["operator.write"],
      caps: [GATEWAY_CLIENT_CAPS.TASK_SUGGESTIONS],
      expected: undefined,
    },
    {
      name: "withholds task suggestions from non-operator gateway clients",
      id: "channel",
      message: "hello from a channel bridge",
      clientId: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      mode: GATEWAY_CLIENT_MODES.BACKEND,
      platform: "server",
      scopes: ["operator.write"],
      caps: [GATEWAY_CLIENT_CAPS.TASK_SUGGESTIONS],
      expected: undefined,
    },
    {
      name: "withholds task suggestions from operator UI clients without action support",
      id: "old-tui",
      message: "hello from an older tui",
      clientId: GATEWAY_CLIENT_NAMES.TUI,
      mode: GATEWAY_CLIENT_MODES.UI,
      platform: "terminal",
      scopes: ["operator.write"],
      expected: undefined,
    },
  ])("$name", async ({ id, message, clientId, mode, platform, scopes, caps, expected }) => {
    const { send } = createChatRequestFixture();
    await send({
      idempotencyKey: `idem-${id}-task-suggestions`,
      message,
      client: {
        connect: {
          client: { id: clientId, mode, version: id === "old-tui" ? "old" : "dev", platform },
          ...(caps ? { caps } : {}),
          scopes,
        },
      },
      expectBroadcast: false,
    });
    expect(mockState.lastTaskSuggestionDeliveryMode).toBe(expected);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
