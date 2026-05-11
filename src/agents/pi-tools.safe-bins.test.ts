import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { ExecApprovalsResolved } from "../infra/exec-approvals.js";
import type { SafeBinProfileFixture } from "../infra/exec-safe-bin-policy.js";
import { withEnvAsync } from "../test-utils/env.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.js";

let createOpenClawCodingTools: typeof import("./pi-tools.js").createOpenClawCodingTools;

const { mockExecApprovals, supervisorSpawnMock } = vi.hoisted(() => {
  const execApprovals = {
    path: "/tmp/exec-approvals.json",
    socketPath: "/tmp/exec-approvals.sock",
    token: "token",
    defaults: {
      security: "allowlist",
      ask: "off",
      askFallback: "deny",
      autoAllowSkills: false,
    },
    agent: {
      security: "allowlist",
      ask: "off",
      askFallback: "deny",
      autoAllowSkills: false,
    },
    agentSources: {
      security: "defaults.security",
      ask: "defaults.ask",
      askFallback: "defaults.askFallback",
    },
    allowlist: [],
    file: {
      version: 1,
      socket: { path: "/tmp/exec-approvals.sock", token: "token" },
      defaults: {
        security: "allowlist",
        ask: "off",
        askFallback: "deny",
        autoAllowSkills: false,
      },
      agents: {},
    },
  };
  return {
    mockExecApprovals: execApprovals,
    supervisorSpawnMock: vi.fn(
      async (input: { argv?: string[]; onStdout?: (chunk: string) => void }) => {
        input.onStdout?.(`${input.argv?.join(" ") ?? ""}\n`);
        return {
          runId: "safe-bins-test-run",
          pid: 1234,
          startedAtMs: Date.now(),
          stdin: undefined,
          wait: async () => ({
            reason: "exit" as const,
            exitCode: 0,
            exitSignal: null,
            durationMs: 1,
            stdout: "",
            stderr: "",
            timedOut: false,
            noOutputTimedOut: false,
          }),
          cancel: vi.fn(),
        };
      },
    ),
  };
});

beforeAll(async () => {
  await withEnvAsync(
    {
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(os.tmpdir(), "openclaw-test-no-bundled-extensions"),
    },
    async () => {
      ({ createOpenClawCodingTools } = await import("./pi-tools.js"));
    },
  );
});

beforeEach(() => {
  supervisorSpawnMock.mockClear();
});

vi.mock("../infra/shell-env.js", async () => {
  const mod =
    await vi.importActual<typeof import("../infra/shell-env.js")>("../infra/shell-env.js");
  return {
    ...mod,
    getShellPathFromLoginShell: vi.fn(() => null),
    resolveShellEnvFallbackTimeoutMs: vi.fn(() => 50),
  };
});

vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({
    spawn: supervisorSpawnMock,
    cancel: vi.fn(),
    cancelScope: vi.fn(),
    reconcileOrphans: vi.fn(),
    getRecord: vi.fn(),
  }),
}));

vi.mock("./channel-tools.js", () => ({
  copyChannelAgentToolMeta: vi.fn((_from, to) => to),
  listChannelAgentTools: () => [],
}));

vi.mock("./openclaw-tools.js", () => ({
  createOpenClawTools: () => [],
}));

vi.mock("./bash-tools.exec-host-shared.js", async () => {
  const mod = await vi.importActual<typeof import("./bash-tools.exec-host-shared.js")>(
    "./bash-tools.exec-host-shared.js",
  );
  return {
    ...mod,
    resolveExecHostApprovalContext: () => ({
      approvals: mockExecApprovals,
      hostSecurity: "allowlist",
      hostAsk: "off",
      askFallback: "deny",
    }),
  };
});

