import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as logger from "../../logger.js";
import { OpenClawStdioClientTransport } from "../mcp-stdio-transport.js";
import type { SandboxBackendExecSpec, SandboxBackendHandle } from "./backend-handle.types.js";
import { createSandboxEnvironmentMcpToolRuntime } from "./environment-mcp.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const fixture = path.join(repoRoot, "test/e2e/qa-lab/runtime/gateway-node-mcp.fixture.mjs");
function execSpec(): SandboxBackendExecSpec {
  return {
    argv: [process.execPath, fixture, "stdio", "--label", "sandbox"],
    env: process.env,
    stdinMode: "pipe-open",
    finalizeToken: "lease-1",
  };
}
function createBackend() {
  return {
    id: "test",
    runtimeId: "sandbox-1",
    runtimeLabel: "sandbox-1",
    workdir: "/sandbox",
    validateWorkdir: vi.fn(async (cwd: string) => cwd as string | null),
    buildExecSpec: vi.fn(async () => execSpec()),
    finalizeExec: vi.fn(async () => undefined),
    runShellCommand: vi.fn(async () => ({
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      code: 0,
    })),
  } satisfies SandboxBackendHandle;
}
async function createRuntime(
  backend: SandboxBackendHandle,
  server: Record<string, unknown> = {},
  signal?: AbortSignal,
) {
  return await createSandboxEnvironmentMcpToolRuntime({
    backend,
    discoveries: [
      {
        id: "workspace",
        path: "/sandbox",
        mcpConfig: {
          path: "/sandbox/.mcp.json",
          contents: JSON.stringify({
            mcpServers: { remote: { command: "remote-mcp", args: ["--serve"], ...server } },
          }),
        },
      },
    ],
    sessionId: "session-1",
    workspaceDir: "/sandbox",
    signal,
  });
}

afterEach(() => vi.restoreAllMocks());

