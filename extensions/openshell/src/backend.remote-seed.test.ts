// Covers the remote-mode seed obligation across a gateway restart: adopting an
// existing sandbox must probe the managed roots instead of trusting process
// memory, and must never re-seed roots that already hold content.
import fs from "node:fs/promises";
import path from "node:path";
import type { CreateSandboxBackendParams } from "openclaw/plugin-sdk/sandbox";
import {
  resolvePreferredOpenClawTmpDir,
  tempWorkspace,
  type TempWorkspace,
} from "openclaw/plugin-sdk/temp-path";
import {
  createSandboxBrowserConfig,
  createSandboxPruneConfig,
  createSandboxSshConfig,
} from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOpenShellSandboxBackendFactory } from "./backend.js";
import { resolveOpenShellPluginConfig } from "./config.js";

const sdkMocks = vi.hoisted(() => ({
  runSshSandboxCommand: vi.fn(),
  disposeSshSandboxSession: vi.fn(),
}));

const cliMocks = vi.hoisted(() => ({
  runOpenShellCli: vi.fn(),
  createOpenShellSshSession: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/sandbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/sandbox")>();
  return {
    ...actual,
    runSshSandboxCommand: sdkMocks.runSshSandboxCommand,
    disposeSshSandboxSession: sdkMocks.disposeSshSandboxSession,
  };
});

vi.mock("./cli.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./cli.js")>();
  return {
    ...actual,
    runOpenShellCli: cliMocks.runOpenShellCli,
    createOpenShellSshSession: cliMocks.createOpenShellSshSession,
  };
});

const tempWorkspaces: TempWorkspace[] = [];

function createOpenShellBackendSandboxConfig(): CreateSandboxBackendParams["cfg"] {
  return {
    mode: "all",
    backend: "openshell",
    scope: "session",
    workspaceAccess: "rw",
    workspaceRoot: "/tmp/openclaw-sandboxes",
    dockerTmpfsSource: "configured",
    docker: {
      image: "openclaw-sandbox:bookworm-slim",
      containerPrefix: "openclaw-sbx-",
      workdir: "/workspace",
      readOnlyRoot: false,
      tmpfs: [],
      network: "none",
      capDrop: [],
      binds: [],
      env: {},
    },
    ssh: createSandboxSshConfig("/tmp/openclaw-sandboxes"),
    browser: createSandboxBrowserConfig(),
    tools: { allow: ["*"], deny: [] },
    prune: createSandboxPruneConfig(),
  };
}

async function createAdoptedRemoteBackend(params: { probeStdout: string }) {
  const workspace = await tempWorkspace({
    rootDir: resolvePreferredOpenClawTmpDir(),
    prefix: "openclaw-openshell-remote-seed-",
  });
  tempWorkspaces.push(workspace);
  await fs.writeFile(path.join(workspace.dir, "seed.txt"), "seed", "utf8");
  cliMocks.createOpenShellSshSession.mockResolvedValue({
    command: "ssh",
    configPath: "/tmp/openclaw-openshell-test-ssh-config",
    host: "openshell-test",
  });
  // `sandbox get` succeeds: the sandbox was created by a previous gateway
  // process that died before the first exec could run the one-time seed.
  cliMocks.runOpenShellCli.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
  sdkMocks.runSshSandboxCommand.mockImplementation(async ({ remoteCommand }) => ({
    stdout: String(remoteCommand).includes("ls -A")
      ? Buffer.from(params.probeStdout)
      : Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    code: 0,
  }));
  const backendFactory = createOpenShellSandboxBackendFactory({
    pluginConfig: resolveOpenShellPluginConfig({
      command: "openshell",
      mode: "remote",
    }),
  });
  return await backendFactory({
    sessionKey: "agent:main:turn",
    scopeKey: "agent:main",
    workspaceDir: workspace.dir,
    agentWorkspaceDir: workspace.dir,
    cfg: createOpenShellBackendSandboxConfig(),
  });
}

function seedUploadCalls() {
  return cliMocks.runOpenShellCli.mock.calls.filter(
    ([params]) => params.args[0] === "sandbox" && params.args[1] === "upload",
  );
}

describe("openshell remote-mode seed across gateway restart", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await Promise.all(tempWorkspaces.splice(0).map((workspace) => workspace.cleanup()));
  });

  it("seeds an adopted sandbox whose managed roots are empty", async () => {
    const backend = await createAdoptedRemoteBackend({ probeStdout: "0\n" });

    await backend.buildExecSpec({ command: "pwd", env: {}, usePty: false });

    const uploads = seedUploadCalls();
    expect(uploads.length).toBeGreaterThan(0);
    expect(uploads[0]?.[0]).toMatchObject({
      args: expect.arrayContaining([expect.stringMatching(/\/seed\.txt$/), "/sandbox/"]),
    });
  });

  it("never re-seeds when a managed root already holds content", async () => {
    const backend = await createAdoptedRemoteBackend({ probeStdout: "1\n" });

    await backend.buildExecSpec({ command: "pwd", env: {}, usePty: false });

    expect(seedUploadCalls()).toHaveLength(0);
    const wipeCalls = sdkMocks.runSshSandboxCommand.mock.calls.filter(([params]) =>
      String(params.remoteCommand).includes("rm -rf"),
    );
    expect(wipeCalls).toHaveLength(0);
  });
});
