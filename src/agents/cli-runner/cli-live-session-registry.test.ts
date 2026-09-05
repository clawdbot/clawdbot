import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type {
  CliBackendLiveSessionCapability,
  CliBackendLiveSessionHandle,
} from "../../plugins/cli-backend.types.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import {
  acceptsCliLiveSession,
  buildCliLiveOwnerKey,
  closeCliLiveSession,
  createCliLiveSessionCapability,
  getCliLiveSessionGeneration,
  hasCliLiveSession,
} from "./cli-live-session-registry.js";
import { buildCliLiveSessionFingerprint } from "./live-session-fingerprint.js";

const admissions: Array<ReturnType<typeof prepareSystemAgentRunAdmission>> = [];
const sessions = new Set<CliBackendLiveSessionHandle>();
let nextOwnerId = 0;

async function createOwner(
  options: {
    sessionId?: string;
    generation?: string;
    idle?: boolean;
    deferExit?: boolean;
    cleanup?: () => Promise<void>;
    systemPrompt?: string;
    argv0?: string;
    capture?: { token: string; key: string };
    requiredGeneration?: string;
  } = {},
) {
  const index = ++nextOwnerId;
  const sessionId = options.sessionId ?? `registry-session-${index}`;
  const sessionKey = `agent:main:${sessionId}`;
  const context = buildPreparedCliRunContext({
    provider: "claude-cli",
    agentId: "main",
    runId: `registry-run-${index}`,
    sessionId,
    sessionKey,
    ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
  });
  const admission = prepareSystemAgentRunAdmission(
    {},
    context.params.runId,
    "main",
    "registry-test",
  );
  admissions.push(admission);
  context.params.admittedRunContext = await admission.admit("plugin-harness");
  const grant = options.capture
    ? {
        transportToken: options.capture.token,
        adoptProcessToken: vi.fn(),
        revokeProcessToken: vi.fn(),
        activate: vi.fn(),
        deactivate: vi.fn(),
      }
    : undefined;
  if (grant) {
    context.preparedBackend.mcpClientGrantCapture = grant;
  }
  const beginCapture = vi.fn();
  const capability: CliBackendLiveSessionCapability = createCliLiveSessionCapability({
    context,
    argv: ["claude", "-p"],
    argv0: options.argv0,
    env: { PATH: "/usr/bin:/bin" },
    beginCapture,
    abortSignal: new AbortController().signal,
    ...(options.cleanup ? { claimResources: () => options.cleanup } : {}),
    ...(options.capture ? { captureKey: options.capture.key } : {}),
    ...(options.requiredGeneration ? { requiredGeneration: options.requiredGeneration } : {}),
  });
  const exited = createDeferred();
  const close = vi.fn(() => {
    capability.remove(session);
    if (!options.deferExit) {
      exited.resolve();
    }
  });
  const waitForExit = vi.fn(() => exited.promise);
  const session: CliBackendLiveSessionHandle = {
    generation: options.generation ?? `generation-${index}`,
    fingerprint: capability.fingerprint,
    isIdle: vi.fn(() => options.idle ?? false),
    close,
    waitForExit,
  };
  const register = () => {
    capability.register(session);
    sessions.add(session);
    return session;
  };
  return {
    admission,
    beginCapture,
    capability,
    close,
    context,
    exited,
    grant,
    register,
    session,
    sessionId,
    sessionKey,
    waitForExit,
  };
}

afterEach(() => {
  for (const session of sessions) {
    session.close("restart");
  }
  sessions.clear();
  for (const admission of admissions.splice(0)) {
    admission.close();
  }
  vi.restoreAllMocks();
});

