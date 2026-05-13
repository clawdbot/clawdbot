import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  buildConfiguredAcpSessionKey,
  type ConfiguredAcpBindingSpec,
} from "./persistent-bindings.types.js";

const managerMocks = vi.hoisted(() => ({
  resolveSession: vi.fn(),
  closeSession: vi.fn(),
  initializeSession: vi.fn(),
  updateSessionRuntimeOptions: vi.fn(),
}));

const sessionMetaMocks = vi.hoisted(() => ({
  readAcpSessionEntry: vi.fn(),
}));

const resolveMocks = vi.hoisted(() => ({
  resolveConfiguredAcpBindingSpecBySessionKey: vi.fn(),
}));

vi.mock("./control-plane/manager.js", () => ({
  getAcpSessionManager: () => ({
    resolveSession: managerMocks.resolveSession,
    closeSession: managerMocks.closeSession,
    initializeSession: managerMocks.initializeSession,
    updateSessionRuntimeOptions: managerMocks.updateSessionRuntimeOptions,
  }),
}));

vi.mock("./runtime/session-meta.js", () => ({
  readAcpSessionEntry: sessionMetaMocks.readAcpSessionEntry,
}));

vi.mock("./persistent-bindings.resolve.js", () => ({
  resolveConfiguredAcpBindingSpecBySessionKey:
    resolveMocks.resolveConfiguredAcpBindingSpecBySessionKey,
}));
const baseCfg = {
  session: { mainKey: "main", scope: "per-sender" },
  agents: {
    list: [{ id: "codex" }, { id: "claude" }],
  },
} satisfies OpenClawConfig;

let ensureConfiguredAcpBindingSession: typeof import("./persistent-bindings.lifecycle.js").ensureConfiguredAcpBindingSession;
let resetAcpSessionInPlace: typeof import("./persistent-bindings.lifecycle.js").resetAcpSessionInPlace;

beforeEach(async () => {
  vi.resetModules();
  managerMocks.resolveSession.mockReset().mockReturnValue({ kind: "none" });
  managerMocks.closeSession.mockReset().mockResolvedValue({
    runtimeClosed: true,
    metaCleared: false,
  });
  managerMocks.initializeSession.mockReset().mockResolvedValue(undefined);
  managerMocks.updateSessionRuntimeOptions.mockReset().mockResolvedValue(undefined);
  sessionMetaMocks.readAcpSessionEntry.mockReset().mockReturnValue(undefined);
  resolveMocks.resolveConfiguredAcpBindingSpecBySessionKey.mockReset().mockReturnValue(null);
  ({ ensureConfiguredAcpBindingSession, resetAcpSessionInPlace } =
    await import("./persistent-bindings.lifecycle.js"));
});

function createPersistentSpec(
  overrides: Partial<ConfiguredAcpBindingSpec> = {},
): ConfiguredAcpBindingSpec {
  return {
    channel: "discord",
    accountId: "default",
    conversationId: "1478836151241412759",
    agentId: "codex",
    mode: "persistent",
    ...overrides,
  };
}

function mockReadySession(params: {
  spec: ConfiguredAcpBindingSpec;
  cwd: string;
  state?: "idle" | "running" | "error";
}) {
  const sessionKey = buildConfiguredAcpSessionKey(params.spec);
  managerMocks.resolveSession.mockReturnValue({
    kind: "ready",
    sessionKey,
    meta: {
      backend: "acpx",
      agent: params.spec.acpAgentId ?? params.spec.agentId,
      runtimeSessionName: "existing",
      mode: params.spec.mode,
      runtimeOptions: { cwd: params.cwd },
      state: params.state ?? "idle",
      lastActivityAt: Date.now(),
    },
  });
  return sessionKey;
}

function expectCloseArgs(): Record<string, unknown> {
  expect(managerMocks.closeSession).toHaveBeenCalledTimes(1);
  const call = managerMocks.closeSession.mock.calls[0];
  if (!call) {
    throw new Error("expected closeSession call");
  }
  return call[0] as Record<string, unknown>;
}

function expectInitializeArgs(): Record<string, unknown> {
  expect(managerMocks.initializeSession).toHaveBeenCalledTimes(1);
  const call = managerMocks.initializeSession.mock.calls[0];
  if (!call) {
    throw new Error("expected initializeSession call");
  }
  return call[0] as Record<string, unknown>;
}

