// Sbx tests cover backend plugin behavior.
import {
  createSandboxBrowserConfig,
  createSandboxPruneConfig,
  createSandboxSshConfig,
} from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSbxSandboxName } from "./cli.js";

const cliMocks = vi.hoisted(() => ({
  findSbxSandboxByName: vi.fn(),
  runSbxCli: vi.fn(),
}));

vi.mock("./cli.js", async () => {
  const actual = await vi.importActual<typeof import("./cli.js")>("./cli.js");
  return {
    ...actual,
    findSbxSandboxByName: cliMocks.findSbxSandboxByName,
    runSbxCli: cliMocks.runSbxCli,
  };
});

const { createSbxSandboxBackendFactory } = await import("./backend.js");
const { resolveSbxPluginConfig } = await import("./config.js");

function buildSandboxCfg(overrides: { workspaceAccess?: "none" | "ro" | "rw" } = {}) {
  return {
    mode: "all" as const,
    backend: "sbx" as const,
    scope: "session" as const,
    workspaceAccess: overrides.workspaceAccess ?? "rw",
    workspaceRoot: "/tmp/openclaw-sandboxes",
    docker: {
      image: "openclaw-sandbox:bookworm-slim",
      containerPrefix: "openclaw-sbx-",
      workdir: "/workspace",
      readOnlyRoot: true,
      tmpfs: ["/tmp"],
      network: "none" as const,
      capDrop: ["ALL"],
      env: {},
    },
    ssh: createSandboxSshConfig("/tmp/openclaw-sandboxes"),
    browser: createSandboxBrowserConfig(),
    tools: { allow: [], deny: [] },
    prune: createSandboxPruneConfig(),
  };
}

describe("sbx sandbox names", () => {
  it("generates sbx-safe names from OpenClaw session scope keys", () => {
    const name = buildSbxSandboxName("agent:somalley_alice:dashboard-8");

    expect(name).toMatch(/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/);
    expect(name).toContain("somalley-alice");
    expect(name).not.toContain("_");
    expect(name.length).toBeLessThanOrEqual(63);
  });

  it("falls back to a stable default for blank scope keys", () => {
    const name = buildSbxSandboxName("   ");
    expect(name).toMatch(/^openclaw-session-[0-9a-f]+$/);
  });
});

describe("sbx backend", () => {
  afterEach(() => {
    cliMocks.findSbxSandboxByName.mockReset();
    cliMocks.runSbxCli.mockReset();
  });

  it("builds exec args with workdir, env, and a login shell command", async () => {
    cliMocks.findSbxSandboxByName.mockResolvedValue({ name: "existing", status: "running" });
    const factory = createSbxSandboxBackendFactory({
      pluginConfig: resolveSbxPluginConfig(undefined),
    });
    const backend = await factory({
      sessionKey: "session:test:1",
      scopeKey: "session:test:1",
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/workspace",
      cfg: buildSandboxCfg(),
    });

    const execSpec = await backend.buildExecSpec({
      command: "echo hi",
      env: { FOO: "bar" },
      usePty: false,
    });

    expect(execSpec.argv).toEqual([
      "sbx",
      "exec",
      "-i",
      "-w",
      "/tmp/workspace",
      "-e",
      "FOO=bar",
      backend.runtimeId,
      "/bin/sh",
      "-lc",
      "echo hi",
    ]);
    expect(execSpec.stdinMode).toBe("pipe-open");
    expect(cliMocks.runSbxCli).not.toHaveBeenCalled();
  });

  it("allocates a pty and prepends the custom PATH when requested", async () => {
    cliMocks.findSbxSandboxByName.mockResolvedValue({ name: "existing", status: "running" });
    const factory = createSbxSandboxBackendFactory({
      pluginConfig: resolveSbxPluginConfig(undefined),
    });
    const backend = await factory({
      sessionKey: "session:test:2",
      scopeKey: "session:test:2",
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/workspace",
      cfg: buildSandboxCfg(),
    });

    const execSpec = await backend.buildExecSpec({
      command: "echo hi",
      env: { PATH: "/custom/bin" },
      usePty: true,
    });

    expect(execSpec.argv).toEqual([
      "sbx",
      "exec",
      "-i",
      "-t",
      "-w",
      "/tmp/workspace",
      "-e",
      "OPENCLAW_PREPEND_PATH=/custom/bin",
      backend.runtimeId,
      "/bin/sh",
      "-lc",
      'export PATH="${OPENCLAW_PREPEND_PATH}:$PATH"; unset OPENCLAW_PREPEND_PATH; echo hi',
    ]);
  });

  it("creates the sandbox with a read-only workspace mount when the sandbox is missing", async () => {
    cliMocks.findSbxSandboxByName.mockResolvedValue(null);
    cliMocks.runSbxCli.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const factory = createSbxSandboxBackendFactory({
      pluginConfig: resolveSbxPluginConfig(undefined),
    });
    const backend = await factory({
      sessionKey: "session:test:3",
      scopeKey: "session:test:3",
      workspaceDir: "/tmp/workspace",
      agentWorkspaceDir: "/tmp/workspace",
      cfg: buildSandboxCfg({ workspaceAccess: "ro" }),
    });

    await backend.buildExecSpec({ command: "echo hi", env: {}, usePty: false });

    expect(cliMocks.runSbxCli).toHaveBeenCalledTimes(1);
    const call = cliMocks.runSbxCli.mock.calls[0]?.[0];
    expect(call.args).toEqual([
      "create",
      "shell",
      "/tmp/workspace:ro",
      "--name",
      backend.runtimeId,
      "--pull",
      "missing",
    ]);
  });
});
