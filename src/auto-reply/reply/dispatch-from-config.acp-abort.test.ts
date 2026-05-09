import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type {
  AcpRuntime,
  AcpRuntimeEnsureInput,
  AcpRuntimeEvent,
  AcpRuntimeHandle,
  AcpRuntimeTurnInput,
} from "../../plugin-sdk/acp-runtime.js";
import { createInternalHookEventPayload } from "../../test-utils/internal-hook-event-payload.js";
import {
  acpManagerRuntimeMocks,
  acpMocks,
  agentEventMocks,
  createDispatcher,
  diagnosticMocks,
  hookMocks,
  internalHookMocks,
  mocks,
  noAbortResult,
  resetPluginTtsAndThreadMocks,
  sessionBindingMocks,
  sessionStoreMocks,
  setDiscordTestRegistry,
} from "./dispatch-from-config.shared.test-harness.js";
import { buildTestCtx } from "./test-ctx.js";

let dispatchReplyFromConfig: typeof import("./dispatch-from-config.js").dispatchReplyFromConfig;
let tryDispatchAcpReplyHook: typeof import("../../plugin-sdk/acp-runtime.js").tryDispatchAcpReplyHook;
let resetInboundDedupe: typeof import("./inbound-dedupe.js").resetInboundDedupe;

function shouldUseAcpReplyDispatchHook(eventUnknown: unknown): boolean {
  const event = eventUnknown as {
    sessionKey?: string;
    ctx?: {
      SessionKey?: string;
      CommandTargetSessionKey?: string;
      AcpDispatchTailAfterReset?: boolean;
    };
  };
  if (event.ctx?.AcpDispatchTailAfterReset) {
    return true;
  }
  return [event.sessionKey, event.ctx?.SessionKey, event.ctx?.CommandTargetSessionKey].some(
    (value) => {
      const key = value?.trim();
      return Boolean(key && (key.includes("acp:") || key.includes(":acp") || key.includes("-acp")));
    },
  );
}

function setNoAbort() {
  mocks.tryFastAbortFromMessage.mockResolvedValue(noAbortResult);
}

async function raceWithTimeoutResult<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutResult: T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(timeoutResult), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function createMockAcpSessionManager() {
  return {
    resolveSession: (params: { cfg: OpenClawConfig; sessionKey: string }) => {
      const entry = acpMocks.readAcpSessionEntry({
        cfg: params.cfg,
        sessionKey: params.sessionKey,
      }) as { acp?: Record<string, unknown> } | null;
      if (entry?.acp) {
        return {
          kind: "ready" as const,
          sessionKey: params.sessionKey,
          meta: entry.acp,
        };
      }
      return { kind: "none" as const, sessionKey: params.sessionKey };
    },
    getObservabilitySnapshot: () => ({
      runtimeCache: { activeSessions: 0, idleTtlMs: 0, evictedTotal: 0 },
      turns: {
        active: 0,
        queueDepth: 0,
        completed: 0,
        failed: 0,
        averageLatencyMs: 0,
        maxLatencyMs: 0,
      },
      errorsByCode: {},
    }),
    runTurn: vi.fn(
      async (params: {
        cfg: OpenClawConfig;
        sessionKey: string;
        text?: string;
        attachments?: unknown[];
        mode: string;
        requestId: string;
        signal?: AbortSignal;
        onEvent: (event: Record<string, unknown>) => Promise<void>;
      }) => {
        const entry = acpMocks.readAcpSessionEntry({
          cfg: params.cfg,
          sessionKey: params.sessionKey,
        }) as {
          acp?: { agent?: string; mode?: string };
        } | null;
        const runtimeBackend = acpMocks.requireAcpRuntimeBackend() as {
          runtime?: AcpRuntime;
        };
        if (!runtimeBackend.runtime) {
          throw new Error("ACP runtime backend not mocked");
        }
        const handle = await runtimeBackend.runtime.ensureSession({
          sessionKey: params.sessionKey,
          mode: (entry?.acp?.mode || "persistent") as AcpRuntimeEnsureInput["mode"],
          agent: entry?.acp?.agent || "codex",
        });
        const stream = runtimeBackend.runtime.runTurn({
          handle,
          text: params.text ?? "",
          attachments: params.attachments as AcpRuntimeTurnInput["attachments"],
          mode: params.mode as AcpRuntimeTurnInput["mode"],
          requestId: params.requestId,
          signal: params.signal,
        });
        for await (const event of stream) {
          await params.onEvent(event);
        }
      },
    ),
  };
}

