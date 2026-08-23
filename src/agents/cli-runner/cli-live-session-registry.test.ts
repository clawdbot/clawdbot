import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { CliBackendLiveSessionHandle } from "../../plugins/cli-backend.types.js";
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import {
  acceptsCliLiveSession,
  beginCliLiveSessionCreate,
  buildCliLiveOwnerKey,
  buildCliLiveSessionKey,
  closeCliLiveSession,
  enqueueCliLiveTurn,
  ensureCliLiveSessionCapacity,
  finishCliLiveSessionCreate,
  getCliLiveSession,
  getCliLiveSessionGeneration,
  hasCliLiveSession,
  registerCliLiveSession,
  removeCliLiveSession,
} from "./cli-live-session-registry.js";
import { resetCliLiveSessionsForTest } from "./cli-live-session.test-support.js";
import { buildCliLiveSessionFingerprint } from "./live-session-fingerprint.js";

function createSession(
  key: string,
  options: { generation?: string; idle?: boolean; deferExit?: boolean } = {},
) {
  const exited = createDeferred<void>();
  const session: CliBackendLiveSessionHandle = {
    key,
    generation: options.generation ?? `generation-${key}`,
    fingerprint: "owner-policy-fingerprint",
    providerId: "test-cli",
    modelId: "test-model",
    isIdle: vi.fn(() => options.idle ?? false),
    close: vi.fn(() => {
      removeCliLiveSession(session);
      if (!options.deferExit) {
        exited.resolve();
      }
    }),
    waitForExit: vi.fn(() => exited.promise),
    cleanupResources: vi.fn(async () => {}),
  };
  return { session, exited };
}

function registerSession(
  session: CliBackendLiveSessionHandle,
  cleanup?: () => Promise<void>,
): void {
  const pending = beginCliLiveSessionCreate(session.key, session.generation);
  registerCliLiveSession(session, pending, cleanup);
  finishCliLiveSessionCreate(session.key, pending);
}

beforeEach(() => {
  resetCliLiveSessionsForTest();
});

afterEach(() => {
  resetCliLiveSessionsForTest();
  vi.restoreAllMocks();
});