vi.mock("../plugins/tools.js", () => ({
  copyPluginToolMeta: vi.fn((_from, to) => to),
  resolvePluginTools: () => [],
  getPluginToolMeta: () => undefined,
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  AuthStorage: vi.fn(),
  CURRENT_SESSION_VERSION: 1,
  ModelRegistry: vi.fn(),
  SessionManager: vi.fn(),
  SettingsManager: vi.fn(),
  createCodingTools: vi.fn(() => []),
  createEditTool: vi.fn(),
  createReadTool: vi.fn(),
  createWriteTool: vi.fn(),
  estimateTokens: vi.fn(() => 0),
  formatSkillsForPrompt: vi.fn(() => ""),
}));

vi.mock("../infra/exec-approvals.js", async () => {
  const mod = await vi.importActual<typeof import("../infra/exec-approvals.js")>(
    "../infra/exec-approvals.js",
  );
  const approvals = mockExecApprovals as ExecApprovalsResolved;
  return {
    ...mod,
    loadExecApprovals: () => approvals.file,
    resolveExecApprovals: () => approvals,
  };
});

type ExecToolResult = {
  content: Array<{ type: string; text?: string }>;
  details?: { status?: string };
};

type ExecTool = {
  execute(
    callId: string,
    params: {
      command: string;
      workdir: string;
      env?: Record<string, string>;
    },
  ): Promise<ExecToolResult>;
};

async function createSafeBinsExecTool(params: {
  tmpPrefix: string;
  safeBins: string[];
  safeBinProfiles?: Record<string, SafeBinProfileFixture>;
  files?: Array<{ name: string; contents: string }>;
}): Promise<{ tmpDir: string; execTool: ExecTool }> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), params.tmpPrefix));
  for (const file of params.files ?? []) {
    fs.writeFileSync(path.join(tmpDir, file.name), file.contents, "utf8");
  }

  const cfg: OpenClawConfig = {
    tools: {
      exec: {
        host: "gateway",
        security: "allowlist",
        ask: "off",
        safeBins: params.safeBins,
        safeBinProfiles: params.safeBinProfiles,
      },
    },
  };

  const tools = createOpenClawCodingTools({
    config: cfg,
    exec: {
      notifyOnExit: false,
    },
    sessionKey: "agent:main:main",
    workspaceDir: tmpDir,
    agentDir: path.join(tmpDir, "agent"),
  });
  const execTool = tools.find((tool) => tool.name === "exec");
  if (!execTool) {
    throw new Error("exec tool missing from coding tools");
  }
  return { tmpDir, execTool: execTool as ExecTool };
}

async function withSafeBinsExecTool(
  params: Parameters<typeof createSafeBinsExecTool>[0],
  run: (ctx: Awaited<ReturnType<typeof createSafeBinsExecTool>>) => Promise<void>,
) {
  if (process.platform === "win32") {
    return;
  }
  const ctx = await createSafeBinsExecTool(params);
  try {
    await withEnvAsync(
      {
        OPENCLAW_SHELL_ENV_TIMEOUT_MS: "1",
        PATH: "/usr/bin:/bin",
        SHELL: "/bin/sh",
      },
      async () => {
        await run(ctx);
      },
    );
  } finally {
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
    resetProcessRegistryForTests();
  }
}

