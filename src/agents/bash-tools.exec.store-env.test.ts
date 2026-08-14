/** Store-backed exec environment tests cover run snapshots, precedence, and security filtering. */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeSecretStoreEntry } from "../secrets/store/secret-store.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv } from "../test-utils/env.js";
import type { BashSandboxConfig } from "./bash-tools.shared.js";

const mocks = vi.hoisted(() => ({
  gatewayParams: [] as Array<{
    env: Record<string, string>;
    requestedEnv?: Record<string, string>;
  }>,
  spawnInputs: [] as Array<{ env?: Record<string, string> }>,
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => null,
  getGlobalHookRunnerRegistry: () => null,
}));

vi.mock("../infra/shell-env.js", () => ({
  getShellEnvAppliedKeys: vi.fn(() => []),
  getShellPathFromLoginShell: vi.fn(() => null),
  resolveShellEnvFallbackTimeoutMs: vi.fn(() => 0),
  shouldDeferShellEnvFallback: vi.fn(() => false),
  shouldEnableShellEnvFallback: vi.fn(() => false),
}));

vi.mock("./bash-tools.exec-host-gateway.js", () => ({
  processGatewayAllowlist: vi.fn(
    async (params: { env: Record<string, string>; requestedEnv?: Record<string, string> }) => {
      mocks.gatewayParams.push({
        env: { ...params.env },
        requestedEnv: params.requestedEnv ? { ...params.requestedEnv } : undefined,
      });
      return {};
    },
  ),
}));

vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({
    spawn: async (input: { env?: Record<string, string>; onStdout?: (chunk: string) => void }) => {
      mocks.spawnInputs.push({ env: input.env ? { ...input.env } : undefined });
      input.onStdout?.("ok\n");
      return {
        runId: "mock-run",
        startedAtMs: Date.now(),
        stdin: undefined,
        wait: async () => ({
          reason: "exit" as const,
          exitCode: 0,
          exitSignal: null,
          durationMs: 0,
          stdout: "",
          stderr: "",
          timedOut: false,
          noOutputTimedOut: false,
        }),
        cancel: vi.fn(),
      };
    },
    cancel: vi.fn(),
    cancelScope: vi.fn(),
    getRecord: vi.fn(),
  }),
}));

let createExecTool: typeof import("./bash-tools.exec-run.js").createExecTool;
let createLazyExecTool: typeof import("./lazy-exec-tool.js").createLazyExecTool;

type StoreEntry = { name: string; value: string; kind: "env" | "secret" };

async function withTeamStoreEntries(
  entries: StoreEntry[],
  run: () => Promise<void>,
): Promise<void> {
  const tempDirs = createTempDirTracker();
  const stateDir = tempDirs.make("openclaw-exec-store-env-");
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  process.env.OPENCLAW_STATE_DIR = stateDir;
  try {
    for (const entry of entries) {
      writeSecretStoreEntry({ scope: { kind: "team" }, ...entry, updatedBy: "test" });
    }
    await run();
  } finally {
    closeOpenClawStateDatabaseForTest();
    envSnapshot.restore();
    tempDirs.cleanup();
  }
}

