import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type {
  SandboxEnvironmentCapabilityRootConfig,
  SandboxEnvironmentMcpServerRequirement,
} from "../../config/types.agents-shared.js";
import * as logger from "../../logger.js";
import { OpenClawStdioClientTransport } from "../mcp-stdio-transport.js";
import type { SandboxBackendExecSpec, SandboxBackendHandle } from "./backend-handle.types.js";
import type { SandboxEnvironmentCapabilityDiscovery } from "./environment-capabilities.js";
import {
  collectDiscoveredSandboxMcpServers,
  createSandboxEnvironmentMcpToolRuntime,
} from "./environment-mcp.js";

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
  const validateWorkdir = vi.fn<NonNullable<SandboxBackendHandle["validateWorkdir"]>>(
    async (cwd) => cwd,
  );
  const buildExecSpec = vi.fn<SandboxBackendHandle["buildExecSpec"]>(async () => execSpec());
  return {
    id: "test",
    runtimeId: "sandbox-1",
    runtimeLabel: "sandbox-1",
    workdir: "/sandbox",
    validateWorkdir,
    buildExecSpec,
    discardPreparedWorkdir: vi.fn(),
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
  server: {
    command?: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    connectionTimeoutMs?: number;
  } = {},
  signal?: AbortSignal,
  authorizationServer?: SandboxEnvironmentMcpServerRequirement | null,
  readCurrentCapabilityRoots?: () => readonly SandboxEnvironmentCapabilityRootConfig[],
) {
  const declaration = {
    command: "remote-mcp",
    args: ["--serve"],
    ...server,
  };
  const defaultRequirement: SandboxEnvironmentMcpServerRequirement = {
    command: declaration.command,
    args: declaration.args,
    ...(typeof declaration.cwd === "string" ? { cwd: declaration.cwd } : {}),
    ...(declaration.env && typeof declaration.env === "object" ? { env: declaration.env } : {}),
  };
  const requirement = authorizationServer === undefined ? defaultRequirement : authorizationServer;
  const discovery: SandboxEnvironmentCapabilityDiscovery = {
    id: "workspace",
    path: "/sandbox",
    mcpConfig: {
      path: "/sandbox/.mcp.json",
      contents: JSON.stringify({
        mcpServers: { remote: declaration },
      }),
    },
    ...(requirement
      ? {
          mcpAuthorizations: [
            {
              selectionId: "project-tools",
              backendId: backend.id,
              runtimeId: backend.runtimeId,
              rootPath: backend.workdir,
              mcpServers: { remote: requirement },
            },
          ],
        }
      : {}),
  };
  return await createSandboxEnvironmentMcpToolRuntime({
    backend,
    servers: collectDiscoveredSandboxMcpServers([discovery], backend),
    sessionId: "session-1",
    workspaceDir: "/sandbox",
    signal,
    readCurrentCapabilityRoots:
      readCurrentCapabilityRoots ??
      (() =>
        requirement
          ? [
              {
                id: "project-tools",
                location: { type: "workspace" },
                mcpServers: { remote: requirement },
              },
            ]
          : []),
  });
}

afterEach(() => vi.restoreAllMocks());