describe("ensureConfiguredAcpBindingSession", () => {
  it("keeps an existing ready session when configured binding omits cwd", async () => {
    const spec = createPersistentSpec();
    const sessionKey = mockReadySession({
      spec,
      cwd: "/workspace/openclaw",
    });

    const ensured = await ensureConfiguredAcpBindingSession({
      cfg: baseCfg,
      spec,
    });

    expect(ensured).toEqual({ ok: true, sessionKey });
    expect(managerMocks.closeSession).not.toHaveBeenCalled();
    expect(managerMocks.initializeSession).not.toHaveBeenCalled();
  });

  it("reinitializes a ready session when binding config explicitly sets mismatched cwd", async () => {
    const spec = createPersistentSpec({
      cwd: "/workspace/repo-a",
    });
    const sessionKey = mockReadySession({
      spec,
      cwd: "/workspace/other-repo",
    });

    const ensured = await ensureConfiguredAcpBindingSession({
      cfg: baseCfg,
      spec,
    });

    expect(ensured).toEqual({ ok: true, sessionKey });
    const closeArgs = expectCloseArgs();
    expect(closeArgs.sessionKey).toBe(sessionKey);
    expect(closeArgs.clearMeta).toBe(false);
    expect(managerMocks.initializeSession).toHaveBeenCalledTimes(1);
  });

  it("reinitializes a matching session when the stored ACP session is in error state", async () => {
    const spec = createPersistentSpec({
      cwd: "/home/bob/clawd",
    });
    const sessionKey = mockReadySession({
      spec,
      cwd: "/home/bob/clawd",
      state: "error",
    });

    const ensured = await ensureConfiguredAcpBindingSession({
      cfg: baseCfg,
      spec,
    });

    expect(ensured).toEqual({ ok: true, sessionKey });
    expect(managerMocks.closeSession).toHaveBeenCalledTimes(1);
    expect(managerMocks.initializeSession).toHaveBeenCalledTimes(1);
  });

  it("initializes ACP session with runtime agent override when provided", async () => {
    const spec = createPersistentSpec({
      agentId: "coding",
      acpAgentId: "codex",
    });
    managerMocks.resolveSession.mockReturnValue({ kind: "none" });

    const ensured = await ensureConfiguredAcpBindingSession({
      cfg: baseCfg,
      spec,
    });

    expect(ensured.ok).toBe(true);
    const initializeArgs = expectInitializeArgs();
    expect(initializeArgs.agent).toBe("codex");
  });
});

describe("resetAcpSessionInPlace", () => {
  it("clears configured bindings and lets the next turn recreate them", async () => {
    const spec = {
      channel: "demo-binding",
      accountId: "default",
      conversationId: "9373ab192b2317f4",
      agentId: "claude",
      mode: "persistent",
      backend: "acpx",
      cwd: "/home/bob/clawd",
    } as const;
    const sessionKey = buildConfiguredAcpSessionKey(spec);
    resolveMocks.resolveConfiguredAcpBindingSpecBySessionKey.mockReturnValue(spec);
    sessionMetaMocks.readAcpSessionEntry.mockReturnValue({
      acp: {
        agent: "claude",
        mode: "persistent",
        backend: "acpx",
        runtimeOptions: { cwd: "/home/bob/clawd" },
      },
    });

    const result = await resetAcpSessionInPlace({
      cfg: baseCfg,
      sessionKey,
      reason: "reset",
    });

    expect(result).toEqual({ ok: true });
    expect(resolveMocks.resolveConfiguredAcpBindingSpecBySessionKey).toHaveBeenCalledTimes(1);
    const closeArgs = expectCloseArgs();
    expect(closeArgs.sessionKey).toBe(sessionKey);
    expect(closeArgs.discardPersistentState).toBe(true);
    expect(closeArgs.clearMeta).toBe(true);
    expect(managerMocks.initializeSession).not.toHaveBeenCalled();
    expect(managerMocks.updateSessionRuntimeOptions).not.toHaveBeenCalled();
  });

  it("falls back to close-only resets when no configured binding exists", async () => {
    const sessionKey = "agent:claude:acp:binding:demo-binding:default:9373ab192b2317f4";
    sessionMetaMocks.readAcpSessionEntry.mockReturnValue({
      acp: {
        agent: "claude",
        mode: "persistent",
        backend: "acpx",
      },
    });

    const result = await resetAcpSessionInPlace({
      cfg: baseCfg,
      sessionKey,
      reason: "reset",
    });

    expect(result).toEqual({ ok: true });
    expect(resolveMocks.resolveConfiguredAcpBindingSpecBySessionKey).toHaveBeenCalledTimes(1);
    const closeArgs = expectCloseArgs();
    expect(closeArgs.sessionKey).toBe(sessionKey);
    expect(closeArgs.clearMeta).toBe(false);
    expect(managerMocks.initializeSession).not.toHaveBeenCalled();
  });

  it("can force metadata clearing for bound ACP targets outside the configured registry", async () => {
    const sessionKey = "agent:claude:acp:binding:demo-binding:default:9373ab192b2317f4";
    sessionMetaMocks.readAcpSessionEntry.mockReturnValue({
      acp: {
        agent: "claude",
        mode: "persistent",
        backend: "acpx",
      },
    });

    const result = await resetAcpSessionInPlace({
      cfg: baseCfg,
      sessionKey,
      reason: "new",
      clearMeta: true,
    });

    expect(result).toEqual({ ok: true });
    expect(resolveMocks.resolveConfiguredAcpBindingSpecBySessionKey).toHaveBeenCalledTimes(1);
    const closeArgs = expectCloseArgs();
    expect(closeArgs.sessionKey).toBe(sessionKey);
    expect(closeArgs.clearMeta).toBe(true);
  });

  it("treats configured bindings with no ACP metadata as already reset", async () => {
    const spec = {
      channel: "demo-binding",
      accountId: "default",
      conversationId: "9373ab192b2317f4",
      agentId: "claude",
      mode: "persistent",
      backend: "acpx",
      cwd: "/home/bob/clawd",
    } as const;
    const sessionKey = buildConfiguredAcpSessionKey(spec);
    resolveMocks.resolveConfiguredAcpBindingSpecBySessionKey.mockReturnValue(spec);

    const result = await resetAcpSessionInPlace({
      cfg: baseCfg,
      sessionKey,
      reason: "new",
    });

    expect(result).toEqual({ ok: true });
    expect(managerMocks.closeSession).not.toHaveBeenCalled();
    expect(managerMocks.initializeSession).not.toHaveBeenCalled();
  });
});
