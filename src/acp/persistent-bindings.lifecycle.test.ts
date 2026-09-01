/** Tests configured ACP binding lifecycle behavior. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { AcpSessionResolution } from "./control-plane/manager.types.js";
import {
  buildConfiguredAcpSessionKey,
  type ConfiguredAcpBindingSpec,
} from "./persistent-bindings.types.js";

const managerMocks = vi.hoisted(() => ({
  resolveSession: vi.fn<(params: { sessionKey: string }) => AcpSessionResolution>(),
  closeSession: vi.fn(),
  initializeSession: vi.fn(),
  setSessionConfigOption: vi.fn(),
}));

vi.mock("./control-plane/manager.js", () => ({
  getAcpSessionManager: () => ({
    resolveSession: managerMocks.resolveSession,
    closeSession: managerMocks.closeSession,
    initializeSession: managerMocks.initializeSession,
    setSessionConfigOption: managerMocks.setSessionConfigOption,
  }),
}));

const baseCfg = {
  session: { mainKey: "main", scope: "per-sender" },
  agents: {
    list: [{ id: "codex" }, { id: "claude" }],
  },
} satisfies OpenClawConfig;

let ensureConfiguredAcpBindingSession: typeof import("./persistent-bindings.lifecycle.js").ensureConfiguredAcpBindingSession;

beforeEach(async () => {
  vi.resetModules();
  managerMocks.resolveSession
    .mockReset()
    .mockImplementation(({ sessionKey }) => ({ kind: "none", sessionKey }));
  managerMocks.closeSession.mockReset().mockResolvedValue({
    runtimeClosed: true,
    metaCleared: false,
  });
  managerMocks.initializeSession.mockReset().mockResolvedValue(undefined);
  managerMocks.setSessionConfigOption.mockReset().mockResolvedValue(undefined);
  ({ ensureConfiguredAcpBindingSession } = await import("./persistent-bindings.lifecycle.js"));
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
  model?: string;
  thinking?: string;
  state?: "idle" | "running" | "error";
}) {
  const sessionKey = buildConfiguredAcpSessionKey(params.spec);
  managerMocks.resolveSession.mockReturnValue({
    kind: "ready",
    sessionKey,
    agentId: params.spec.agentId,
    meta: {
      backend: "acpx",
      agent: params.spec.acpAgentId ?? params.spec.agentId,
      runtimeSessionName: "existing",
      mode: params.spec.mode,
      runtimeOptions: {
        cwd: params.cwd,
        ...(params.model ? { model: params.model } : {}),
        ...(params.thinking ? { thinking: params.thinking } : {}),
      },
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
      model: "manual/selected-model",
    });

    const ensured = await ensureConfiguredAcpBindingSession({
      cfg: baseCfg,
      spec,
    });

    expect(ensured).toEqual({ ok: true, sessionKey });
    expect(managerMocks.closeSession).not.toHaveBeenCalled();
    expect(managerMocks.initializeSession).not.toHaveBeenCalled();
    expect(managerMocks.setSessionConfigOption).not.toHaveBeenCalled();
  });

  it.each([
    { model: "anthropic/claude-sonnet-4-6" },
    { thinking: "off" },
    { model: "anthropic/claude-sonnet-4-6", thinking: "off" },
  ])("updates configured runtime options %j in place", async (runtimeOptions) => {
    const spec = createPersistentSpec(runtimeOptions);
    const sessionKey = mockReadySession({
      spec,
      cwd: "/workspace/openclaw",
      model: "anthropic/claude-haiku-4-5",
      thinking: "high",
    });

    const ensured = await ensureConfiguredAcpBindingSession({
      cfg: baseCfg,
      spec,
    });

    expect(ensured).toEqual({ ok: true, sessionKey });
    expect(managerMocks.setSessionConfigOption.mock.calls).toEqual(
      Object.entries(runtimeOptions).map(([key, value]) => [
        { cfg: baseCfg, sessionKey, agentId: spec.agentId, key, value },
      ]),
    );
    expect(managerMocks.closeSession).not.toHaveBeenCalled();
    expect(managerMocks.initializeSession).not.toHaveBeenCalled();
  });

  it("does not rewrite matching runtime options", async () => {
    const spec = createPersistentSpec({ model: "selected/model", thinking: "off" });
    const sessionKey = mockReadySession({ spec, cwd: "/workspace/openclaw", ...spec });

    expect(await ensureConfiguredAcpBindingSession({ cfg: baseCfg, spec })).toEqual({
      ok: true,
      sessionKey,
    });
    expect(managerMocks.setSessionConfigOption).not.toHaveBeenCalled();
    expect(managerMocks.closeSession).not.toHaveBeenCalled();
    expect(managerMocks.initializeSession).not.toHaveBeenCalled();
  });

  it("reports rejected live thinking without replacing or overwriting the existing session", async () => {
    const spec = createPersistentSpec({ thinking: "off" });
    const sessionKey = mockReadySession({
      spec,
      cwd: "/workspace/openclaw",
      thinking: "high",
    });
    managerMocks.setSessionConfigOption.mockRejectedValue(new Error("Live off is unsupported"));

    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await ensureConfiguredAcpBindingSession({ cfg: baseCfg, spec })).toEqual({
        ok: false,
        sessionKey,
        error: "Live off is unsupported",
      });
    }
    expect(managerMocks.setSessionConfigOption).toHaveBeenCalledTimes(2);
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

  it("initializes ACP session with runtime agent override and configured model", async () => {
    const spec = createPersistentSpec({
      agentId: "coding",
      acpAgentId: "codex",
      model: "anthropic/claude-sonnet-4-6",
    });

    const ensured = await ensureConfiguredAcpBindingSession({
      cfg: baseCfg,
      spec,
    });

    expect(ensured.ok).toBe(true);
    const initializeArgs = expectInitializeArgs();
    expect(initializeArgs.agent).toBe("codex");
    expect(initializeArgs.runtimeOptions).toEqual({
      model: "anthropic/claude-sonnet-4-6",
    });
    expect(initializeArgs).not.toHaveProperty("modelExplicit");
  });

  it("forwards the owner agent's configured thinking default on session init", async () => {
    const spec = createPersistentSpec({
      model: "ollama-cloud/glm-5.2:cloud",
      thinking: "off",
    });

    const ensured = await ensureConfiguredAcpBindingSession({
      cfg: baseCfg,
      spec,
    });

    expect(ensured.ok).toBe(true);
    const initializeArgs = expectInitializeArgs();
    expect(initializeArgs.runtimeOptions).toEqual({
      model: "ollama-cloud/glm-5.2:cloud",
      thinking: "off",
    });
  });

  it("patches thinking drift in place for a structurally matching session", async () => {
    const spec = createPersistentSpec({ thinking: "off" });
    const sessionKey = mockReadySession({
      spec,
      cwd: "/workspace/openclaw",
    });

    const ensured = await ensureConfiguredAcpBindingSession({
      cfg: baseCfg,
      spec,
    });

    expect(ensured).toEqual({ ok: true, sessionKey });
    expect(managerMocks.setSessionConfigOption).toHaveBeenCalledWith({
      cfg: baseCfg,
      sessionKey,
      agentId: spec.agentId,
      key: "thinking",
      value: "off",
    });
    expect(managerMocks.closeSession).not.toHaveBeenCalled();
    expect(managerMocks.initializeSession).not.toHaveBeenCalled();
  });

  it("preserves the session selection once configured defaults are removed", async () => {
    const spec = createPersistentSpec();
    const sessionKey = mockReadySession({
      spec,
      cwd: "/workspace/openclaw",
      model: "manual/selected-model",
      thinking: "off",
    });

    const ensured = await ensureConfiguredAcpBindingSession({
      cfg: baseCfg,
      spec,
    });

    expect(ensured).toEqual({ ok: true, sessionKey });
    expect(managerMocks.setSessionConfigOption).not.toHaveBeenCalled();
    expect(managerMocks.closeSession).not.toHaveBeenCalled();
    expect(managerMocks.initializeSession).not.toHaveBeenCalled();
  });
});
