import type { CopilotClient } from "@github/copilot-sdk";
import type {
  AgentHarness,
  AgentHarnessAttemptParams,
  AgentHarnessAttemptResult,
  AgentHarnessCompactParams,
  AgentHarnessCompactResult,
  AgentHarnessResetParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { resolveCopilotAuth } from "./src/auth-bridge.js";
import { writeOpenClawCompactionMarker } from "./src/compaction-bridge.js";
import type { CopilotClientPool, CopilotClientPoolOptions, PooledClient } from "./src/runtime.js";

export type { CopilotClientPool, CopilotClientPoolOptions };

const COPILOT_PROVIDER_IDS: ReadonlySet<string> = new Set(["github-copilot"]);

export interface CreateCopilotAgentHarnessOptions {
  id?: string;
  label?: string;
  pluginConfig?: unknown;
  pool?: CopilotClientPool;
  poolOptions?: CopilotClientPoolOptions;
  sessionStore?: CopilotSessionBindingStore;
}

interface TrackedSession {
  sdkSessionId: string;
  client: CopilotClient;
  // Compatibility fingerprint of the params that created the SDK
  // session. We only reuse the tracked SDK session when the next
  // attempt's fingerprint matches — different provider/model/cwd/auth
  // configurations should start a fresh SDK session rather than resume
  // one bound to incompatible state. Mismatch falls back to
  // `createSession` (no resume injection) and the new sdkSessionId
  // replaces this entry via `onSessionEstablished`.
  compatKey: string;
}

export type CopilotSessionBinding = {
  schemaVersion: 1;
  sdkSessionId: string;
  compatKey: string;
  updatedAt: number;
};

type CopilotSessionBindingStore = Pick<
  PluginStateSyncKeyedStore<CopilotSessionBinding>,
  "delete" | "lookup" | "register"
>;

function normalizeBinding(
  value: CopilotSessionBinding | undefined,
): CopilotSessionBinding | undefined {
  if (
    !value ||
    value.schemaVersion !== 1 ||
    typeof value.sdkSessionId !== "string" ||
    value.sdkSessionId.trim() === "" ||
    typeof value.compatKey !== "string" ||
    value.compatKey.trim() === "" ||
    typeof value.updatedAt !== "number" ||
    !Number.isFinite(value.updatedAt)
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    sdkSessionId: value.sdkSessionId.trim(),
    compatKey: value.compatKey,
    updatedAt: value.updatedAt,
  };
}

function lookupStoredBinding(
  store: CopilotSessionBindingStore | undefined,
  key: string,
): CopilotSessionBinding | undefined {
  try {
    return normalizeBinding(store?.lookup(key));
  } catch {
    try {
      store?.delete(key);
    } catch {
      // Durable binding cleanup is best-effort; the turn can create a fresh SDK session.
    }
    return undefined;
  }
}

function registerStoredBinding(
  store: CopilotSessionBindingStore | undefined,
  key: string,
  binding: CopilotSessionBinding,
): boolean {
  try {
    store?.register(key, binding);
    return true;
  } catch {
    try {
      store?.delete(key);
    } catch {
      // A failed invalidation just degrades to in-memory reuse for this process.
    }
    // The in-memory binding still keeps this process warm; persistence is an optimization.
    return false;
  }
}

function deleteStoredBinding(store: CopilotSessionBindingStore | undefined, key: string): boolean {
  try {
    store?.delete(key);
    return true;
  } catch {
    // Reset must still clear tracked SDK sessions even if plugin state is unhealthy.
    return false;
  }
}

// Build a string fingerprint of the attempt params that must agree
// across turns for SDK-session reuse to be safe. Keep this list
// conservative: any field whose change would invalidate the SDK
// session's bound state belongs here. Token / auth profile rotation
// produces a new fingerprint so we don't replay a session against a
// stale credential.
//
// Auth identity is derived from `resolveCopilotAuth(...)` — the same
// function `resolvePoolAcquire` uses to build the pool key. That
// ensures the compat key tracks the EFFECTIVE auth (which can come
// from the legacy `auth.*` subobject, the contract-resolved
// top-level `resolvedApiKey` + `authProfileId`, or the env-var
// fallback) rather than any single one of those raw inputs. The
// `authProfileVersion` field is a non-secret sha256 fingerprint of
// the token (see `tokenFingerprint` in `src/auth-bridge.ts`), so
// rotating the token under the same profile id still invalidates
// the compat key without ever serializing the raw credential.
function computeSessionCompatKey(params: AgentHarnessAttemptParams): string {
  const p = params as AgentHarnessAttemptParams & {
    auth?: {
      gitHubToken?: string;
      profileId?: string;
      profileVersion?: string;
      useLoggedInUser?: boolean;
    };
    agentId?: string;
    authProfileId?: string;
    copilotHome?: string;
    cwd?: string;
    model?: string | { api?: string; id?: string; provider?: string };
    profileVersion?: string;
    resolvedApiKey?: string;
    workspaceDir?: string;
  };
  const modelObj: { api?: string; id?: string; provider?: string } =
    p.model && typeof p.model === "object"
      ? p.model
      : { id: typeof p.model === "string" ? p.model : undefined };
  // resolveCopilotAuth can throw when an explicit `auth.gitHubToken`
  // is supplied without profileId + profileVersion (the existing
  // pool-key safety invariant). That same error would surface
  // immediately afterwards from `resolvePoolAcquire` inside
  // `runCopilotAttempt`, so we don't want to mask it here — but
  // we also can't include random / time-based data in the compat key
  // (would break the deterministic equality check). Use a stable
  // sentinel that will never match any previously-tracked compat key.
  let authParts: string[];
  let resolvedAgentId = "";
  let resolvedCopilotHome = "";
  try {
    const resolved = resolveCopilotAuth({
      agentId: typeof p.agentId === "string" ? p.agentId : undefined,
      agentDir: typeof p.agentDir === "string" ? p.agentDir : undefined,
      workspaceDir: typeof p.workspaceDir === "string" ? p.workspaceDir : undefined,
      copilotHome: typeof p.copilotHome === "string" ? p.copilotHome : undefined,
      auth: p.auth,
      resolvedApiKey: typeof p.resolvedApiKey === "string" ? p.resolvedApiKey : undefined,
      authProfileId: typeof p.authProfileId === "string" ? p.authProfileId : undefined,
      profileVersion: typeof p.profileVersion === "string" ? p.profileVersion : undefined,
    });
    resolvedAgentId = resolved.agentId;
    resolvedCopilotHome = resolved.copilotHome;
    authParts = [
      `auth.mode=${resolved.authMode}`,
      `auth.profileId=${resolved.authProfileId ?? ""}`,
      `auth.profileVersion=${resolved.authProfileVersion ?? ""}`,
    ];
  } catch {
    authParts = ["auth=unresolvable"];
  }
  const parts = [
    `provider=${modelObj.provider ?? ""}`,
    `model=${modelObj.id ?? ""}`,
    `api=${modelObj.api ?? ""}`,
    `cwd=${p.cwd ?? p.workspaceDir ?? ""}`,
    `agentId=${resolvedAgentId}`,
    `agentDir=${p.agentDir ?? ""}`,
    `copilotHome=${p.copilotHome ?? ""}`,
    `resolvedCopilotHome=${resolvedCopilotHome}`,
    ...authParts,
  ];
  return parts.join("|");
}

export function createCopilotAgentHarness(
  options?: CreateCopilotAgentHarnessOptions,
): AgentHarness {
  let poolPromise: Promise<CopilotClientPool> | undefined;
  let createdPool: CopilotClientPool | undefined;
  let disposed = false;
  let disposePromise: Promise<void> | undefined;
  const inFlight = new Set<Promise<unknown>>();
  // Maps OpenClaw session id (from AgentHarnessAttemptParams.sessionId) to
  // the SDK session id + client that owns it. Populated by
  // runCopilotAttempt via the onSessionEstablished callback so that
  // reset(params) can call client.deleteSession on the right client.
  const trackedSessions = new Map<string, TrackedSession>();
  const resetBlockedStoredSessions = new Set<string>();

  async function getPool(): Promise<CopilotClientPool> {
    if (options?.pool) {
      return options.pool;
    }
    if (!poolPromise) {
      poolPromise = (async () => {
        const { createCopilotClientPool } = await import("./src/runtime.js");
        createdPool = createCopilotClientPool(options?.poolOptions);
        return createdPool;
      })();
    }
    return poolPromise;
  }

  return {
    id: options?.id ?? "copilot",
    label: options?.label ?? "GitHub Copilot agent runtime",

    supports(ctx) {
      const requestedRuntime = String(ctx.requestedRuntime ?? "")
        .trim()
        .toLowerCase();
      if (requestedRuntime !== "copilot") {
        return { supported: false, reason: "copilot is opt-in only" };
      }
      const provider = ctx.provider.trim().toLowerCase();
      if (!COPILOT_PROVIDER_IDS.has(provider)) {
        return {
          supported: false,
          reason: `provider is not one of: ${[...COPILOT_PROVIDER_IDS].toSorted().join(", ")}`,
        };
      }
      return { supported: true, priority: 100 };
    },

    async runAttempt(params: AgentHarnessAttemptParams): Promise<AgentHarnessAttemptResult> {
      const attemptPromise = (async () => {
        if (disposed) {
          throw new Error("[copilot] harness has been disposed; cannot start new attempts");
        }
        const { runCopilotAttempt } = await import("./src/attempt.js");
        if (disposed) {
          throw new Error("[copilot] harness was disposed while starting an attempt");
        }
        const pool = await getPool();
        if (disposed) {
          throw new Error("[copilot] harness was disposed while starting an attempt");
        }
        const openclawSessionId =
          typeof params.sessionId === "string" ? params.sessionId : undefined;

        // Dogfood finding #4: reuse the SDK session across turns within
        // the same OpenClaw session so that the GitHub Copilot agent runtime's prompt
        // cache, tool-call history, and any server-side compaction state
        // survive turn boundaries. Without this, every turn called
        // `createSession()` and lost cache + thread continuity — the
        // smoking gun was distinct `${sdkSessionId}` scopes per turn in
        // the playground transcript.
        //
        // Safety:
        //   - Only inject when the tracked compatKey still matches the
        //     current attempt's fingerprint (provider/model/cwd/auth).
        //     Mismatch falls through to `createSession` and the new SDK
        //     session replaces the tracked entry below.
        //   - Preserve any caller-provided `replayInvalid: true` — never
        //     downgrade an orchestrator-issued safety signal to false.
        //     `decideReplayAction` treats undefined as resumable already.
        //   - On resume failure, `attempt.ts` recovers via the
        //     `replay-shim` (`resumeFailureRecovered:true`) and falls
        //     back to `createSession`, so a stale-session error never
        //     surfaces as a prompt error.
        const currentCompatKey = computeSessionCompatKey(params);
        const tracked = openclawSessionId ? trackedSessions.get(openclawSessionId) : undefined;
        const stored = openclawSessionId
          ? resetBlockedStoredSessions.has(openclawSessionId)
            ? undefined
            : lookupStoredBinding(options?.sessionStore, openclawSessionId)
          : undefined;
        const resumableSessionId =
          tracked && tracked.compatKey === currentCompatKey
            ? tracked.sdkSessionId
            : !tracked && stored && stored.compatKey === currentCompatKey
              ? stored.sdkSessionId
              : undefined;
        const effectiveParams: AgentHarnessAttemptParams = resumableSessionId
          ? ({
              ...params,
              initialReplayState: {
                ...params.initialReplayState,
                sdkSessionId: resumableSessionId,
              },
            } as AgentHarnessAttemptParams)
          : params;

        return runCopilotAttempt(effectiveParams, {
          pool,
          onSessionEstablished: openclawSessionId
            ? ({
                sdkSessionId,
                pooledClient,
              }: {
                sdkSessionId: string;
                pooledClient: PooledClient;
              }) => {
                trackedSessions.set(openclawSessionId, {
                  sdkSessionId,
                  client: pooledClient.client,
                  compatKey: currentCompatKey,
                });
                const persisted = registerStoredBinding(options?.sessionStore, openclawSessionId, {
                  schemaVersion: 1,
                  sdkSessionId,
                  compatKey: currentCompatKey,
                  updatedAt: Date.now(),
                });
                if (persisted) {
                  resetBlockedStoredSessions.delete(openclawSessionId);
                }
              }
            : undefined,
        });
      })();
      inFlight.add(attemptPromise);
      try {
        return await attemptPromise;
      } finally {
        inFlight.delete(attemptPromise);
      }
    },

    async reset(params: AgentHarnessResetParams): Promise<void> {
      const openclawSessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
      if (!openclawSessionId) {
        return;
      }
      const tracked = trackedSessions.get(openclawSessionId);
      if (deleteStoredBinding(options?.sessionStore, openclawSessionId)) {
        resetBlockedStoredSessions.delete(openclawSessionId);
      } else {
        resetBlockedStoredSessions.add(openclawSessionId);
      }
      if (!tracked) {
        // Session was created by a different harness, or already reset.
        return;
      }
      trackedSessions.delete(openclawSessionId);
      try {
        await tracked.client.deleteSession(tracked.sdkSessionId);
      } catch {
        // Best-effort: client may be stopped, session may not exist
        // server-side, or the SDK may report a transient error. The
        // registry already logs broadcast reset failures; swallow here
        // so one harness cannot block the reset broadcast.
      }
    },

    async compact(
      params: AgentHarnessCompactParams,
    ): Promise<AgentHarnessCompactResult | undefined> {
      // The GitHub Copilot agent runtime manages compaction automatically via
      // `SessionConfig.infiniteSessions` (background-async when
      // utilization crosses `backgroundCompactionThreshold`). There is
      // no synchronous compact RPC, so the harness cannot honour
      // `params.force === true` directly. Instead this method writes
      // an OpenClaw-shaped marker file under
      // `<workspaceDir>/files/openclaw-compaction-<ts>-<sessionId>.json`
      // so existing OpenClaw transcript readers see a familiar
      // compaction artifact when the host calls compact(). See
      // src/compaction-bridge.ts for the bridge boundary.
      const openclawSessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
      const workspaceDir =
        typeof params.workspaceDir === "string" ? params.workspaceDir : undefined;
      if (!openclawSessionId || !workspaceDir) {
        return {
          ok: false,
          compacted: false,
          reason: "missing-required-params",
        };
      }
      const tracked = trackedSessions.get(openclawSessionId);
      const reason = params.force
        ? "force-requested-but-sdk-has-no-synchronous-compact-api"
        : "deferred-to-sdk-infinite-sessions";
      try {
        await writeOpenClawCompactionMarker({
          sessionId: openclawSessionId,
          workspaceDir,
          trigger: params.trigger,
          currentTokenCount: params.currentTokenCount,
          sdkSessionId: tracked?.sdkSessionId,
          force: params.force,
          reason,
        });
      } catch (err) {
        return {
          ok: false,
          compacted: false,
          reason: "marker-write-failed",
          failure: {
            reason: "marker-write-failed",
            rawError: err instanceof Error ? err.message : String(err),
          },
        };
      }
      return {
        ok: true,
        compacted: false,
        reason,
      };
    },

    async dispose() {
      if (disposePromise) {
        return disposePromise;
      }
      disposed = true;
      disposePromise = (async () => {
        if (inFlight.size > 0) {
          await Promise.allSettled(inFlight);
        }
        trackedSessions.clear();
        resetBlockedStoredSessions.clear();
        if (createdPool) {
          const errors = await createdPool.dispose();
          if (errors.length > 0) {
            throw new AggregateError(errors, "[copilot] pool disposal errors");
          }
        }
      })();
      return disposePromise;
    },
  };
}