describe("sandbox environment MCP", () => {
  it("launches discovered stdio MCP through the owning backend and finalizes it", async () => {
    const backend = createBackend();
    const runtime = await createRuntime(backend);
    try {
      expect(runtime?.tools.some((tool) => tool.name.includes("parity_probe"))).toBe(true);
      expect(backend.buildExecSpec).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "'remote-mcp' '--serve'",
          workdir: "/sandbox",
          usePty: false,
        }),
      );
    } finally {
      await runtime?.dispose();
    }
    expect(backend.finalizeExec).toHaveBeenCalledOnce();
    expect(backend.finalizeExec).toHaveBeenCalledWith(
      expect.objectContaining({ token: "lease-1" }),
    );
  });

  it.each(["tools", "./tools", "/sandbox/tools"])(
    "resolves and validates cwd %s before launch",
    async (cwd) => {
      const backend = createBackend();
      const runtime = await createRuntime(backend, { cwd });
      try {
        expect(backend.validateWorkdir).toHaveBeenCalledWith("/sandbox/tools");
        expect(backend.buildExecSpec).toHaveBeenCalledWith(
          expect.objectContaining({ workdir: "/sandbox/tools" }),
        );
        expect(backend.validateWorkdir.mock.invocationCallOrder[0]).toBeLessThan(
          backend.buildExecSpec.mock.invocationCallOrder[0],
        );
      } finally {
        await runtime?.dispose();
      }
    },
  );

  it.each(["/outside", "../outside", "/sandbox-alias"])(
    "rejects escaping cwd %s without launching",
    async (cwd) => {
      const backend = createBackend();
      const runtime = await createRuntime(backend, { cwd });
      try {
        expect(backend.buildExecSpec).not.toHaveBeenCalled();
        expect(runtime?.tools ?? []).toEqual([]);
        expect(runtime?.diagnostics?.length).toBeGreaterThan(0);
      } finally {
        await runtime?.dispose();
      }
    },
  );

  it.each([null, "/outside"])(
    "rejects a symlink cwd rejected or canonicalized outside by the backend: %s",
    async (validated) => {
      const backend = createBackend();
      backend.validateWorkdir.mockResolvedValue(validated);
      const runtime = await createRuntime(backend, { cwd: "linked" });
      try {
        expect(backend.buildExecSpec).not.toHaveBeenCalled();
        expect(runtime?.tools ?? []).toEqual([]);
      } finally {
        await runtime?.dispose();
      }
    },
  );

  it.each(["closed stdin", "empty argv"])(
    "finalizes a prepared lease after %s rejection",
    async (invalid) => {
      const backend = createBackend();
      backend.buildExecSpec.mockResolvedValue({
        ...execSpec(),
        ...(invalid === "closed stdin" ? { stdinMode: "pipe-closed" as const } : { argv: [] }),
      });
      const runtime = await createRuntime(backend);
      await runtime?.dispose();
      expect(backend.finalizeExec).toHaveBeenCalledOnce();
      expect(backend.finalizeExec).toHaveBeenCalledWith(
        expect.objectContaining({ status: "failed", token: "lease-1" }),
      );
    },
  );

  it("does not launch after connection timeout and finalizes the late preparation exactly once", async () => {
    const backend = createBackend();
    let release!: (spec: SandboxBackendExecSpec) => void;
    backend.buildExecSpec.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const start = vi.spyOn(OpenClawStdioClientTransport.prototype, "start").mockResolvedValue();
    const runtime = await createRuntime(backend, { connectionTimeoutMs: 30 });
    await runtime?.dispose();
    release(execSpec());
    await setImmediate();
    await vi.waitFor(() =>
      expect(backend.finalizeExec).toHaveBeenCalledWith(
        expect.objectContaining({ token: "lease-1" }),
      ),
    );
    expect(start).not.toHaveBeenCalled();
    expect(backend.finalizeExec).toHaveBeenCalledOnce();
  });

  it("drains stderr while initializing a verbose server", async () => {
    const backend = createBackend();
    const bootstrap =
      "process.argv = " +
      JSON.stringify([process.execPath, fixture, "stdio"]) +
      "; process.stderr.write('x'.repeat(512 * 1024), () => import(" +
      JSON.stringify(pathToFileURL(fixture).href) +
      "));";
    backend.buildExecSpec.mockResolvedValue({
      ...execSpec(),
      argv: [process.execPath, "-e", bootstrap],
    });
    const runtime = await createRuntime(backend, { connectionTimeoutMs: 2000 });
    try {
      expect(runtime?.tools.some((tool) => tool.name.includes("parity_probe"))).toBe(true);
    } finally {
      await runtime?.dispose();
    }
  });
  it("cancels an attempt during backend preparation without launching afterward", async () => {
    const backend = createBackend();
    const controller = new AbortController();
    let release!: (spec: SandboxBackendExecSpec) => void;
    backend.buildExecSpec.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const start = vi.spyOn(OpenClawStdioClientTransport.prototype, "start").mockResolvedValue();
    const pending = createRuntime(backend, { connectionTimeoutMs: 100 }, controller.signal);
    const rejected = expect(pending).rejects.toThrow(/aborted/i);
    await vi.waitFor(() => expect(backend.buildExecSpec).toHaveBeenCalledOnce());
    controller.abort();
    await rejected;
    release(execSpec());
    await vi.waitFor(() =>
      expect(backend.finalizeExec).toHaveBeenCalledWith(
        expect.objectContaining({ token: "lease-1" }),
      ),
    );
    expect(start).not.toHaveBeenCalled();
    expect(backend.finalizeExec).toHaveBeenCalledOnce();
  });

  it("releases abandoned cwd preparation when abort arrives during validation", async () => {
    const backend = { ...createBackend(), discardPreparedWorkdir: vi.fn() };
    const controller = new AbortController();
    let release!: (cwd: string) => void;
    backend.validateWorkdir.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = createRuntime(backend, { connectionTimeoutMs: 100 }, controller.signal);
    const rejected = expect(pending).rejects.toThrow(/aborted/i);
    await vi.waitFor(() => expect(backend.validateWorkdir).toHaveBeenCalledOnce());
    controller.abort();
    await rejected;
    release("/sandbox");
    await vi.waitFor(() => expect(backend.discardPreparedWorkdir).toHaveBeenCalledWith("/sandbox"));
    expect(backend.buildExecSpec).not.toHaveBeenCalled();
    expect(backend.finalizeExec).not.toHaveBeenCalled();
  });
  it("records remote cleanup failure without losing the backend lease", async () => {
    const backend = createBackend();
    const warning = vi.spyOn(logger, "logWarn").mockImplementation(() => {});
    const runtime = await createRuntime(backend);
    backend.runShellCommand.mockResolvedValue({
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      code: 1,
    });
    await runtime?.dispose();
    expect(backend.finalizeExec).toHaveBeenCalledOnce();
    expect(backend.finalizeExec).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", token: "lease-1" }),
    );
    expect(warning).toHaveBeenCalledWith(
      "Sandbox MCP finalization failed; recreate the sandbox and inspect remaining processes.",
    );
  });
});
