import { describe, expect, it } from "vitest";
import { resolveCodexNativeExecutionPolicy } from "./native-execution-policy.js";

describe("resolveCodexNativeExecutionPolicy", () => {
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