describe("dispatchReplyFromConfig ACP abort", () => {
  beforeAll(async () => {
    ({ dispatchReplyFromConfig } = await import("./dispatch-from-config.js"));
    ({ tryDispatchAcpReplyHook } = await import("../../plugin-sdk/acp-runtime.js"));
    ({ resetInboundDedupe } = await import("./inbound-dedupe.js"));
  });

  beforeEach(() => {
    setDiscordTestRegistry();
    resetInboundDedupe();
    acpManagerRuntimeMocks.getAcpSessionManager.mockReset();
    acpManagerRuntimeMocks.getAcpSessionManager.mockReturnValue(createMockAcpSessionManager());
    hookMocks.runner.hasHooks.mockReset();
    hookMocks.runner.hasHooks.mockImplementation(
      (hookName?: string) => hookName === "reply_dispatch",
    );
    hookMocks.runner.runBeforeDispatch.mockReset();
    hookMocks.runner.runBeforeDispatch.mockResolvedValue(undefined);
    hookMocks.runner.runReplyDispatch.mockReset();
    hookMocks.runner.runReplyDispatch.mockImplementation(async (event: unknown, ctx: unknown) => {
      if (!shouldUseAcpReplyDispatchHook(event)) {
        return undefined;
      }
      return (await tryDispatchAcpReplyHook(event as never, ctx as never)) ?? undefined;
    });
    hookMocks.runner.runInboundClaim.mockReset();
    hookMocks.runner.runInboundClaim.mockResolvedValue(undefined);
    hookMocks.runner.runInboundClaimForPlugin.mockReset();
    hookMocks.runner.runInboundClaimForPlugin.mockResolvedValue(undefined);
    hookMocks.runner.runInboundClaimForPluginOutcome.mockReset();
    hookMocks.runner.runInboundClaimForPluginOutcome.mockResolvedValue({
      status: "no_handler",
    });
    hookMocks.runner.runMessageReceived.mockReset();
    internalHookMocks.createInternalHookEvent.mockReset();
    internalHookMocks.createInternalHookEvent.mockImplementation(createInternalHookEventPayload);
    internalHookMocks.triggerInternalHook.mockReset();
    sessionStoreMocks.currentEntry = undefined;
    sessionStoreMocks.loadSessionStore.mockReset().mockReturnValue({});
    sessionStoreMocks.resolveStorePath.mockReset().mockReturnValue("/tmp/mock-sessions.json");
    sessionStoreMocks.resolveSessionStoreEntry.mockReset().mockReturnValue({ existing: undefined });
    acpMocks.listAcpSessionEntries.mockReset().mockResolvedValue([]);
    acpMocks.readAcpSessionEntry.mockReset().mockReturnValue(null);
    acpMocks.upsertAcpSessionMeta.mockReset().mockResolvedValue(null);
    acpMocks.getAcpRuntimeBackend.mockReset();
    acpMocks.requireAcpRuntimeBackend.mockReset();
    sessionBindingMocks.listBySession.mockReset().mockReturnValue([]);
    sessionBindingMocks.resolveByConversation.mockReset().mockReturnValue(null);
    sessionBindingMocks.touch.mockReset();
    resetPluginTtsAndThreadMocks();
    diagnosticMocks.logMessageQueued.mockReset();
    diagnosticMocks.logMessageProcessed.mockReset();
    diagnosticMocks.logSessionStateChange.mockReset();
    diagnosticMocks.markDiagnosticSessionProgress.mockReset();
    agentEventMocks.emitAgentEvent.mockReset();
    agentEventMocks.onAgentEvent.mockReset().mockImplementation(() => () => {});
    setNoAbort();
  });

  it("aborts ACP dispatch promptly when the caller abort signal fires", async () => {
    let releaseTurn: (() => void) | undefined;
    const releasePromise = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const runtime = {
      ensureSession: vi.fn(
        async (input: { sessionKey: string; mode: string; agent: string }) =>
          ({
            sessionKey: input.sessionKey,
            backend: "acpx",
            runtimeSessionName: `${input.sessionKey}:${input.mode}`,
          }) as AcpRuntimeHandle,
      ),
      runTurn: vi.fn(async function* (params: { signal?: AbortSignal }) {
        await new Promise<void>((resolve) => {
          if (params.signal?.aborted) {
            resolve();
            return;
          }
          const onAbort = () => resolve();
          params.signal?.addEventListener("abort", onAbort, { once: true });
          void releasePromise.then(resolve);
        });
        yield { type: "done" } as AcpRuntimeEvent;
      }),
      cancel: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    } satisfies AcpRuntime;
    acpMocks.readAcpSessionEntry.mockReturnValue({
      sessionKey: "agent:codex-acp:session-1",
      storeSessionKey: "agent:codex-acp:session-1",
      cfg: {},
      storePath: "/tmp/mock-sessions.json",
      entry: {},
      acp: {
        backend: "acpx",
        agent: "codex",
        runtimeSessionName: "runtime:1",
        mode: "persistent",
        state: "idle",
        lastActivityAt: Date.now(),
      },
    });
    acpMocks.requireAcpRuntimeBackend.mockReturnValue({
      id: "acpx",
      runtime,
    });

    const abortController = new AbortController();
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      SessionKey: "agent:codex-acp:session-1",
      BodyForAgent: "write a test",
    });
    const dispatchPromise = dispatchReplyFromConfig({
      ctx,
      cfg: {
        acp: {
          enabled: true,
          dispatch: { enabled: true },
        },
        session: {
          sendPolicy: { default: "allow" },
        },
      } as OpenClawConfig,
      dispatcher,
      replyOptions: { abortSignal: abortController.signal },
    });

    await vi.waitFor(() => {
      expect(runtime.runTurn).toHaveBeenCalledTimes(1);
    });
    abortController.abort();
    const outcome = await raceWithTimeoutResult(
      dispatchPromise.then(() => "settled" as const),
      100,
      "pending" as const,
    );
    releaseTurn?.();
    await dispatchPromise;

    expect(outcome).toBe("settled");
  });
});
