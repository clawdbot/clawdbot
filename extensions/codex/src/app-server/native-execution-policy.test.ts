// Codex tests cover native execution policy plugin behavior.
import type { getSessionEntry as getSessionEntryType } from "openclaw/plugin-sdk/session-store-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveCodexNativeExecutionPolicy } from "./native-execution-policy.js";

const sessionStoreMocks = vi.hoisted(() => ({
  getSessionEntry: vi.fn<typeof getSessionEntryType>(),
}));

vi.mock("openclaw/plugin-sdk/session-store-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/session-store-runtime")>();
  return {
    ...actual,
    getSessionEntry: sessionStoreMocks.getSessionEntry,
  };
});

describe("resolveCodexNativeExecutionPolicy", () => {
  beforeEach(() => {
    sessionStoreMocks.getSessionEntry.mockReset();
  });

  it("allows Codex native execution for gateway exec hosts", () => {
    expect(
      resolveCodexNativeExecutionPolicy({
        config: { tools: { exec: { host: "gateway" } } },
        sessionKey: "session-1",
      }),
    ).toMatchObject({
      nativeToolSurfaceAllowed: true,
      requestedExecHost: "gateway",
      effectiveExecHost: "gateway",
    });
  });

  it("resolves auto to gateway when no sandbox is active", () => {
    expect(
      resolveCodexNativeExecutionPolicy({
        config: { tools: { exec: { host: "auto" } } },
        sessionKey: "session-1",
        sandboxAvailable: false,
      }),
    ).toMatchObject({
      nativeToolSurfaceAllowed: true,
      requestedExecHost: "auto",
      effectiveExecHost: "gateway",
    });
  });

  it("resolves auto to sandbox when a sandbox is active", () => {
    expect(
      resolveCodexNativeExecutionPolicy({
        config: { tools: { exec: { host: "auto" } } },
        sessionKey: "session-1",
        sandboxAvailable: true,
      }),
    ).toMatchObject({
      nativeToolSurfaceAllowed: true,
      requestedExecHost: "auto",
      effectiveExecHost: "sandbox",
    });
  });

  it("disables Codex native execution when exec host resolves to node", () => {
    expect(
      resolveCodexNativeExecutionPolicy({
        config: { tools: { exec: { host: "node", node: "worker-1" } } },
        sessionKey: "session-1",
      }),
    ).toMatchObject({
      nativeToolSurfaceAllowed: false,
      requestedExecHost: "node",
      effectiveExecHost: "node",
      node: "worker-1",
    });
  });

  it("honors per-attempt node exec overrides before config defaults", () => {
    expect(
      resolveCodexNativeExecutionPolicy({
        config: { tools: { exec: { host: "gateway" } } },
        sessionKey: "session-1",
        execOverrides: { host: "node", node: "worker-2" },
      }),
    ).toMatchObject({
      nativeToolSurfaceAllowed: false,
      requestedExecHost: "node",
      effectiveExecHost: "node",
      node: "worker-2",
    });
  });

  it("honors persisted session node exec hosts before config defaults", () => {
    expect(
      resolveCodexNativeExecutionPolicy({
        config: { tools: { exec: { host: "gateway" } } },
        sessionKey: "session-1",
        sessionEntry: { execHost: "node", execNode: "worker-3" } as never,
      }),
    ).toMatchObject({
      nativeToolSurfaceAllowed: false,
      requestedExecHost: "node",
      effectiveExecHost: "node",
      node: "worker-3",
    });
  });

  it("honors persisted default-session exec hosts with explicit main agent policy", () => {
    sessionStoreMocks.getSessionEntry.mockReturnValue({
      sessionId: "session-1",
      updatedAt: 1,
      execHost: "node",
      execNode: "worker-5",
    });

    expect(
      resolveCodexNativeExecutionPolicy({
        config: { tools: { exec: { host: "gateway" } } },
        sessionKey: "main",
        agentId: "main",
        readRuntimeSessionEntry: true,
      }),
    ).toMatchObject({
      nativeToolSurfaceAllowed: false,
      requestedExecHost: "node",
      effectiveExecHost: "node",
      node: "worker-5",
    });
    expect(sessionStoreMocks.getSessionEntry).toHaveBeenCalledWith({
      sessionKey: "main",
      agentId: "main",
      hydrateSkillPromptRefs: false,
    });
  });

  it("honors persisted unscoped exec hosts for the configured default agent", () => {
    sessionStoreMocks.getSessionEntry.mockReturnValue({
      sessionId: "session-1",
      updatedAt: 1,
      execHost: "node",
      execNode: "worker-6",
    });

    expect(
      resolveCodexNativeExecutionPolicy({
        config: {
          tools: { exec: { host: "gateway" } },
          agents: { list: [{ id: "bot-a", default: true }] },
        },
        sessionKey: "node-session",
        agentId: "bot-a",
        readRuntimeSessionEntry: true,
      }),
    ).toMatchObject({
      nativeToolSurfaceAllowed: false,
      requestedExecHost: "node",
      effectiveExecHost: "node",
      node: "worker-6",
    });
    expect(sessionStoreMocks.getSessionEntry).toHaveBeenCalledWith({
      sessionKey: "node-session",
      agentId: "bot-a",
      hydrateSkillPromptRefs: false,
    });
  });

  it("honors agent exec config before global exec config", () => {
    expect(
      resolveCodexNativeExecutionPolicy({
        config: {
          tools: { exec: { host: "gateway" } },
          agents: { list: [{ id: "main", tools: { exec: { host: "node", node: "worker-4" } } }] },
        },
        sessionKey: "agent:main:session-1",
      }),
    ).toMatchObject({
      nativeToolSurfaceAllowed: false,
      requestedExecHost: "node",
      effectiveExecHost: "node",
      node: "worker-4",
    });
  });
});