describe("generic plugin-owned live session registry", () => {
  it("keeps owner identity deterministic and isolated across sessions and providers", () => {
    const owner = {
      agentAccountId: "acct-1",
      agentId: "agent-main",
      authProfileId: "profile-a",
      sessionId: "sess-1",
      sessionKey: "key-a",
    };

    expect(buildCliLiveOwnerKey(owner)).toBe(
      "718b9a6cf473526c3c357883dfc8f1da1cf90b709d9ed38d675b52314abe6800",
    );
    expect(buildCliLiveOwnerKey({ ...owner, sessionKey: "key-b" })).not.toBe(
      buildCliLiveOwnerKey(owner),
    );

    const first = buildPreparedCliRunContext({ provider: "claude-cli" });
    const second = buildPreparedCliRunContext({ provider: "google-gemini-cli" });
    expect(buildCliLiveSessionKey(first)).not.toBe(buildCliLiveSessionKey(second));
  });

  it("keeps fresh and resumed process fingerprints identical without hiding prompt changes", () => {
    const fresh = buildPreparedCliRunContext({ systemPrompt: "Original system policy." });
    const resumed = buildPreparedCliRunContext({ systemPrompt: "Original system policy." });
    const changed = buildPreparedCliRunContext({ systemPrompt: "Changed system policy." });
    const env = { PATH: "/usr/bin:/bin" };
    const freshFingerprint = buildCliLiveSessionFingerprint({
      context: fresh,
      argv: ["claude", "-p", "--session-id", "native-session"],
      env,
    });

    expect(
      buildCliLiveSessionFingerprint({
        context: resumed,
        argv: ["claude", "-p", "--resume", "native-session"],
        env,
      }),
    ).toBe(freshFingerprint);
    expect(
      buildCliLiveSessionFingerprint({
        context: changed,
        argv: ["claude", "-p", "--resume", "native-session"],
        env,
      }),
    ).not.toBe(freshFingerprint);
  });

  it("exposes pending and registered generations without reviving a removed owner", () => {
    const context = buildPreparedCliRunContext({ sessionId: "session-owner" });
    const owner = { backendId: "claude-cli", sessionId: "session-owner" };
    const key = buildCliLiveSessionKey(context);
    const { session } = createSession(key, { generation: "generation-exact" });
    const pending = beginCliLiveSessionCreate(key, session.generation);

    expect(hasCliLiveSession(owner)).toBe(true);
    expect(getCliLiveSessionGeneration(owner)).toBe("generation-exact");

    registerCliLiveSession(session, pending);
    finishCliLiveSessionCreate(key, pending);
    expect(getCliLiveSession(key)).toBe(session);

    removeCliLiveSession(session);
    expect(getCliLiveSession(key)).toBeUndefined();
    expect(hasCliLiveSession(owner)).toBe(false);
  });

  it("rejects a late registration after the pending owner has been closed", async () => {
    const context = buildPreparedCliRunContext({ sessionId: "session-pending" });
    const key = buildCliLiveSessionKey(context);
    const { session } = createSession(key);
    const pending = beginCliLiveSessionCreate(key, session.generation);

    await closeCliLiveSession(context, "abort");
    registerCliLiveSession(session, pending);

    expect(session.close).toHaveBeenCalledWith("abort");
    expect(getCliLiveSession(key)).toBeUndefined();
    expect(
      getCliLiveSessionGeneration({ backendId: "claude-cli", sessionId: "session-pending" }),
    ).toBeUndefined();
  });

  it("serializes turns for the same owner without blocking another owner", async () => {
    const releaseFirst = createDeferred<void>();
    const events: string[] = [];
    const first = enqueueCliLiveTurn("owner-a", async () => {
      events.push("a:first:start");
      await releaseFirst.promise;
      events.push("a:first:end");
    });
    const second = enqueueCliLiveTurn("owner-a", async () => {
      events.push("a:second");
    });
    const independent = enqueueCliLiveTurn("owner-b", async () => {
      events.push("b:independent");
    });

    await independent;
    expect(events).toEqual(["a:first:start", "b:independent"]);
    releaseFirst.resolve();
    await Promise.all([first, second]);

    expect(events).toEqual(["a:first:start", "b:independent", "a:first:end", "a:second"]);
  });

  it("keeps native skill resources alive until the registered subprocess actually exits", async () => {
    const context = buildPreparedCliRunContext({ sessionId: "session-native-skills" });
    const key = buildCliLiveSessionKey(context);
    const { session, exited } = createSession(key, { deferExit: true });
    const cleanup = vi.fn(async () => {});
    registerSession(session, cleanup);

    removeCliLiveSession(session);
    removeCliLiveSession(session);
    await Promise.resolve();
    expect(cleanup).not.toHaveBeenCalled();

    exited.resolve();
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
  });

  it("waits for process shutdown and cleans claimed runtime resources exactly once", async () => {
    const context = buildPreparedCliRunContext({ sessionId: "session-resource-owner" });
    const key = buildCliLiveSessionKey(context);
    const { session, exited } = createSession(key, { deferExit: true });
    const cleanup = vi.fn(async () => {});
    registerSession(session, cleanup);

    const close = closeCliLiveSession(context, "restart");
    await Promise.resolve();
    expect(cleanup).not.toHaveBeenCalled();
    expect(session.cleanupResources).not.toHaveBeenCalled();

    exited.resolve();
    await close;

    expect(session.close).toHaveBeenCalledWith("restart");
    expect(session.cleanupResources).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("evicts an idle owner at capacity and fails closed when every owner is active", () => {
    const context = buildPreparedCliRunContext();
    const handles = Array.from({ length: 16 }, (_, index) => {
      const entry = createSession(`bounded-${index}`, { idle: index === 0 });
      registerSession(entry.session);
      return entry.session;
    });

    expect(() => ensureCliLiveSessionCapacity("next-owner", context)).not.toThrow();
    expect(handles[0]?.close).toHaveBeenCalledWith("idle");

    const replacement = createSession("replacement-owner");
    registerSession(replacement.session);
    expect(() => ensureCliLiveSessionCapacity("overflow-owner", context)).toThrow(
      "Too many CLI live sessions are active.",
    );
  });

  it("admits only local plugin-owned structured execution to reusable sessions", () => {
    const eligible = buildPreparedCliRunContext({ backend: { liveSession: "claude-stdio" } });
    eligible.preparedBackend.execute = async function* () {
      yield { type: "result" };
    };

    expect(acceptsCliLiveSession(eligible)).toBe(true);

    const node = buildPreparedCliRunContext({
      backend: { liveSession: "claude-stdio" },
      sessionEntry: { sessionId: "node-session", updatedAt: 1, execHost: "node" },
    });
    node.preparedBackend.execute = eligible.preparedBackend.execute;
    expect(acceptsCliLiveSession(node)).toBe(false);

    eligible.backendResolved.liveSessionRequirement = {
      capability: "third_party_stream_correlation_v1",
      minimumVersion: "1.2.3",
      versionArgs: ["--version"],
      updateCommand: "third-party-cli update",
    };
    expect(acceptsCliLiveSession(eligible)).toBe(false);
    delete eligible.backendResolved.liveSessionRequirement;

    delete eligible.preparedBackend.execute;
    expect(acceptsCliLiveSession(eligible)).toBe(false);
  });
});