describe("exec store environment", () => {
  beforeAll(async () => {
    ({ createExecTool } = await import("./bash-tools.exec-run.js"));
    ({ createLazyExecTool } = await import("./lazy-exec-tool.js"));
  });

  beforeEach(() => {
    mocks.gatewayParams.length = 0;
    mocks.spawnInputs.length = 0;
  });

  it("adds only team env-kind entries to gateway exec subprocesses", async () => {
    await withTeamStoreEntries(
      [
        { name: "AWS_REGION", value: "us-west-2", kind: "env" },
        { name: "INTERNAL_VALUE", value: "not-for-subprocesses", kind: "secret" },
      ],
      async () => {
        const tool = createLazyExecTool({ host: "gateway", security: "full", ask: "off" });

        await tool.execute("call-store-env", { command: "echo ok", yieldMs: 120_000 });

        expect(mocks.gatewayParams[0]?.env.AWS_REGION).toBe("us-west-2");
        expect(mocks.gatewayParams[0]?.env).not.toHaveProperty("INTERNAL_VALUE");
      },
    );
  });

  it("applies store env when code mode invokes exec through the hidden tool catalog", async () => {
    // Code mode never runs shell itself: its guest calls `openclaw:core:exec`, which
    // re-enters this same tool object. Re-executing one instance is what that nested
    // route does, so store env must land on every call, not only the first.
    await withTeamStoreEntries(
      [
        { name: "AWS_REGION", value: "us-west-2", kind: "env" },
        { name: "INTERNAL_VALUE", value: "not-for-subprocesses", kind: "secret" },
      ],
      async () => {
        const tool = createLazyExecTool({ host: "gateway", security: "full", ask: "off" });

        await tool.execute("code-mode-first", { command: "echo one", yieldMs: 120_000 });
        await tool.execute("code-mode-nested", { command: "echo two", yieldMs: 120_000 });

        expect(mocks.gatewayParams).toHaveLength(2);
        for (const params of mocks.gatewayParams) {
          expect(params.env.AWS_REGION).toBe("us-west-2");
          expect(params.env).not.toHaveProperty("INTERNAL_VALUE");
        }
      },
    );
  });

  it("lets explicitly requested env override a store entry", async () => {
    await withTeamStoreEntries(
      [{ name: "AWS_REGION", value: "us-west-2", kind: "env" }],
      async () => {
        const tool = createLazyExecTool({ host: "gateway", security: "full", ask: "off" });

        await tool.execute("call-store-env-override", {
          command: "echo ok",
          env: { AWS_REGION: "eu-central-1" },
          yieldMs: 120_000,
        });

        expect(mocks.gatewayParams[0]?.env.AWS_REGION).toBe("eu-central-1");
        expect(mocks.gatewayParams[0]?.requestedEnv?.AWS_REGION).toBe("eu-central-1");
      },
    );
  });

  it("ignores protected store entries without replacing inherited network settings", async () => {
    const envSnapshot = captureEnv(["PATH", "HTTPS_PROXY", "NODE_EXTRA_CA_CERTS"]);
    process.env.PATH = "/inherited/bin";
    process.env.HTTPS_PROXY = "http://inherited-proxy.test:8080";
    process.env.NODE_EXTRA_CA_CERTS = "/inherited/ca.pem";
    try {
      await withTeamStoreEntries(
        [
          { name: "PATH", value: "/store/bin", kind: "env" },
          { name: "HTTPS_PROXY", value: "http://store-proxy.test:8080", kind: "env" },
          { name: "NODE_EXTRA_CA_CERTS", value: "/store/ca.pem", kind: "env" },
        ],
        async () => {
          const tool = createLazyExecTool({ host: "gateway", security: "full", ask: "off" });

          const result = await tool.execute("call-protected-store-env", {
            command: "echo ok",
            yieldMs: 120_000,
          });

          expect(mocks.gatewayParams[0]?.env).toMatchObject({
            PATH: "/inherited/bin",
            HTTPS_PROXY: "http://inherited-proxy.test:8080",
            NODE_EXTRA_CA_CERTS: "/inherited/ca.pem",
          });
          expect(mocks.gatewayParams[0]?.requestedEnv).toBeUndefined();
          expect(result.content[0]).toMatchObject({
            type: "text",
            text: expect.stringMatching(/HTTPS_PROXY, NODE_EXTRA_CA_CERTS, PATH/u),
          });
        },
      );
    } finally {
      envSnapshot.restore();
    }
  });

  it("filters sandbox store env and surfaces credential-shaped drops", async () => {
    await withTeamStoreEntries(
      [
        { name: "AWS_REGION", value: "us-west-2", kind: "env" },
        { name: "FOO_TOKEN", value: "operator-forced-env", kind: "env" },
      ],
      async () => {
        const buildExecSpec = vi.fn<NonNullable<BashSandboxConfig["buildExecSpec"]>>(
          async (params) => ({
            argv: ["remote-shell", params.command],
            env: {},
            stdinMode: "pipe-open" as const,
          }),
        );
        const tool = createLazyExecTool({
          host: "sandbox",
          security: "full",
          ask: "off",
          cwd: process.cwd(),
          sandbox: {
            containerName: "store-env-sandbox",
            workspaceDir: process.cwd(),
            containerWorkdir: "/workspace",
            buildExecSpec,
          },
        });

        const result = await tool.execute("call-sandbox-store-env", {
          command: "echo ok",
          yieldMs: 120_000,
        });

        expect(buildExecSpec.mock.calls[0]?.[0]?.env).toMatchObject({ AWS_REGION: "us-west-2" });
        expect(buildExecSpec.mock.calls[0]?.[0]?.env).not.toHaveProperty("FOO_TOKEN");
        expect(result.content[0]).toMatchObject({
          type: "text",
          text: expect.stringContaining("FOO_TOKEN"),
        });
      },
    );
  });

  it("keeps an empty store snapshot byte-identical to direct exec env assembly", async () => {
    await withTeamStoreEntries([], async () => {
      const directTool = createExecTool({ host: "gateway", security: "full", ask: "off" });
      await directTool.execute("call-direct-empty-store-baseline", {
        command: "echo ok",
        env: { REQUEST_SAFE: "request" },
        yieldMs: 120_000,
      });
      const baseline = JSON.stringify({
        gateway: mocks.gatewayParams[0],
        spawn: mocks.spawnInputs[0],
      });
      mocks.gatewayParams.length = 0;
      mocks.spawnInputs.length = 0;

      const lazyTool = createLazyExecTool({ host: "gateway", security: "full", ask: "off" });
      await lazyTool.execute("call-lazy-empty-store", {
        command: "echo ok",
        env: { REQUEST_SAFE: "request" },
        yieldMs: 120_000,
      });

      expect(JSON.stringify({ gateway: mocks.gatewayParams[0], spawn: mocks.spawnInputs[0] })).toBe(
        baseline,
      );
    });
  });
});