describe("sandbox environment MCP", () => {
  it("does not start a workspace server without explicit source authorization", async () => {
    const backend = createBackend();
    const start = vi.spyOn(OpenClawStdioClientTransport.prototype, "start");
    const send = vi.spyOn(OpenClawStdioClientTransport.prototype, "send");
    const runtime = await createRuntime(backend, {}, undefined, null);
    expect(runtime).toBeUndefined();
    expect(backend.validateWorkdir).not.toHaveBeenCalled();
    expect(backend.buildExecSpec).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(backend.runShellCommand).not.toHaveBeenCalled();
    expect(backend.finalizeExec).not.toHaveBeenCalled();
  });

  it.each([
    ["command", { command: "other", args: ["--serve"] }],
    ["args", { command: "remote-mcp", args: ["--other"] }],
    ["cwd", { command: "remote-mcp", args: ["--serve"], cwd: "other" }],
    ["env", { command: "remote-mcp", args: ["--serve"], env: { MODE: "other" } }],
  ])("does not start when the authorized %s differs", async (_field, requirement) => {
    const backend = createBackend();
    const runtime = await createRuntime(backend, {}, undefined, requirement);
    expect(runtime).toBeUndefined();
    expect(backend.validateWorkdir).not.toHaveBeenCalled();
    expect(backend.buildExecSpec).not.toHaveBeenCalled();
  });

  it.each([
    ["backend", { backendId: "other" }],
    ["runtime", { runtimeId: "other" }],
    ["root", { rootPath: "/other" }],
  ])("rejects an authorization bound to a different %s", async (_field, override) => {
    const backend = createBackend();
    const discovery: SandboxEnvironmentCapabilityDiscovery = {
      id: "workspace",
      path: "/sandbox",
      mcpConfig: {
        path: "/sandbox/.mcp.json",
        contents: JSON.stringify({
          mcpServers: { remote: { command: "remote-mcp", args: ["--serve"] } },
        }),
      },
      mcpAuthorizations: [
        {
          selectionId: "project-tools",
          backendId: backend.id,
          runtimeId: backend.runtimeId,
          rootPath: backend.workdir,
          mcpServers: { remote: { command: "remote-mcp", args: ["--serve"] } },
          ...override,
        },
      ],
    };
    expect(collectDiscoveredSandboxMcpServers([discovery], backend).size).toBe(0);
    expect(backend.validateWorkdir).not.toHaveBeenCalled();
    expect(backend.buildExecSpec).not.toHaveBeenCalled();
  });

  it("revalidates the frozen declaration immediately before transport construction", async () => {
    const backend = createBackend();
    const discovery: SandboxEnvironmentCapabilityDiscovery = {
      id: "workspace",
      path: "/sandbox",
      mcpConfig: {
        path: "/sandbox/.mcp.json",
        contents: JSON.stringify({
          mcpServers: { remote: { command: "remote-mcp", args: ["--serve"] } },
        }),
      },
      mcpAuthorizations: [
        {
          selectionId: "project-tools",
          backendId: backend.id,
          runtimeId: backend.runtimeId,
          rootPath: backend.workdir,
          mcpServers: { remote: { command: "remote-mcp", args: ["--serve"] } },
        },
      ],
    };
    const servers = collectDiscoveredSandboxMcpServers([discovery], backend);
    const remote = servers.get("remote");
    expect(remote).toBeDefined();
    if (!remote) {
      throw new Error("missing authorized MCP fixture");
    }
    remote.config.command = "other";

    const runtime = await createSandboxEnvironmentMcpToolRuntime({
      backend,
      servers,
      sessionId: "session-1",
      workspaceDir: "/sandbox",
      readCurrentCapabilityRoots: () => [
        {
          id: "project-tools",
          location: { type: "workspace" },
          mcpServers: { remote: { command: "remote-mcp", args: ["--serve"] } },
        },
      ],
    });
    await runtime?.dispose();
    expect(backend.validateWorkdir).not.toHaveBeenCalled();
    expect(backend.buildExecSpec).not.toHaveBeenCalled();
  });

  it.each(["validateWorkdir", "buildExecSpec"] as const)(
    "does not launch when authorization is revoked during %s",
    async (phase) => {
      const backend = createBackend();
      const validatedWorkdir = createDeferred<string | null>();
      const preparedExec = createDeferred<SandboxBackendExecSpec>();
      if (phase === "validateWorkdir") {
        backend.validateWorkdir.mockReturnValue(validatedWorkdir.promise);
      } else {
        backend.buildExecSpec.mockReturnValue(preparedExec.promise);
      }
      const requirement = { command: "remote-mcp", args: ["--serve"] };
      let capabilityRoots: SandboxEnvironmentCapabilityRootConfig[] = [
        {
          id: "project-tools",
          location: { type: "workspace" },
          mcpServers: { remote: requirement },
        },
      ];
      const start = vi.spyOn(OpenClawStdioClientTransport.prototype, "start");
      const pending = createRuntime(backend, {}, undefined, requirement, () => capabilityRoots);
      await vi.waitFor(() => expect(backend[phase]).toHaveBeenCalledOnce());
      capabilityRoots = [];
      if (phase === "validateWorkdir") {
        validatedWorkdir.resolve("/sandbox");
      } else {
        preparedExec.resolve(execSpec());
      }

      const runtime = await pending;
      try {
        expect(runtime?.tools).toEqual([]);
        expect(runtime?.diagnostics).toEqual([
          expect.objectContaining({ message: "Sandbox MCP startup authorization was revoked" }),
        ]);
        expect(start).not.toHaveBeenCalled();
        if (phase === "validateWorkdir") {
          expect(backend.buildExecSpec).not.toHaveBeenCalled();
          expect(backend.discardPreparedWorkdir).toHaveBeenCalledWith("/sandbox");
          expect(backend.finalizeExec).not.toHaveBeenCalled();
        } else {
          expect(backend.finalizeExec).toHaveBeenCalledOnce();
        }
      } finally {
        await runtime?.dispose();
      }
    },
  );

  it("does not reconnect an exited server after authorization is revoked", async () => {
    const backend = createBackend();
    const requirement = { command: "remote-mcp", args: ["--serve"] };
    let capabilityRoots: SandboxEnvironmentCapabilityRootConfig[] = [
      {
        id: "project-tools",
        location: { type: "workspace" },
        mcpServers: { remote: requirement },
      },
    ];
    const start = vi.spyOn(OpenClawStdioClientTransport.prototype, "start");
    const warning = vi.spyOn(logger, "logWarn").mockImplementation(() => {});
    const runtime = await createRuntime(backend, {}, undefined, requirement, () => capabilityRoots);
    try {
      const tool = expectDefined(
        runtime?.tools.find((entry) => entry.name.includes("parity_probe")),
        "sandbox MCP parity tool",
      );
      await tool.execute("crash", { marker: "crash-generation" });
      capabilityRoots = [];
      await vi.waitFor(
        () =>
          expect(warning).toHaveBeenCalledWith(
            expect.stringContaining('server "remote" closed; next request reconnects'),
          ),
        { timeout: 2_000 },
      );
      await expect(tool.execute("retry", { marker: "after-revocation" })).rejects.toThrow();
      expect(backend.buildExecSpec).toHaveBeenCalledOnce();
      expect(start).toHaveBeenCalledOnce();
    } finally {
      await runtime?.dispose();
    }
  });

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
          expectDefined(
            backend.buildExecSpec.mock.invocationCallOrder[0],
            "buildExecSpec invocation order",
          ),
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
