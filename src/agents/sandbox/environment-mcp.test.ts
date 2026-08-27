import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { SandboxBackendHandle } from "./backend-handle.types.js";
import { createSandboxEnvironmentMcpToolRuntime } from "./environment-mcp.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const fixture = path.join(repoRoot, "test/e2e/qa-lab/runtime/gateway-node-mcp.fixture.mjs");

describe("sandbox environment MCP", () => {
  it("launches discovered stdio MCP through the owning backend and finalizes it", async () => {
    const buildExecSpec = vi.fn(async () => ({
      argv: [process.execPath, fixture, "stdio", "--label", "sandbox"],
      env: process.env,
      stdinMode: "pipe-open" as const,
      finalizeToken: "lease-1",
    }));
    const finalizeExec = vi.fn(async () => undefined);
    const backend: SandboxBackendHandle = {
      id: "test",
      runtimeId: "sandbox-1",
      runtimeLabel: "sandbox-1",
      workdir: "/sandbox",
      buildExecSpec,
      finalizeExec,
      runShellCommand: vi.fn(async () => ({
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        code: 0,
      })),
    };

    const runtime = await createSandboxEnvironmentMcpToolRuntime({
      backend,
      discoveries: [
        {
          id: "workspace",
          path: "/sandbox",
          mcpConfig: {
            path: "/sandbox/.mcp.json",
            contents: JSON.stringify({
              mcpServers: { remote: { command: "remote-mcp", args: ["--serve"] } },
            }),
          },
        },
      ],
      sessionId: "session-1",
      workspaceDir: "/sandbox",
    });

    expect(runtime?.tools.some((tool) => tool.name.includes("parity_probe"))).toBe(true);
    expect(buildExecSpec).toHaveBeenCalledWith({
      command: "'remote-mcp' '--serve'",
      workdir: "/sandbox",
      env: {},
      usePty: false,
    });

    await runtime?.dispose();
    expect(finalizeExec).toHaveBeenCalledOnce();
    expect(finalizeExec).toHaveBeenCalledWith({
      status: "completed",
      exitCode: null,
      timedOut: false,
      token: "lease-1",
    });
  });
});
