import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { buildConfiguredAcpSessionKey } from "./persistent-bindings.types.js";

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
  ({ resetAcpSessionInPlace } = await import("./persistent-bindings.lifecycle.js"));
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
    expect(managerMocks.closeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey,
        discardPersistentState: true,
        clearMeta: true,
      }),
    );
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
    expect(managerMocks.closeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey,
        clearMeta: false,
      }),
    );
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
    expect(managerMocks.closeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey,
        clearMeta: true,
      }),
    );
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