describe("createOpenClawCodingTools safeBins", () => {
  it("threads tools.exec.safeBins into exec allowlist checks", async () => {
    await withSafeBinsExecTool(
      {
        tmpPrefix: "openclaw-safe-bins-",
        safeBins: ["echo"],
        safeBinProfiles: {
          echo: { maxPositional: 1 },
        },
      },
      async ({ tmpDir, execTool }) => {
        const marker = `safe-bins-${Date.now()}`;
        const result = await execTool.execute("call1", {
          command: `echo ${marker}`,
          workdir: tmpDir,
        });
        const text = result.content.find((content) => content.type === "text")?.text ?? "";

        const resultDetails = result.details as { status?: string };
        expect(resultDetails.status).toBe("completed");
        expect(text).toContain(marker);
        expect(supervisorSpawnMock).toHaveBeenCalledOnce();
      },
    );
  });

  it("rejects unprofiled custom safe-bin entries", async () => {
    await withSafeBinsExecTool(
      {
        tmpPrefix: "openclaw-safe-bins-unprofiled-",
        safeBins: ["echo"],
      },
      async ({ tmpDir, execTool }) => {
        await expect(
          execTool.execute("call1", {
            command: "echo hello",
            workdir: tmpDir,
          }),
        ).rejects.toThrow("exec denied: allowlist miss");
      },
    );
  });

  it("does not allow env var expansion to smuggle file args via safeBins", async () => {
    await withSafeBinsExecTool(
      {
        tmpPrefix: "openclaw-safe-bins-expand-",
        safeBins: ["head", "wc"],
        files: [{ name: "secret.txt", contents: "TOP_SECRET\n" }],
      },
      async ({ tmpDir, execTool }) => {
        await expect(
          execTool.execute("call1", {
            command: "head $FOO ; wc -l",
            workdir: tmpDir,
            env: { FOO: "secret.txt" },
          }),
        ).rejects.toThrow("exec denied: allowlist miss");
      },
    );
  });

  it("blocks sort output/compress bypass attempts in safeBins mode", async () => {
    await withSafeBinsExecTool(
      {
        tmpPrefix: "openclaw-safe-bins-sort-",
        safeBins: ["sort"],
        files: [{ name: "existing.txt", contents: "x\n" }],
      },
      async ({ tmpDir, execTool }) => {
        const run = async (command: string) => {
          try {
            const result = await execTool.execute("call-oracle", { command, workdir: tmpDir });
            const text = result.content.find((content) => content.type === "text")?.text ?? "";
            const resultDetails = result.details as { status?: string };
            return { kind: "result" as const, status: resultDetails.status, text };
          } catch (err) {
            return { kind: "error" as const, message: String(err) };
          }
        };

        const existing = await run("sort -o existing.txt");
        const missing = await run("sort -o missing.txt");
        expect(existing).toEqual(missing);

        const outputFlagCases = [
          { command: "sort -oblocked-short.txt", target: "blocked-short.txt" },
          { command: "sort --output=blocked-long.txt", target: "blocked-long.txt" },
        ] as const;
        for (const [index, testCase] of outputFlagCases.entries()) {
          await expect(
            execTool.execute(`call-output-${index + 1}`, {
              command: testCase.command,
              workdir: tmpDir,
            }),
          ).rejects.toThrow("exec denied: allowlist miss");
          expect(fs.existsSync(path.join(tmpDir, testCase.target))).toBe(false);
        }

        await expect(
          execTool.execute("call1", {
            command: "sort --compress-program=sh",
            workdir: tmpDir,
          }),
        ).rejects.toThrow("exec denied: allowlist miss");
      },
    );
  });

  it("blocks shell redirection metacharacters in safeBins mode", async () => {
    await withSafeBinsExecTool(
      {
        tmpPrefix: "openclaw-safe-bins-redirect-",
        safeBins: ["head"],
        files: [{ name: "source.txt", contents: "line1\nline2\n" }],
      },
      async ({ tmpDir, execTool }) => {
        await expect(
          execTool.execute("call1", {
            command: "head -n 1 source.txt > blocked-redirect.txt",
            workdir: tmpDir,
          }),
        ).rejects.toThrow("exec denied: allowlist miss");
        expect(fs.existsSync(path.join(tmpDir, "blocked-redirect.txt"))).toBe(false);
      },
    );
  });

  it("blocks grep recursive flags from reading cwd via safeBins", async () => {
    await withSafeBinsExecTool(
      {
        tmpPrefix: "openclaw-safe-bins-grep-",
        safeBins: ["grep"],
        files: [{ name: "secret.txt", contents: "SAFE_BINS_RECURSIVE_SHOULD_NOT_LEAK\n" }],
      },
      async ({ tmpDir, execTool }) => {
        await expect(
          execTool.execute("call1", {
            command: "grep -R SAFE_BINS_RECURSIVE_SHOULD_NOT_LEAK",
            workdir: tmpDir,
          }),
        ).rejects.toThrow("exec denied: allowlist miss");
      },
    );
  });
});