describe("generic plugin-owned live session registry", () => {
  it("keeps owner identity deterministic and isolated across sessions", () => {
    const owner = {
      agentAccountId: "acct-1",
      agentId: "agent-main",
      authProfileId: "profile-a",
      sessionId: "sess-1",
      sessionKey: "key-a",
    };

    expect(buildCliLiveOwnerKey({ ...owner })).toBe(buildCliLiveOwnerKey(owner));
    expect(buildCliLiveOwnerKey({ ...owner, sessionKey: "key-b" })).not.toBe(
      buildCliLiveOwnerKey(owner),
    );
  });

  it("keeps fresh and resumed process fingerprints identical without hiding prompt changes", () => {
    const fresh = buildPreparedCliRunContext({ systemPrompt: "Original system policy." });
    const resumed = buildPreparedCliRunContext({ systemPrompt: "Original system policy." });
    const changed = buildPreparedCliRunContext({ systemPrompt: "Changed system policy." });
    const mcpFresh = buildPreparedCliRunContext({ systemPrompt: "Original system policy." });
    const mcpResumed = buildPreparedCliRunContext({ systemPrompt: "Original system policy." });
    mcpFresh.preparedBackend.mcpConfigHash = "stable-mcp-config";
    mcpResumed.preparedBackend.mcpConfigHash = "stable-mcp-config";
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
    expect(
      buildCliLiveSessionFingerprint({
        context: resumed,
        argv: ["claude", "-p", "--resume", "native-session", "--effort", "max"],
        env,
      }),
    ).not.toBe(freshFingerprint);
    expect(
      buildCliLiveSessionFingerprint({
        context: resumed,
        argv: ["claude", "-p", "--resume", "native-session"],
        env: { ...env, CLAUDE_CODE_EFFORT_LEVEL: "max" },
      }),
    ).not.toBe(freshFingerprint);

    const mcpFreshFingerprint = buildCliLiveSessionFingerprint({
      context: mcpFresh,
      argv: ["claude", "-p", "--session-id", "native-session", "--mcp-config", "/tmp/turn-a.json"],
      env,
    });
    expect(
      buildCliLiveSessionFingerprint({
        context: mcpResumed,
        argv: ["claude", "-p", "--resume", "native-session", "--mcp-config", "/tmp/turn-b.json"],
        env,
      }),
    ).toBe(mcpFreshFingerprint);
  });

  it("exposes only an active registered generation and never revives a removed owner", async () => {
    const owner = await createOwner({ generation: "generation-exact" });
    const identity = {
      backendId: "claude-cli",
      agentId: "main",
      sessionId: owner.sessionId,
      sessionKey: owner.sessionKey,
    };

    expect(hasCliLiveSession(identity)).toBe(false);
    owner.register();
    expect(hasCliLiveSession(identity)).toBe(true);
    expect(getCliLiveSessionGeneration(identity)).toBe("generation-exact");

    owner.capability.remove(owner.session);
    expect(owner.capability.current()).toBeUndefined();
    expect(hasCliLiveSession(identity)).toBe(false);
  });

  it("rejects registration once its exact admitted run has closed", async () => {
    const owner = await createOwner();
    owner.admission.close();

    expect(() => owner.register()).toThrow("no longer active");
    expect(
      hasCliLiveSession({
        backendId: "claude-cli",
        agentId: "main",
        sessionId: owner.sessionId,
        sessionKey: owner.sessionKey,
      }),
    ).toBe(false);
  });

  it("rejects the same process handle under a different owner despite a matching fingerprint", async () => {
    const original = await createOwner({ sessionId: "original-owner" });
    const other = await createOwner({ sessionId: "different-owner" });
    original.register();

    expect(other.capability.fingerprint).toBe(original.capability.fingerprint);
    expect(() => other.capability.register(original.session)).toThrow();
    expect(other.capability.current()).toBeUndefined();
    expect(original.capability.current()).toBe(original.session);
  });

  it.each([
    {
      change: "system prompt",
      originalOptions: { systemPrompt: "Original system policy." },
      changedOptions: { systemPrompt: "Changed system policy." },
    },
    {
      change: "invocation name",
      originalOptions: { argv0: "/usr/bin/cli-alias-a" },
      changedOptions: { argv0: "/usr/bin/cli-alias-b" },
    },
  ])(
    "rejects required generation reuse after $change changes without closing its only process",
    async ({ originalOptions, changedOptions }) => {
      const original = await createOwner({
        sessionId: "required-changed-owner",
        generation: "required-generation",
        ...originalOptions,
      });
      original.register();
      const changed = await createOwner({
        sessionId: "required-changed-owner",
        requiredGeneration: "required-generation",
        ...changedOptions,
      });

      expect(changed.capability.fingerprint).not.toBe(original.capability.fingerprint);
      expect(() => changed.capability.current()).toThrow(
        expect.objectContaining({ reason: "session_expired", code: "cli_live_session_changed" }),
      );
      expect(original.close).not.toHaveBeenCalled();
      expect(original.capability.current()).toBe(original.session);
    },
  );

  it("transfers admitted MCP authority to the original private process before capture", async () => {
    const original = await createOwner({
      sessionId: "captured-owner",
      capture: { token: "process-token-a", key: "capture-a" },
    });
    original.register();
    const resumed = await createOwner({
      sessionId: "captured-owner",
      capture: { token: "turn-token-b", key: "capture-b" },
    });

    resumed.capability.activate(original.session);

    expect(resumed.grant?.adoptProcessToken).toHaveBeenCalledExactlyOnceWith("process-token-a");
    expect(resumed.beginCapture).toHaveBeenCalledExactlyOnceWith("capture-a");
    expect(resumed.grant?.adoptProcessToken.mock.invocationCallOrder[0]).toBeLessThan(
      resumed.beginCapture.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(Object.keys(resumed.capability)).not.toEqual(
      expect.arrayContaining(["ownerKey", "transportToken", "captureKey"]),
    );

    resumed.capability.remove(original.session);
    resumed.capability.remove(original.session);
    expect(original.grant?.revokeProcessToken).toHaveBeenCalledOnce();
    expect(resumed.grant?.revokeProcessToken).not.toHaveBeenCalled();
    expect(original.capability.current()).toBeUndefined();
  });

  it("fences MCP capture when its admitted authority closes during process transfer", async () => {
    const original = await createOwner({
      sessionId: "transfer-closed-owner",
      capture: { token: "original-process-token", key: "original-capture" },
    });
    original.register();
    const resumed = await createOwner({
      sessionId: "transfer-closed-owner",
      capture: { token: "replacement-turn-token", key: "replacement-capture" },
    });
    resumed.grant?.adoptProcessToken.mockImplementation(() => resumed.admission.close());

    expect(() => resumed.capability.activate(original.session)).toThrow("no longer active");

    expect(resumed.grant?.adoptProcessToken).toHaveBeenCalledExactlyOnceWith(
      "original-process-token",
    );
    expect(resumed.beginCapture).not.toHaveBeenCalled();
    expect(original.capability.current()).toBe(original.session);
  });

  it.each([
    {
      name: "a captured process cannot resume without an admitted turn grant",
      originalCapture: { token: "captured-process-token", key: "captured-process-key" },
      resumedCapture: undefined,
    },
    {
      name: "an uncaptured process cannot inherit a newly admitted turn grant",
      originalCapture: undefined,
      resumedCapture: { token: "new-turn-token", key: "new-turn-key" },
    },
  ])("$name", async ({ originalCapture, resumedCapture }) => {
    const sessionId = "changed-capture-topology-owner";
    const original = await createOwner({
      sessionId,
      ...(originalCapture ? { capture: originalCapture } : {}),
    });
    original.register();
    const resumed = await createOwner({
      sessionId,
      ...(resumedCapture ? { capture: resumedCapture } : {}),
    });

    expect(() => resumed.capability.activate(original.session)).toThrow("MCP topology changed");
    expect(resumed.beginCapture).not.toHaveBeenCalled();
    if (resumed.grant) {
      expect(resumed.grant.adoptProcessToken).not.toHaveBeenCalled();
    }
    expect(original.capability.current()).toBe(original.session);
  });

  it("keeps claimed native skill resources until subprocess exit and cleans exactly once", async () => {
    const cleanup = vi.fn(async () => {});
    const owner = await createOwner({ deferExit: true, cleanup });
    owner.register();

    const closing = closeCliLiveSession(owner.context, "restart");
    owner.capability.remove(owner.session);
    await Promise.resolve();
    expect(cleanup).not.toHaveBeenCalled();

    owner.exited.resolve();
    await closing;

    expect(owner.close).toHaveBeenCalledWith("restart");
    expect(owner.waitForExit).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("evicts an idle owner at capacity and fails closed when every owner is active", async () => {
    const owners = [];
    for (let index = 0; index < 16; index += 1) {
      const owner = await createOwner({ idle: index === 0 });
      owner.register();
      owners.push(owner);
    }

    const replacement = await createOwner();
    expect(() => replacement.register()).not.toThrow();
    expect(owners[0]?.close).toHaveBeenCalledWith("idle");

    const overflow = await createOwner();
    expect(() => overflow.register()).toThrow("Too many CLI live sessions are active.");
  });

  it("admits only local plugin-owned structured execution to reusable sessions", () => {
    const eligible = buildPreparedCliRunContext({ backend: { liveSession: "claude-stdio" } });
    eligible.executionTarget = {
      kind: "plugin",
      async *execute() {
        yield { type: "result" };
      },
    };

    expect(acceptsCliLiveSession(eligible)).toBe(true);

    const node = buildPreparedCliRunContext({
      backend: { liveSession: "claude-stdio" },
      sessionEntry: {
        sessionId: "node-session",
        updatedAt: 1,
        execHost: "node",
        execNode: "node-test",
      },
    });
    expect(acceptsCliLiveSession(node)).toBe(false);

    eligible.executionTarget = { kind: "process" };
    expect(acceptsCliLiveSession(eligible)).toBe(false);
  });
});
