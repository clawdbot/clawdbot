import { spawn, spawnSync } from "node:child_process";
// Qa Lab tests cover gateway child plugin behavior.
import { EventEmitter, once } from "node:events";
import { lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createQaBundledPluginsDir,
  resolveQaOwnerPluginIdsForProviderIds,
  resolveQaRuntimeHostVersion,
} from "./bundled-plugin-staging.js";
import { preserveQaGatewayDebugArtifacts } from "./gateway-child-artifacts.js";
import { resolveQaGatewayChildCommand, runQaGatewayCliCommand } from "./gateway-child-command.js";
import {
  buildQaForcedRuntimeEnvPatch,
  buildQaRuntimeEnv,
  stageQaCodexMockModelCatalog,
} from "./gateway-child-env.js";
import {
  closeQaGatewayLogStream,
  createQaGatewayChildLogCollector,
  formatQaGatewayProcessBoundaryStartupFailure,
  monitorQaGatewayChildFailure,
  stopQaGatewayChildProcessTree,
  throwQaGatewayChildFailure,
} from "./gateway-child-process.js";
import {
  callQaGatewayWithRetry,
  isRetryableRpcStartupError,
  resolveQaGatewayStartupRetry,
  waitForGatewayReady,
  waitForQaGatewayRestartBoundary,
} from "./gateway-child-readiness.js";
import { createQaGatewayChild } from "./gateway-child.js";
import { readQaLiveProviderConfigOverrides } from "./providers/live-config.js";
import {
  assertQaLiveCodexAuthAvailable,
  stageQaLiveAnthropicSetupToken,
  stageQaLiveApiKeyProfiles,
} from "./providers/live-frontier/auth.js";
import { readQaAuthProfiles } from "./providers/shared/auth-store.js";
import { stageQaMockAuthProfiles } from "./providers/shared/mock-auth.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());
const resolveQaNodeExecPathMock = vi.hoisted(() => vi.fn(async () => process.execPath));
const qaTempPathState = vi.hoisted(() => ({
  preferredTmpDir: process.env.TMPDIR || "/tmp",
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

vi.mock("openclaw/plugin-sdk/temp-path", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/temp-path")>()),
  resolvePreferredOpenClawTmpDir: () => qaTempPathState.preferredTmpDir,
}));

vi.mock("./node-exec.js", () => ({
  resolveQaNodeExecPath: resolveQaNodeExecPathMock,
}));

const tempDirs = createTempDirHarness();
const owners: ReturnType<typeof createQaGatewayChild>[] = [];
function ownGateway() {
  const owner = createQaGatewayChild();
  owners.push(owner);
  return owner;
}

afterEach(async () => {
  fetchWithSsrFGuardMock.mockReset();
  resolveQaNodeExecPathMock.mockReset();
  qaTempPathState.preferredTmpDir = process.env.TMPDIR || "/tmp";
  for (const owner of owners.splice(0)) {
    await owner.stop();
  }
  await tempDirs.cleanup();
});

function createParams(baseEnv?: NodeJS.ProcessEnv) {
  return {
    configPath: "/tmp/openclaw-qa/openclaw.json",
    gatewayToken: "qa-token",
    homeDir: "/tmp/openclaw-qa/home",
    stateDir: "/tmp/openclaw-qa/state",
    tempRoot: "/tmp/openclaw-qa",
    xdgConfigHome: "/tmp/openclaw-qa/xdg-config",
    xdgDataHome: "/tmp/openclaw-qa/xdg-data",
    xdgCacheHome: "/tmp/openclaw-qa/xdg-cache",
    bundledPluginsDir: "/tmp/openclaw-qa/bundled-plugins",
    stagedBundledPluginsRoot: "/repo/.artifacts/qa-runtime/openclaw-qa-suite-test",
    compatibilityHostVersion: "2026.4.8",
    baseEnv,
  };
}

type AuthProfileRecord = {
  provider?: string;
  mode?: string;
  type?: string;
  displayName?: string;
  key?: string;
  token?: string;
};

type AuthProfileStore = {
  profiles: Record<string, AuthProfileRecord>;
};

type SsrFetchCall = {
  url: string;
  init?: RequestInit;
  policy?: unknown;
  auditContext?: string;
};

function readAuthProfileStore(stateDir: string, agentId: string): AuthProfileStore {
  return readQaAuthProfiles(path.join(stateDir, "agents", agentId, "agent"));
}

function requireAuthProfile(
  profiles: Record<string, AuthProfileRecord> | undefined,
  id: string,
): AuthProfileRecord {
  const profile = profiles?.[id];
  if (!profile) {
    throw new Error(`expected auth profile ${id}`);
  }
  return profile;
}

function requireSsrFetchCall(index = 0): SsrFetchCall {
  const call = fetchWithSsrFGuardMock.mock.calls[index];
  if (!call) {
    throw new Error(`expected SSRF fetch call ${index}`);
  }
  return call[0] as SsrFetchCall;
}

async function writeJsonFixture(filePath: string, value: unknown, space?: number) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value, null, space), "utf8");
}

async function writeTempProviderConfig(value: unknown) {
  const configPath = path.join(await tempDirs.makeTempDir("qa-provider-config-"), "openclaw.json");
  await writeJsonFixture(configPath, value);
  return configPath;
}

async function writePackagedGatewayFixture(root: string): Promise<string> {
  const fixturePath = path.join(root, "packaged-gateway-fixture.mjs");
  await writeFile(
    fixturePath,
    `import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const recordPath = process.env.QA_RECORD_PATH;
const configPath = process.env.OPENCLAW_CONFIG_PATH;
const stateDir = process.env.OPENCLAW_STATE_DIR;
if (!recordPath || !configPath || !stateDir) {
  throw new Error("missing fixture environment");
}
const record = (value) => fs.appendFileSync(recordPath, JSON.stringify(value) + "\\n");
const authDbPath = path.join(stateDir, "agents", "qa", "agent", "openclaw-agent.sqlite");
if (args[0] === "models") {
  let stdin = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) stdin += chunk;
  const provider = args[args.indexOf("--provider") + 1];
  const configStat = fs.lstatSync(configPath);
  record({
    kind: "auth",
    args,
    stdin,
    authDbPath,
    dbExists: fs.existsSync(authDbPath),
    configPath,
    configMode: configStat.mode & 0o777,
    configRegular: configStat.isFile(),
    configSymlink: configStat.isSymbolicLink(),
    stateDir,
    env: {
      OPENCLAW_CLI: process.env.OPENCLAW_CLI,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_STATE_DIR: stateDir,
    },
  });
  fs.mkdirSync(path.dirname(authDbPath), { recursive: true });
  fs.writeFileSync(authDbPath, "fixture auth");
  if (process.env.QA_FAIL_PROVIDER === provider) {
    process.stderr.write("Authorization: Bearer " + stdin.trim());
    process.exit(9);
  }
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.fixtureProfiles = [...(config.fixtureProfiles ?? []), provider];
  fs.writeFileSync(configPath, JSON.stringify(config));
  process.exit(0);
}
if (args[0] === "update") {
  if (args.includes("--help")) {
    process.stdout.write(process.env.QA_LEGACY_PLUGIN_SETUP === "1" ? "Options: --yes" : "Options: --accept-capabilities --yes");
    process.exit(0);
  }
  if (process.env.QA_LEGACY_PLUGIN_SETUP === "1" && args.includes("--accept-capabilities")) {
    process.stderr.write("unknown option --accept-capabilities");
    process.exit(2);
  }
  record({ kind: "plugins", args, authDbPath, configPath, stateDir });
  if (process.env.QA_FAIL_PLUGIN_SETUP === "1") {
    process.stderr.write("plugin fixture rejected: Authorization: Bearer fixture-plugin-secret");
    process.exit(8);
  }
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  delete config.plugins.entries["qa-lab"];
  config.plugins.allow = config.plugins.allow.filter((id) => id !== "qa-lab");
  fs.writeFileSync(configPath, JSON.stringify(config));
  process.stdout.write(JSON.stringify({ status: "ok", mode: "finalize", restart: false }));
  process.exit(0);
}
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
record({
  kind: "gateway",
  args,
  authDbPath,
  dbExists: fs.existsSync(authDbPath),
  configPath,
  authProfileIds: Object.keys(config.auth?.profiles ?? {}),
  fixtureProfiles: config.fixtureProfiles,
  sourcePluginConfigured: Boolean(config.plugins?.entries?.["qa-lab"]),
  configPort: config.gateway.port,
  stateDir,
});
const gatewayAttempts = fs.readFileSync(recordPath, "utf8").trim().split("\\n")
  .map((line) => JSON.parse(line)).filter((entry) => entry.kind === "gateway").length;
if (gatewayAttempts === 1 && process.env.QA_STARTUP_RETRY) {
  process.stderr.write(process.env.QA_STARTUP_RETRY === "migration"
    ? "OpenClaw plugin migration inputs changed during startup convergence; refusing readiness."
    : "listen EADDRINUSE: address already in use");
  process.exit(18);
}
process.stderr.write("fixture gateway exit");
process.exit(17);
`,
    "utf8",
  );
  return fixturePath;
}

async function readJsonLines(filePath: string): Promise<Array<Record<string, unknown>>> {
  const contents = await readFile(filePath, "utf8");
  return contents
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("runQaGatewayCliCommand", () => {
  it("runs CLI commands with the Gateway fixture environment", async () => {
    const output = await runQaGatewayCliCommand({
      executablePath: process.execPath,
      argsPrefix: [
        "--eval",
        'process.stdout.write(`${process.env.OPENCLAW_CLI}:${process.env.QA_VALUE}:${process.argv.slice(1).join(",")}`)',
      ],
      args: ["voicecall", "start"],
      cwd: process.cwd(),
      env: { ...process.env, QA_VALUE: "fixture" },
    });

    expect(output).toBe("1:fixture:voicecall,start");
  });

  it("reports CLI stderr when a fixture command fails", async () => {
    await expect(
      runQaGatewayCliCommand({
        executablePath: process.execPath,
        argsPrefix: ["--eval", 'process.stderr.write("fixture failure"); process.exit(7)'],
        args: [],
        cwd: process.cwd(),
        env: process.env,
      }),
    ).rejects.toThrow("OpenClaw CLI exited 7: fixture failure");
  });
});

describe("monitorQaGatewayChildFailure", () => {
  it("records the first pipe failure and stops the detached Gateway child", async () => {
    const child = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const close = once(child, "close");
    const output = createQaGatewayChildLogCollector();
    const getFailure = monitorQaGatewayChildFailure(child, output);
    const error = new Error("synthetic gateway stdout read failure");

    child.stdout?.destroy(error);
    child.stderr?.destroy(new Error("later stderr read failure"));

    await vi.waitFor(() => expect(getFailure()).toEqual({ source: "stdout", error }));
    await close;
    expect(output.text()).toContain(
      "gateway child stdout stream failed: synthetic gateway stdout read failure",
    );
    expect(output.text()).not.toContain("later stderr read failure");
    expect(() => throwQaGatewayChildFailure(getFailure, () => output.text())).toThrow(
      "gateway child stdout stream failed: synthetic gateway stdout read failure",
    );
  });
});

describe("formatQaGatewayProcessBoundaryStartupFailure", () => {
  it("includes only a bounded, redacted launcher log tail", () => {
    const prefix = "x".repeat(9_000);
    const longSecret = "s".repeat(9_000);
    const message = formatQaGatewayProcessBoundaryStartupFailure(
      new Error("launcher exited before identity"),
      `${prefix}\nAuthorization: Bearer ${longSecret}\nlauncher stage=mount-proc`,
    );

    expect(message).toContain("launcher exited before identity");
    expect(message).toContain("Gateway logs:");
    expect(message).toContain("Authorization: Bearer <redacted>");
    expect(message).toContain("launcher stage=mount-proc");
    expect(message).not.toContain("s".repeat(100));
    expect(message).not.toContain(prefix);
  });

  it("preserves complete Unicode code points at the retained log-tail boundary", () => {
    const message = formatQaGatewayProcessBoundaryStartupFailure(
      new Error("launcher exited before identity"),
      `P😀${"z".repeat(8_191)}`,
    );

    expect(message).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
    );
    expect(Buffer.from(message, "utf8").toString("utf8")).not.toContain("�");
  });
});

describe("waitForGatewayReady", () => {
  it.each(["startup", "restart"] as const)(
    "does not accept a healthy listener as %s readiness",
    async (phase) => {
      vi.useFakeTimers();
      const baseUrl = "http://127.0.0.1:43124";
      const release = vi.fn(async () => {});
      let ready = false;

      fetchWithSsrFGuardMock.mockImplementation(async ({ url }: { url: string }) => {
        const status = url.endsWith("/healthz") || ready ? 200 : 503;
        return { response: { ok: status === 200, status }, release };
      });

      try {
        const readiness = waitForGatewayReady({
          baseUrl,
          logs: () => `${phase} logs`,
          child: { exitCode: null, signalCode: null },
          timeoutMs: 1_000,
        });

        await vi.advanceTimersByTimeAsync(0);

        expect(fetchWithSsrFGuardMock.mock.calls.map(([request]) => request.url)).toEqual([
          `${baseUrl}/readyz`,
        ]);
        const healthRequest = requireSsrFetchCall();
        expect(healthRequest.init?.method).toBe("HEAD");
        expect(healthRequest.init?.headers).toEqual({ connection: "close" });
        expect(healthRequest.policy).toEqual({ allowPrivateNetwork: true });
        expect(healthRequest.auditContext).toBe("qa-lab-gateway-child-health");
        expect(release).toHaveBeenCalledTimes(1);

        ready = true;
        await vi.advanceTimersByTimeAsync(250);

        await expect(readiness).resolves.toBeUndefined();
        expect(fetchWithSsrFGuardMock.mock.calls.map(([request]) => request.url)).toEqual([
          `${baseUrl}/readyz`,
          `${baseUrl}/readyz`,
        ]);
        expect(release).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("bounds a stalled readiness probe by the remaining deadline", async () => {
    let probeSignal: AbortSignal | undefined;
    fetchWithSsrFGuardMock.mockImplementation(
      async ({ init }: { init?: RequestInit }) =>
        await new Promise((_, reject) => {
          probeSignal = init?.signal ?? undefined;
          probeSignal?.addEventListener(
            "abort",
            () => reject(toErrorObject(probeSignal?.reason, "QA readiness probe aborted")),
            { once: true },
          );
        }),
    );
    const startedAt = Date.now();

    await expect(
      waitForGatewayReady({
        baseUrl: "http://127.0.0.1:43124",
        logs: () => "near-expiry logs",
        child: { exitCode: null, signalCode: null },
        timeoutMs: 25,
      }),
    ).rejects.toThrow("gateway failed to become healthy");

    expect(probeSignal?.aborted).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});

describe("Gateway child fixture helpers", () => {
  it("stages native Codex model metadata before starting the private mock runtime", async () => {
    const tempRoot = await tempDirs.makeTempDir("qa-codex-model-catalog-");
    const modelCatalogPath = await stageQaCodexMockModelCatalog({
      tempRoot,
      forcedRuntime: "codex",
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.6-luna",
      alternateModel: "mock-openai/gpt-5.6-luna-alt",
    });

    expect(modelCatalogPath).toBe(path.join(tempRoot, "codex-model-catalog.json"));
    const catalog = JSON.parse(await readFile(modelCatalogPath!, "utf8")) as {
      models: Array<Record<string, unknown>>;
    };
    expect(catalog.models).toEqual([
      expect.objectContaining({
        slug: "gpt-5.6-luna",
        apply_patch_tool_type: "freeform",
        supports_reasoning_summary_parameter: true,
        tool_mode: "direct",
      }),
      expect.objectContaining({
        slug: "gpt-5.6-luna-alt",
        apply_patch_tool_type: "freeform",
        supports_reasoning_summary_parameter: true,
        tool_mode: "direct",
      }),
    ]);
    expect(catalog.models[0]).not.toHaveProperty("supports_reasoning_summaries");
    const runtimeEnvPatch = buildQaForcedRuntimeEnvPatch({
      forcedRuntime: "codex",
      providerMode: "mock-openai",
      providerBaseUrl: "http://127.0.0.1:44080/v1",
      codexModelCatalogPath: modelCatalogPath,
    });
    expect(runtimeEnvPatch).toEqual(
      expect.objectContaining({
        OPENCLAW_CODEX_APP_SERVER_ARGS: `app-server -c openai_base_url=http://127.0.0.1:44080/v1 -c ${JSON.stringify(`model_catalog_json=${modelCatalogPath}`)} -c sandbox_workspace_write.exclude_tmpdir_env_var=true -c sandbox_workspace_write.exclude_slash_tmp=true --listen stdio://`,
      }),
    );
    expect(runtimeEnvPatch).not.toHaveProperty("OPENAI_API_KEY");
    expect(runtimeEnvPatch).not.toHaveProperty("CODEX_API_KEY");
  });

  it("does not stage a Codex catalog for other runtimes or live providers", async () => {
    const tempRoot = await tempDirs.makeTempDir("qa-codex-model-catalog-unused-");
    await expect(
      stageQaCodexMockModelCatalog({
        tempRoot,
        forcedRuntime: "openclaw",
        providerMode: "mock-openai",
      }),
    ).resolves.toBeUndefined();
    await expect(
      stageQaCodexMockModelCatalog({
        tempRoot,
        forcedRuntime: "codex",
        providerMode: "live-frontier",
      }),
    ).resolves.toBeUndefined();
    await expect(
      readFile(path.join(tempRoot, "codex-model-catalog.json"), "utf8"),
    ).rejects.toThrow();
  });

  it("resolves the repo runner before a built Gateway CLI fallback", async () => {
    const repoRoot = await tempDirs.makeTempDir("qa-gateway-command-");
    await mkdir(path.join(repoRoot, "scripts"), { recursive: true });
    const runnerPath = path.join(repoRoot, "scripts", "run-node.mjs");
    await writeFile(runnerPath, "export {};\n", "utf8");

    expect(resolveQaGatewayChildCommand(repoRoot)).toEqual({
      executablePath: process.execPath,
      argsPrefix: [runnerPath],
      cwd: repoRoot,
      usePackagedPlugins: true,
    });

    await mkdir(path.join(repoRoot, "dist"), { recursive: true });
    await writeFile(path.join(repoRoot, "dist", "index.js"), "export {};\n", "utf8");
    await rm(path.join(repoRoot, "scripts"), { recursive: true });
    expect(resolveQaGatewayChildCommand(repoRoot)).toEqual({
      executablePath: process.execPath,
      argsPrefix: [path.join(repoRoot, "dist", "index.js")],
      cwd: repoRoot,
      usePackagedPlugins: true,
    });
  });
});

describe("buildQaRuntimeEnv", () => {
  it("cleans up temp QA gateway roots when node path resolution fails before startup", async () => {
    const tempParent = await tempDirs.makeTempDir("qa-gateway-node-exec-fail-");
    qaTempPathState.preferredTmpDir = tempParent;
    resolveQaNodeExecPathMock.mockRejectedValueOnce(new Error("node missing"));

    const owner = ownGateway();
    await expect(
      owner.start({
        repoRoot: process.cwd(),
        transport: {
          requiredPluginIds: [],
          createGatewayConfig: () => ({}),
        },
        transportBaseUrl: "http://127.0.0.1:43123",
      }),
    ).rejects.toThrow("node missing");
    await expect(owner.stop()).resolves.toMatchObject({ errors: [] });

    await expect(readdir(tempParent)).resolves.toStrictEqual([]);
  });

  it("cleans up temp QA gateway roots when repo CLI discovery fails before startup", async () => {
    const tempParent = await tempDirs.makeTempDir("qa-gateway-cli-discovery-fail-");
    const emptyRepo = await tempDirs.makeTempDir("qa-gateway-empty-repo-");
    qaTempPathState.preferredTmpDir = tempParent;

    const owner = ownGateway();
    await expect(
      owner.start({
        repoRoot: emptyRepo,
        useRepoCli: true,
        transportBaseUrl: "http://127.0.0.1:43123",
      }),
    ).rejects.toThrow("OpenClaw CLI entry not found");
    await expect(owner.stop()).resolves.toMatchObject({ errors: [] });

    await expect(readdir(tempParent)).resolves.toStrictEqual([]);
  });

  it.each([
    {
      failure: "bundled plugin staging cannot copy root package metadata",
      packageContents: undefined,
      expectedError: /ENOENT/u,
    },
    {
      failure: "host version resolution cannot parse staged package metadata",
      packageContents: "{",
      expectedError: /JSON/u,
    },
  ])("cleans staged QA runtime roots when $failure", async ({ packageContents, expectedError }) => {
    const tempParent = await tempDirs.makeTempDir("qa-gateway-staged-runtime-fail-");
    const repoRoot = await tempDirs.makeTempDir("qa-gateway-staged-runtime-repo-");
    const stagedRuntimeParent = path.join(repoRoot, ".artifacts", "qa-runtime");
    qaTempPathState.preferredTmpDir = tempParent;

    if (packageContents !== undefined) {
      await writeFile(path.join(repoRoot, "package.json"), packageContents, "utf8");
    }

    const owner = ownGateway();
    await expect(
      owner.start({
        repoRoot,
        transport: {
          requiredPluginIds: [],
          createGatewayConfig: () => ({}),
        },
        transportBaseUrl: "http://127.0.0.1:43123",
      }),
    ).rejects.toThrow(expectedError);
    await expect(owner.stop()).resolves.toMatchObject({ errors: [] });

    await expect(readdir(tempParent)).resolves.toStrictEqual([]);
    await expect(readdir(stagedRuntimeParent)).resolves.toStrictEqual([]);
  });

  it("reports command spawn errors instead of leaking unhandled child errors", async () => {
    const preferredTempParent = await tempDirs.makeTempDir("qa-gateway-default-spawn-fail-");
    const commandTempParent = await tempDirs.makeTempDir("qa-gateway-command-spawn-fail-");
    qaTempPathState.preferredTmpDir = preferredTempParent;
    const missingExecutable = path.join(commandTempParent, "missing-openclaw-node");

    const owner = ownGateway();
    await expect(
      owner.start({
        repoRoot: process.cwd(),
        command: {
          executablePath: missingExecutable,
          tempParentDir: commandTempParent,
          usePackagedPlugins: true,
        },
        transport: {
          requiredPluginIds: [],
          createGatewayConfig: () => ({}),
        },
        transportBaseUrl: "http://127.0.0.1:43123",
      }),
    ).rejects.toThrow(/installed package mock auth bootstrap failed for openai: .*ENOENT/u);
    await expect(owner.stop()).resolves.toMatchObject({ errors: [] });

    await expect(readdir(preferredTempParent)).resolves.toStrictEqual([]);
    await expect(readdir(commandTempParent)).resolves.toStrictEqual([]);
  });

  it("keeps the slow-reply QA opt-out enabled under fast mode", () => {
    const env = buildQaRuntimeEnv({
      ...createParams(),
      providerMode: "mock-openai",
    });

    expect(env.OPENCLAW_TEST_FAST).toBe("1");
    expect(env.OPENCLAW_SKIP_STARTUP_MODEL_PREWARM).toBe("1");
    expect(env.OPENCLAW_EMBEDDED_ABORT_SETTLE_TIMEOUT_MS).toBe("2000");
    expect(env.OPENCLAW_QA_PARENT_PID).toBe(String(process.pid));
    expect(env.OPENCLAW_QA_TEMP_ROOT).toBe("/tmp/openclaw-qa");
    expect(env.OPENCLAW_QA_STAGED_RUNTIME_ROOT).toBe(
      "/repo/.artifacts/qa-runtime/openclaw-qa-suite-test",
    );
    expect(env.OPENCLAW_QA_ALLOW_LOCAL_IMAGE_PROVIDER).toBe("1");
    expect(env.OPENCLAW_BUILD_PRIVATE_QA).toBe("1");
    expect(env.OPENCLAW_ALLOW_SLOW_REPLY_TESTS).toBe("1");
    expect(env.OPENCLAW_BUNDLED_PLUGINS_DIR).toBe("/tmp/openclaw-qa/bundled-plugins");
    expect(env.OPENCLAW_COMPATIBILITY_HOST_VERSION).toBe("2026.4.8");
  });

  it("isolates gateway children from Vitest without removing QA controls or non-test NODE_ENV", () => {
    const testEnv = buildQaRuntimeEnv({
      ...createParams({
        NODE_ENV: "test",
        VITEST: "true",
        VITEST_POOL_ID: "base-pool",
        VITEST_WORKER_ID: "base-worker",
      }),
      runtimeEnvPatch: {
        VITEST: "patched",
        VITEST_POOL_ID: "patched-pool",
        VITEST_WORKER_ID: "patched-worker",
      },
    });

    expect(testEnv.NODE_ENV).toBeUndefined();
    expect(testEnv.VITEST).toBeUndefined();
    expect(testEnv.VITEST_POOL_ID).toBeUndefined();
    expect(testEnv.VITEST_WORKER_ID).toBeUndefined();
    expect(testEnv.OPENCLAW_TEST_FAST).toBe("1");
    expect(testEnv.OPENCLAW_ALLOW_SLOW_REPLY_TESTS).toBe("1");

    const developmentEnv = buildQaRuntimeEnv({
      ...createParams({ NODE_ENV: "development" }),
    });
    expect(developmentEnv.NODE_ENV).toBe("development");
  });

  it("does not inherit parent channel or provider skip controls", () => {
    const env = buildQaRuntimeEnv({
      ...createParams({
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
      }),
    });

    expect(env.OPENCLAW_SKIP_CHANNELS).toBeUndefined();
    expect(env.OPENCLAW_SKIP_PROVIDERS).toBeUndefined();
  });

  it("honors explicit channel and provider skip controls", () => {
    const env = buildQaRuntimeEnv({
      ...createParams({
        OPENCLAW_SKIP_CHANNELS: "inherited",
        OPENCLAW_SKIP_PROVIDERS: "inherited",
      }),
      runtimeEnvPatch: {
        OPENCLAW_SKIP_CHANNELS: "patched-channels",
        OPENCLAW_SKIP_PROVIDERS: "patched-providers",
      },
    });

    expect(env.OPENCLAW_SKIP_CHANNELS).toBe("patched-channels");
    expect(env.OPENCLAW_SKIP_PROVIDERS).toBe("patched-providers");
  });

  it("maps live frontier key aliases into provider env vars", () => {
    const env = buildQaRuntimeEnv({
      ...createParams({
        OPENCLAW_LIVE_OPENAI_KEY: "openai-live",
        OPENCLAW_LIVE_ANTHROPIC_KEY: "anthropic-live",
        OPENCLAW_LIVE_GEMINI_KEY: "gemini-live",
      }),
      providerMode: "live-frontier",
    });

    expect(env.OPENAI_API_KEY).toBe("openai-live");
    expect(env.ANTHROPIC_API_KEY).toBe("anthropic-live");
    expect(env.GEMINI_API_KEY).toBe("gemini-live");
  });

  it("keeps explicit provider env vars over live aliases", () => {
    const env = buildQaRuntimeEnv({
      ...createParams({
        OPENAI_API_KEY: "openai-explicit",
        OPENCLAW_LIVE_OPENAI_KEY: "openai-live",
      }),
      providerMode: "live-frontier",
    });

    expect(env.OPENAI_API_KEY).toBe("openai-explicit");
  });

  it("preserves Codex CLI auth home for live frontier runs while sandboxing OpenClaw home", async () => {
    const hostHome = await tempDirs.makeTempDir("qa-host-home-");
    const codexHome = path.join(hostHome, ".codex");
    await mkdir(codexHome);

    const env = buildQaRuntimeEnv({
      ...createParams({
        HOME: hostHome,
      }),
      providerMode: "live-frontier",
    });

    expect(env.HOME).toBe("/tmp/openclaw-qa/home");
    expect(env.OPENCLAW_HOME).toBe("/tmp/openclaw-qa/home");
    expect(env.CODEX_HOME).toBe(codexHome);
  });

  it("forwards host HOME for live Claude CLI runs while keeping OpenClaw home sandboxed", async () => {
    const hostHome = await tempDirs.makeTempDir("qa-host-home-");

    const env = buildQaRuntimeEnv({
      ...createParams({
        HOME: hostHome,
      }),
      providerMode: "live-frontier",
      forwardHostHomeForClaudeCli: true,
    });

    expect(env.HOME).toBe(hostHome);
    expect(env.OPENCLAW_HOME).toBe("/tmp/openclaw-qa/home");
    expect(env.OPENCLAW_STATE_DIR).toBe("/tmp/openclaw-qa/state");
  });

  it("can forward host HOME for browser-backed QA runs while keeping OpenClaw home sandboxed", async () => {
    const hostHome = await tempDirs.makeTempDir("qa-host-home-");

    const env = buildQaRuntimeEnv({
      ...createParams({
        HOME: hostHome,
      }),
      providerMode: "mock-openai",
      forwardHostHome: true,
    });

    expect(env.HOME).toBe(hostHome);
    expect(env.OPENCLAW_HOME).toBe("/tmp/openclaw-qa/home");
    expect(env.OPENCLAW_STATE_DIR).toBe("/tmp/openclaw-qa/state");
  });

  it("preserves the live Anthropic key for live Claude CLI runs without writing it into config", async () => {
    const hostHome = await tempDirs.makeTempDir("qa-host-home-");

    const env = buildQaRuntimeEnv({
      ...createParams({
        HOME: hostHome,
        OPENCLAW_LIVE_ANTHROPIC_KEY: "anthropic-live",
        OPENCLAW_LIVE_CLI_BACKEND_PRESERVE_ENV: '["SAFE_KEEP"]',
      }),
      providerMode: "live-frontier",
      forwardHostHomeForClaudeCli: true,
      claudeCliAuthMode: "api-key",
    });

    expect(env.ANTHROPIC_API_KEY).toBe("anthropic-live");
    expect(env.OPENCLAW_LIVE_CLI_BACKEND_PRESERVE_ENV).toBe('["SAFE_KEEP","ANTHROPIC_API_KEY"]');
    expect(env.OPENCLAW_LIVE_CLI_BACKEND_AUTH_MODE).toBe("api-key");
  });

  it("removes preserved Anthropic keys for live Claude CLI subscription runs", async () => {
    const hostHome = await tempDirs.makeTempDir("qa-host-home-");

    const env = buildQaRuntimeEnv({
      ...createParams({
        HOME: hostHome,
        ANTHROPIC_API_KEY: "anthropic-live",
        OPENCLAW_LIVE_CLI_BACKEND_PRESERVE_ENV: '["SAFE_KEEP","ANTHROPIC_API_KEY"]',
      }),
      providerMode: "live-frontier",
      forwardHostHomeForClaudeCli: true,
      claudeCliAuthMode: "subscription",
    });

    expect(env.ANTHROPIC_API_KEY).toBe("anthropic-live");
    expect(env.OPENCLAW_LIVE_CLI_BACKEND_PRESERVE_ENV).toBe('["SAFE_KEEP"]');
    expect(env.OPENCLAW_LIVE_CLI_BACKEND_AUTH_MODE).toBe("subscription");
  });

  it("does not pass QA setup-token values to the gateway child env", () => {
    const env = buildQaRuntimeEnv({
      ...createParams({
        OPENCLAW_LIVE_SETUP_TOKEN_VALUE: `sk-ant-oat01-${"a".repeat(80)}`,
        OPENCLAW_QA_LIVE_ANTHROPIC_SETUP_TOKEN: `sk-ant-oat01-${"b".repeat(80)}`,
      }),
      providerMode: "live-frontier",
    });

    expect(env.OPENCLAW_LIVE_SETUP_TOKEN_VALUE).toBeUndefined();
    expect(env.OPENCLAW_QA_LIVE_ANTHROPIC_SETUP_TOKEN).toBeUndefined();
  });

  it("does not pass credential broker or Telegram harness secrets to the gateway child env", () => {
    const env = buildQaRuntimeEnv({
      ...createParams({
        OPENCLAW_QA_CONVEX_SECRET_CI: "convex-ci-secret",
        OPENCLAW_QA_CONVEX_SECRET_MAINTAINER: "convex-maintainer-secret",
        OPENCLAW_QA_SUT_FORBIDDEN_SENTINEL: "trusted-parent-only",
        OPENCLAW_QA_TELEGRAM_GROUP_ID: "-1001234567890",
        OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN: "driver-token",
        OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN: "sut-token",
      }),
      providerMode: "live-frontier",
    });

    expect(env.OPENCLAW_QA_CONVEX_SECRET_CI).toBeUndefined();
    expect(env.OPENCLAW_QA_CONVEX_SECRET_MAINTAINER).toBeUndefined();
    expect(env.OPENCLAW_QA_SUT_FORBIDDEN_SENTINEL).toBeUndefined();
    expect(env.OPENCLAW_QA_TELEGRAM_GROUP_ID).toBeUndefined();
    expect(env.OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN).toBeUndefined();
    expect(env.OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN).toBeUndefined();
  });

  it("re-scrubs blocked credentials after runtime env patches", () => {
    const env = buildQaRuntimeEnv({
      ...createParams({ SAFE_VALUE: "base" }),
      runtimeEnvPatch: {
        SAFE_VALUE: "patched",
        OPENCLAW_LIVE_SETUP_TOKEN_VALUE: "setup-token",
        OPENCLAW_QA_LIVE_ANTHROPIC_SETUP_TOKEN: "anthropic-setup-token",
        OPENCLAW_QA_CONVEX_SECRET_CI: "convex-ci-secret",
        OPENCLAW_QA_SUT_FORBIDDEN_SENTINEL: "trusted-parent-only",
        OPENCLAW_QA_TELEGRAM_GROUP_ID: "-1001234567890",
        OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN: "driver-token",
        OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN: "sut-token",
        "BASH_FUNC_sudo%%": "() { printf imported; }",
      },
    });

    expect(env.SAFE_VALUE).toBe("patched");
    expect(env.OPENCLAW_LIVE_SETUP_TOKEN_VALUE).toBeUndefined();
    expect(env.OPENCLAW_QA_LIVE_ANTHROPIC_SETUP_TOKEN).toBeUndefined();
    expect(env.OPENCLAW_QA_CONVEX_SECRET_CI).toBeUndefined();
    expect(env.OPENCLAW_QA_SUT_FORBIDDEN_SENTINEL).toBeUndefined();
    expect(env.OPENCLAW_QA_TELEGRAM_GROUP_ID).toBeUndefined();
    expect(env.OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN).toBeUndefined();
    expect(env.OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN).toBeUndefined();
    expect(env["BASH_FUNC_sudo%%"]).toBeUndefined();
  });

  it.runIf(process.platform === "linux")(
    "scrubs inherited shell startup env before the workflow allowlist runs",
    async () => {
      const tempRoot = await tempDirs.makeTempDir("qa-shell-startup-env-");
      const markerPath = path.join(tempRoot, "bash-env-ran");
      const functionMarkerPath = path.join(tempRoot, "bash-function-ran");
      const bashEnvPath = path.join(tempRoot, "malicious-bash-env");
      const allowlistProbePath = path.join(tempRoot, "allowlist-probe.sh");
      await writeFile(bashEnvPath, `printf 'ran' > ${JSON.stringify(markerPath)}\n`, "utf8");
      await writeFile(
        allowlistProbePath,
        `
          set -Eeuo pipefail
          for key in BASH_ENV BASHOPTS ENV SHELLOPTS; do
            ! compgen -e | grep -Fxq "$key"
          done
          declare -A keep_env=([SAFE_VALUE]=1)
          while IFS= read -r key; do
            if [[ -z "\${keep_env[$key]+x}" ]]; then
              unset "$key"
            fi
          done < <(compgen -e)
          printf '%s' "\${SAFE_VALUE:?}"
        `,
        "utf8",
      );
      const env = buildQaRuntimeEnv({
        ...createParams({ SAFE_VALUE: "base" }),
        runtimeEnvPatch: {
          SAFE_VALUE: "allowlist-survived",
          BASH_ENV: bashEnvPath,
          BASHOPTS: "checkwinsize",
          ENV: bashEnvPath,
          SHELLOPTS: "braceexpand",
          "BASH_FUNC_compgen%%": `() { printf 'ran' > ${JSON.stringify(functionMarkerPath)}; builtin compgen "$@"; }`,
        },
      });

      for (const key of ["BASH_ENV", "BASHOPTS", "ENV", "SHELLOPTS"]) {
        expect(env[key]).toBeUndefined();
      }
      expect(env["BASH_FUNC_compgen%%"]).toBeUndefined();

      const result = spawnSync("/bin/bash", ["--noprofile", "--norc", allowlistProbePath], {
        encoding: "utf8",
        env,
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("allowlist-survived");
      await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(functionMarkerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("re-scrubs blocked credentials in the spawned gateway child env", async () => {
    const tempParent = await tempDirs.makeTempDir("qa-gateway-env-scrub-");
    qaTempPathState.preferredTmpDir = tempParent;
    const observedEnvPath = path.join(tempParent, "observed-env.json");
    const captureScript = [
      'const fs = require("node:fs");',
      "const env = {",
      "SAFE_VALUE: process.env.SAFE_VALUE,",
      "OPENCLAW_LIVE_SETUP_TOKEN_VALUE: process.env.OPENCLAW_LIVE_SETUP_TOKEN_VALUE,",
      "OPENCLAW_QA_LIVE_ANTHROPIC_SETUP_TOKEN: process.env.OPENCLAW_QA_LIVE_ANTHROPIC_SETUP_TOKEN,",
      "OPENCLAW_QA_CONVEX_SECRET_CI: process.env.OPENCLAW_QA_CONVEX_SECRET_CI,",
      "OPENCLAW_QA_SUT_FORBIDDEN_SENTINEL: process.env.OPENCLAW_QA_SUT_FORBIDDEN_SENTINEL,",
      "OPENCLAW_QA_TELEGRAM_GROUP_ID: process.env.OPENCLAW_QA_TELEGRAM_GROUP_ID,",
      "OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN: process.env.OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN,",
      "OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN: process.env.OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN,",
      "};",
      `fs.writeFileSync(${JSON.stringify(observedEnvPath)}, JSON.stringify(env));`,
    ].join("\n");

    const owner = ownGateway();
    await expect(
      owner.start({
        repoRoot: process.cwd(),
        command: {
          executablePath: process.execPath,
          argsPrefix: ["--eval", captureScript],
          usePackagedPlugins: true,
        },
        runtimeEnvPatch: {
          SAFE_VALUE: "patched",
          OPENCLAW_LIVE_SETUP_TOKEN_VALUE: "setup-token",
          OPENCLAW_QA_LIVE_ANTHROPIC_SETUP_TOKEN: "anthropic-setup-token",
          OPENCLAW_QA_CONVEX_SECRET_CI: "convex-ci-secret",
          OPENCLAW_QA_SUT_FORBIDDEN_SENTINEL: "trusted-parent-only",
          OPENCLAW_QA_TELEGRAM_GROUP_ID: "-1001234567890",
          OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN: "driver-token",
          OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN: "sut-token",
        },
        transport: {
          requiredPluginIds: [],
          createGatewayConfig: () => ({}),
        },
        transportBaseUrl: "http://127.0.0.1:43123",
      }),
    ).rejects.toThrow("gateway exited before listening");
    await expect(owner.stop()).resolves.toMatchObject({ errors: [] });

    await expect(readFile(observedEnvPath, "utf8")).resolves.toBe(
      JSON.stringify({ SAFE_VALUE: "patched" }),
    );
  });

  it("requires an Anthropic key for live Claude CLI API-key mode", async () => {
    const hostHome = await tempDirs.makeTempDir("qa-host-home-");

    expect(() =>
      buildQaRuntimeEnv({
        ...createParams({
          HOME: hostHome,
        }),
        providerMode: "live-frontier",
        forwardHostHomeForClaudeCli: true,
        claudeCliAuthMode: "api-key",
      }),
    ).toThrow("Claude CLI API-key QA mode requires ANTHROPIC_API_KEY");
  });

  it("keeps explicit Codex CLI auth home for live frontier runs", () => {
    const env = buildQaRuntimeEnv({
      ...createParams({
        CODEX_HOME: "/custom/codex-home",
        HOME: "/host/home",
      }),
      providerMode: "live-frontier",
    });

    expect(env.CODEX_HOME).toBe("/custom/codex-home");
  });

  it.each(["mock-openai", "aimock"] as const)(
    "scrubs direct and live provider keys in %s mode",
    (providerMode) => {
      const env = buildQaRuntimeEnv({
        ...createParams({
          ANTHROPIC_API_KEY: "anthropic-live",
          ANTHROPIC_OAUTH_TOKEN: "anthropic-oauth",
          CODEX_API_KEY: "codex-live",
          GEMINI_API_KEY: "gemini-live",
          GEMINI_API_KEYS: "gemini-a gemini-b",
          GOOGLE_API_KEY: "google-live",
          OPENAI_API_KEY: "openai-live",
          OPENAI_API_KEYS: "openai-a,openai-b",
          CODEX_HOME: "/host/.codex",
          OPENCLAW_LIVE_ANTHROPIC_KEY: "anthropic-live",
          OPENCLAW_LIVE_ANTHROPIC_KEYS: "anthropic-a,anthropic-b",
          OPENCLAW_LIVE_CODEX_API_KEY: "codex-live",
          OPENCLAW_LIVE_GEMINI_KEY: "gemini-live",
          OPENCLAW_LIVE_OPENAI_KEY: "openai-live",
        }),
        providerMode,
      });

      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.OPENAI_API_KEYS).toBeUndefined();
      expect(env.CODEX_API_KEY).toBeUndefined();
      expect(env.CODEX_HOME).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.ANTHROPIC_OAUTH_TOKEN).toBeUndefined();
      expect(env.GEMINI_API_KEY).toBeUndefined();
      expect(env.GEMINI_API_KEYS).toBeUndefined();
      expect(env.GOOGLE_API_KEY).toBeUndefined();
      expect(env.OPENCLAW_LIVE_OPENAI_KEY).toBeUndefined();
      expect(env.OPENCLAW_LIVE_ANTHROPIC_KEY).toBeUndefined();
      expect(env.OPENCLAW_LIVE_ANTHROPIC_KEYS).toBeUndefined();
      expect(env.OPENCLAW_LIVE_CODEX_API_KEY).toBeUndefined();
      expect(env.OPENCLAW_LIVE_GEMINI_KEY).toBeUndefined();
    },
  );

  it("preserves relative gateway retry timeouts without an absolute deadline", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("gateway closed (1012 service restart)"))
      .mockResolvedValueOnce({ ok: true });
    const waitForReady = vi.fn(async () => {});

    await expect(
      callQaGatewayWithRetry({
        logs: () => "qa logs",
        request,
        throwChildFailure: vi.fn(),
        timeoutMs: 2_000,
        waitForReady,
      }),
    ).resolves.toEqual({ ok: true });

    expect(request).toHaveBeenNthCalledWith(1, { timeoutMs: 2_000 });
    expect(request).toHaveBeenNthCalledWith(2, { timeoutMs: 2_000 });
    expect(waitForReady).toHaveBeenCalledWith(10_000);
  });

  it("bounds near-expiry restart recovery by the absolute deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const request = vi.fn(async () => {
      vi.setSystemTime(9_995);
      throw new Error("gateway closed (1012 service restart)");
    });
    const waitForReady = vi.fn(async (timeoutMs: number) => {
      vi.setSystemTime(Date.now() + timeoutMs);
    });

    await expect(
      callQaGatewayWithRetry({
        deadlineMs: 10_000,
        logs: () => "qa logs",
        request,
        throwChildFailure: vi.fn(),
        timeoutMs: 20_000,
        waitForReady,
      }),
    ).rejects.toThrow("gateway call deadline exceeded");

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith({ deadlineMs: 10_000, timeoutMs: 10_000 });
    expect(waitForReady).toHaveBeenCalledWith(5);
    expect(Date.now()).toBe(10_000);
  });

  it("waits for a fresh in-process restart boundary after the current log offset", async () => {
    let logs = "old restart mode: in-process restart\n";
    const mark = logs.length;
    const wait = waitForQaGatewayRestartBoundary({
      readLogsSince: (since) => logs.slice(since),
      mark,
      pollMs: 1,
      timeoutMs: 100,
    });

    logs += "signal SIGUSR1 received\nrestart mode: in-process restart\n";

    await expect(wait).resolves.toBeUndefined();
  });

  it("keeps restart offsets stable after stderr output", async () => {
    const output = createQaGatewayChildLogCollector();
    output.push("stdout", Buffer.from("gateway ready\n"));
    output.push("stderr", Buffer.from("stderr warning\n"));
    const mark = output.mark();
    const wait = waitForQaGatewayRestartBoundary({
      readLogsSince: (since) => output.readSince(since),
      mark,
      pollMs: 1,
      timeoutMs: 100,
    });

    output.push(
      "stdout",
      Buffer.from("signal SIGUSR1 received\nrestart mode: in-process restart\n"),
    );

    await expect(wait).resolves.toBeUndefined();
  });

  it("bounds diagnostics while monotonic marks retain fresh output semantics", () => {
    const output = createQaGatewayChildLogCollector();
    output.push("stdout", Buffer.from(`old😀${"x".repeat(70_000)}`));
    const mark = output.mark();
    output.push("stdout", Buffer.from("fresh restart mode: in-process restart\n"));

    expect(output.text()).toContain("[qa-lab] older gateway logs truncated");
    expect(output.text().length).toBeLessThan(66_000);
    expect(output.readSince(mark)).toBe("fresh restart mode: in-process restart\n");
    expect(output.text()).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
    );
  });

  it("decodes interleaved stdout and stderr independently", () => {
    const output = createQaGatewayChildLogCollector();
    const stdout = Buffer.from("before 😀 after\n");

    output.push("stdout", stdout.subarray(0, 9));
    output.push("stderr", Buffer.from("warning ⚠️\n"));
    output.push("stdout", stdout.subarray(9));

    expect(output.text()).toBe("before warning ⚠️\n😀 after");
    expect(output.text()).not.toContain("�");
  });

  it("times out when a SIGUSR1 restart never reaches the boundary", async () => {
    await expect(
      waitForQaGatewayRestartBoundary({
        readLogsSince: () => "signal SIGUSR1 received\n",
        mark: 0,
        pollMs: 1,
        timeoutMs: 1,
      }),
    ).rejects.toThrow("qa gateway child did not reach restart boundary");
  });

  it("keeps oversized restart-boundary poll intervals within the timeout", async () => {
    await expect(
      waitForQaGatewayRestartBoundary({
        readLogsSince: () => "signal SIGUSR1 received\n",
        mark: 0,
        pollMs: Number.MAX_SAFE_INTEGER,
        timeoutMs: 5,
      }),
    ).rejects.toThrow("qa gateway child did not reach restart boundary");
  });

  it("stages a live Anthropic setup-token profile for isolated QA workers", async () => {
    const stateDir = await tempDirs.makeTempDir("qa-setup-token-state-");
    const token = `sk-ant-oat01-${"c".repeat(80)}`;

    const cfg = await stageQaLiveAnthropicSetupToken({
      cfg: {},
      stateDir,
      env: {
        OPENCLAW_LIVE_SETUP_TOKEN_VALUE: token,
      },
    });

    const configProfile = requireAuthProfile(cfg.auth?.profiles, "anthropic:qa-setup-token");
    expect(configProfile.provider).toBe("anthropic");
    expect(configProfile.mode).toBe("token");
    const storeProfile = requireAuthProfile(
      readAuthProfileStore(stateDir, "main").profiles,
      "anthropic:qa-setup-token",
    );
    expect(storeProfile.type).toBe("token");
    expect(storeProfile.provider).toBe("anthropic");
    expect(storeProfile.token).toBe(token);
  });

  it("stages live env API-key profiles for isolated QA workers", async () => {
    const stateDir = await tempDirs.makeTempDir("qa-live-api-key-state-");

    const cfg = await stageQaLiveApiKeyProfiles({
      cfg: {},
      stateDir,
      providerIds: ["openai"],
      env: {
        OPENAI_API_KEY: "qa-live-not-a-real-key",
      },
    });

    const configProfile = requireAuthProfile(cfg.auth?.profiles, "qa-live-openai-env");
    expect(configProfile.provider).toBe("openai");
    expect(configProfile.mode).toBe("api_key");
    expect(configProfile.displayName).toBe("QA live openai env credential");
    expect(Object.values(cfg.auth?.profiles ?? {})).not.toContainEqual(
      expect.objectContaining({ provider: "anthropic" }),
    );

    for (const agentId of ["main", "qa"]) {
      const profiles = readAuthProfileStore(stateDir, agentId).profiles;
      const storeProfile = requireAuthProfile(profiles, "qa-live-openai-env");
      expect(storeProfile.type).toBe("api_key");
      expect(storeProfile.provider).toBe("openai");
      expect(storeProfile.key).toBe("qa-live-not-a-real-key");
      expect(Object.values(profiles)).not.toContainEqual(
        expect.objectContaining({ provider: "anthropic" }),
      );
    }
  });

  it("stages direct live OpenAI API-key aliases for isolated QA workers", async () => {
    const stateDir = await tempDirs.makeTempDir("qa-live-codex-direct-key-state-");

    const cfg = await stageQaLiveApiKeyProfiles({
      cfg: {},
      stateDir,
      providerIds: ["openai"],
      env: {
        OPENCLAW_LIVE_CODEX_API_KEY: "qa-live-direct-codex-key",
      },
    });

    const storeProfile = requireAuthProfile(
      readAuthProfileStore(stateDir, "qa").profiles,
      "qa-live-openai-env",
    );
    expect(storeProfile.type).toBe("api_key");
    expect(storeProfile.provider).toBe("openai");
    expect(storeProfile.key).toBe("qa-live-direct-codex-key");

    expect(() =>
      assertQaLiveCodexAuthAvailable({
        cfg,
        providerIds: ["openai"],
        env: {
          OPENCLAW_LIVE_CODEX_API_KEY: "qa-live-direct-codex-key",
        },
        readCodexCredentials: () => null,
      }),
    ).not.toThrow();
  });

  it("fails fast when live OpenAI runs have no portable QA auth", () => {
    expect(() =>
      assertQaLiveCodexAuthAvailable({
        cfg: {},
        providerIds: ["openai"],
        env: {
          CODEX_HOME: path.join(os.tmpdir(), "missing-openclaw-codex-home"),
        },
        readCodexCredentials: () => null,
      }),
    ).toThrow("QA live-frontier cannot run Codex-backed OpenAI models");
  });

  it("does not require Codex auth for custom OpenAI-compatible provider configs", () => {
    expect(() =>
      assertQaLiveCodexAuthAvailable({
        cfg: {
          models: {
            providers: {
              openai: {
                baseUrl: "https://proxy.example.test/v1",
                models: [],
              },
            },
          },
        },
        providerIds: ["openai"],
        env: {
          CODEX_HOME: path.join(os.tmpdir(), "missing-openclaw-codex-home"),
        },
        readCodexCredentials: () => null,
      }),
    ).not.toThrow();
  });

  it("fails fast when forced Codex runtime uses OpenAI model refs without portable QA auth", () => {
    expect(() =>
      assertQaLiveCodexAuthAvailable({
        cfg: {},
        providerIds: ["openai"],
        env: {
          CODEX_HOME: path.join(os.tmpdir(), "missing-openclaw-codex-home"),
          OPENCLAW_QA_FORCE_RUNTIME: "codex",
        },
        readCodexCredentials: () => null,
      }),
    ).toThrow("QA live-frontier cannot run Codex-backed OpenAI models");
  });

  it("accepts OpenAI API-key fallback auth for forced Codex runtime QA runs", () => {
    expect(() =>
      assertQaLiveCodexAuthAvailable({
        cfg: {},
        providerIds: ["openai"],
        env: {
          OPENCLAW_LIVE_OPENAI_KEY: "qa-live-codex-fallback-key",
          OPENCLAW_QA_FORCE_RUNTIME: "codex",
        },
        readCodexCredentials: () => null,
      }),
    ).not.toThrow();
  });

  it("stages configured OpenAI API keys for live QA runs", async () => {
    const stateDir = await tempDirs.makeTempDir("qa-live-codex-config-key-state-");
    const cfg = await stageQaLiveApiKeyProfiles({
      cfg: {
        models: {
          providers: {
            openai: {
              baseUrl: "",
              models: [],
              apiKey: "qa-configured-not-a-real-key",
            },
          },
        },
      },
      stateDir,
      providerIds: ["openai"],
      env: {},
    });

    const configProfile = requireAuthProfile(cfg.auth?.profiles, "qa-live-openai-env");
    expect(configProfile.provider).toBe("openai");
    expect(configProfile.mode).toBe("api_key");
    for (const agentId of ["main", "qa"]) {
      const storeProfile = requireAuthProfile(
        readAuthProfileStore(stateDir, agentId).profiles,
        "qa-live-openai-env",
      );
      expect(storeProfile.type).toBe("api_key");
      expect(storeProfile.provider).toBe("openai");
      expect(storeProfile.key).toBe("qa-configured-not-a-real-key");
    }

    expect(() =>
      assertQaLiveCodexAuthAvailable({
        cfg,
        providerIds: ["openai"],
        env: {},
        readCodexCredentials: () => null,
      }),
    ).not.toThrow();
  });

  it("stages configured OpenAI env secret refs for default OpenAI live QA runs", async () => {
    const stateDir = await tempDirs.makeTempDir("qa-live-codex-config-ref-state-");
    const env = {
      OPENCLAW_LIVE_CODEX_API_KEY: "qa-configured-env-ref-not-a-real-key",
    };
    const cfg = await stageQaLiveApiKeyProfiles({
      cfg: {
        models: {
          providers: {
            openai: {
              baseUrl: "",
              models: [],
              apiKey: {
                source: "env",
                provider: "default",
                id: "OPENCLAW_LIVE_CODEX_API_KEY",
              },
            },
          },
        },
      },
      stateDir,
      providerIds: ["openai"],
      env,
    });

    const storeProfile = requireAuthProfile(
      readAuthProfileStore(stateDir, "qa").profiles,
      "qa-live-openai-env",
    );
    expect(storeProfile.type).toBe("api_key");
    expect(storeProfile.provider).toBe("openai");
    expect(storeProfile.key).toBe("qa-configured-env-ref-not-a-real-key");

    expect(() =>
      assertQaLiveCodexAuthAvailable({
        cfg,
        providerIds: ["openai"],
        env,
        readCodexCredentials: () => null,
      }),
    ).not.toThrow();
  });

  it("stages configured OpenAI env markers for live QA runs", async () => {
    const stateDir = await tempDirs.makeTempDir("qa-live-codex-config-marker-state-");
    const cfg = await stageQaLiveApiKeyProfiles({
      cfg: {
        models: {
          providers: {
            openai: {
              baseUrl: "",
              models: [],
              apiKey: "OPENCLAW_LIVE_CODEX_API_KEY",
            },
          },
        },
      },
      stateDir,
      providerIds: ["openai"],
      env: {
        OPENCLAW_LIVE_CODEX_API_KEY: "qa-configured-marker-not-a-real-key",
      },
    });

    const storeProfile = requireAuthProfile(
      readAuthProfileStore(stateDir, "main").profiles,
      "qa-live-openai-env",
    );
    expect(storeProfile.type).toBe("api_key");
    expect(storeProfile.provider).toBe("openai");
    expect(storeProfile.key).toBe("qa-configured-marker-not-a-real-key");

    expect(() =>
      assertQaLiveCodexAuthAvailable({
        cfg,
        providerIds: ["openai"],
        env: {},
        readCodexCredentials: () => null,
      }),
    ).not.toThrow();
  });

  it("accepts a logged-in Codex CLI home for live OpenAI QA runs", () => {
    const readCodexCredentials = vi.fn(() => ({
      type: "oauth" as const,
      provider: "openai",
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
    }));

    expect(() =>
      assertQaLiveCodexAuthAvailable({
        cfg: {},
        providerIds: ["openai"],
        env: {
          CODEX_HOME: "/host/.codex",
        },
        readCodexCredentials,
      }),
    ).not.toThrow();
    expect(readCodexCredentials).toHaveBeenCalledWith({
      codexHome: "/host/.codex",
      allowKeychainPrompt: false,
      ttlMs: 5_000,
    });
  });

  it("stages placeholder mock auth profiles per agent dir so mock-openai runs can resolve credentials", async () => {
    const stateDir = await tempDirs.makeTempDir("qa-mock-auth-");

    const cfg = await stageQaMockAuthProfiles({
      cfg: {},
      stateDir,
    });

    // Config side: both providers should have a profile entry with mode
    // "api_key" so the runtime picks up the staging without any further
    // config mutation.
    const openaiConfigProfile = requireAuthProfile(cfg.auth?.profiles, "qa-mock-openai");
    expect(openaiConfigProfile.provider).toBe("openai");
    expect(openaiConfigProfile.mode).toBe("api_key");
    expect(openaiConfigProfile.displayName).toBe("QA mock openai credential");
    const anthropicConfigProfile = requireAuthProfile(cfg.auth?.profiles, "qa-mock-anthropic");
    expect(anthropicConfigProfile.provider).toBe("anthropic");
    expect(anthropicConfigProfile.mode).toBe("api_key");
    expect(anthropicConfigProfile.displayName).toBe("QA mock anthropic credential");

    // Store side: each agent dir has its own canonical SQLite credential rows.
    for (const agentId of ["main", "qa"]) {
      const parsed = readAuthProfileStore(stateDir, agentId);
      const openaiStoreProfile = requireAuthProfile(parsed.profiles, "qa-mock-openai");
      expect(openaiStoreProfile.type).toBe("api_key");
      expect(openaiStoreProfile.provider).toBe("openai");
      expect(openaiStoreProfile.key).toBe("qa-mock-not-a-real-key");
      const anthropicStoreProfile = requireAuthProfile(parsed.profiles, "qa-mock-anthropic");
      expect(anthropicStoreProfile.type).toBe("api_key");
      expect(anthropicStoreProfile.provider).toBe("anthropic");
      expect(anthropicStoreProfile.key).toBe("qa-mock-not-a-real-key");
    }
  });

  it.each([false, true])(
    "lets an explicit packaged command own mock auth and plugins before gateway spawn (legacy=%s)",
    async (legacy) => {
      const fixtureRoot = await tempDirs.makeTempDir("qa-packaged-auth-");
      const tempParentDir = path.join(fixtureRoot, "gateway-temp");
      const recordPath = path.join(fixtureRoot, "commands.jsonl");
      const fixturePath = await writePackagedGatewayFixture(fixtureRoot);
      await mkdir(tempParentDir);

      const owner = ownGateway();
      await expect(
        owner.start({
          repoRoot: process.cwd(),
          command: {
            executablePath: process.execPath,
            argsPrefix: [fixturePath],
            tempParentDir,
            usePackagedPlugins: true,
          },
          providerMode: "mock-openai",
          transportBaseUrl: "http://127.0.0.1:43123",
          runtimeEnvPatch: {
            QA_RECORD_PATH: recordPath,
            QA_LEGACY_PLUGIN_SETUP: legacy ? "1" : "0",
          },
        }),
      ).rejects.toThrow("fixture gateway exit");
      await expect(owner.stop()).resolves.toMatchObject({ errors: [] });

      const records = await readJsonLines(recordPath);
      const authRecords = records.filter((record) => record.kind === "auth");
      expect(authRecords).toHaveLength(2);
      expect(authRecords.map((record) => record.args)).toEqual([
        [
          "models",
          "auth",
          "--agent",
          "qa",
          "paste-api-key",
          "--provider",
          "openai",
          "--profile-id",
          "qa-mock-openai",
        ],
        [
          "models",
          "auth",
          "--agent",
          "qa",
          "paste-api-key",
          "--provider",
          "anthropic",
          "--profile-id",
          "qa-mock-anthropic",
        ],
      ]);
      for (const record of authRecords) {
        expect(record.stdin).toMatch(/^sk-qa-mock-[a-f0-9]{32}\n$/u);
        expect(record.env).toMatchObject({
          OPENCLAW_CLI: "1",
        });
        expect(record.configMode).toBe(0o600);
        expect(record.configRegular).toBe(true);
        expect(record.configSymlink).toBe(false);
      }
      expect(authRecords.map((record) => record.dbExists)).toEqual([false, true]);
      const authConfigPaths = authRecords.map((record) => String(record.configPath));
      expect(new Set(authConfigPaths).size).toBe(1);
      expect(authConfigPaths[0]).toBe(
        path.join(String(authRecords[0]?.stateDir), "qa-auth-bootstrap", "openclaw.json"),
      );
      expect(records.at(-1)).toMatchObject({
        kind: "gateway",
        authProfileIds: ["qa-mock-openai", "qa-mock-anthropic"],
        dbExists: true,
      });
      expect(records.at(-1)?.configPath).not.toBe(authConfigPaths[0]);
      expect(records.at(-1)?.fixtureProfiles).toBeUndefined();
      expect(records.map((record) => record.kind)).toEqual(["auth", "auth", "plugins", "gateway"]);
      expect(records[2]).toMatchObject({
        args: [
          "update",
          "repair",
          ...(legacy ? [] : ["--accept-capabilities"]),
          "--yes",
          "--no-restart",
          "--json",
        ],
        configPath: records.at(-1)?.configPath,
        stateDir: records.at(-1)?.stateDir,
      });
      expect(new Set(records.map((record) => record.authDbPath)).size).toBe(1);
    },
  );

  it.each([
    { retry: "bind", configBuilds: 2 },
    { retry: "migration", configBuilds: 1 },
  ])(
    "preserves packaged config repair across $retry startup retries",
    async ({ retry, configBuilds }) => {
      const fixtureRoot = await tempDirs.makeTempDir("qa-packaged-retry-");
      const tempParentDir = path.join(fixtureRoot, "gateway-temp");
      const recordPath = path.join(fixtureRoot, "commands.jsonl");
      const fixturePath = await writePackagedGatewayFixture(fixtureRoot);
      await mkdir(tempParentDir);
      const mutateConfig = vi.fn((cfg: OpenClawConfig) => cfg);
      const owner = ownGateway();
      await expect(
        owner.start({
          repoRoot: process.cwd(),
          command: {
            executablePath: process.execPath,
            argsPrefix: [fixturePath],
            tempParentDir,
            usePackagedPlugins: true,
          },
          providerMode: "mock-openai",
          transportBaseUrl: "http://127.0.0.1:43123",
          runtimeEnvPatch: { QA_RECORD_PATH: recordPath, QA_STARTUP_RETRY: retry },
          mutateConfig,
        }),
      ).rejects.toThrow("fixture gateway exit");
      const records = await readJsonLines(recordPath);
      const gateways = records.filter((record) => record.kind === "gateway");
      expect(gateways).toHaveLength(2);
      expect(gateways.map((record) => record.sourcePluginConfigured)).toEqual([false, false]);
      expect(records.filter((record) => record.kind === "plugins")).toHaveLength(configBuilds);
      expect(mutateConfig).toHaveBeenCalledTimes(configBuilds);
      expect(records.filter((record) => record.kind === "auth")).toHaveLength(2);
      expect(new Set(records.map((record) => record.stateDir)).size).toBe(1);
      for (const gateway of gateways) {
        expect(gateway.args).toContainEqual(String(gateway.configPort));
        expect(gateway).toMatchObject({
          dbExists: true,
          authProfileIds: ["qa-mock-openai", "qa-mock-anthropic"],
        });
      }
      if (retry === "migration") {
        expect(gateways[1]?.configPort).toBe(gateways[0]?.configPort);
      }
    },
  );

  it("blocks packaged gateway spawn when candidate plugin setup fails", async () => {
    const fixtureRoot = await tempDirs.makeTempDir("qa-packaged-plugins-fail-");
    const tempParentDir = path.join(fixtureRoot, "gateway-temp");
    const recordPath = path.join(fixtureRoot, "commands.jsonl");
    const fixturePath = await writePackagedGatewayFixture(fixtureRoot);
    await mkdir(tempParentDir);
    const owner = ownGateway();
    const error = await owner
      .start({
        repoRoot: process.cwd(),
        command: {
          executablePath: process.execPath,
          argsPrefix: [fixturePath],
          tempParentDir,
          usePackagedPlugins: true,
        },
        providerMode: "mock-openai",
        transportBaseUrl: "http://127.0.0.1:43123",
        runtimeEnvPatch: { QA_RECORD_PATH: recordPath, QA_FAIL_PLUGIN_SETUP: "1" },
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) {
      throw new Error("expected package plugin setup error");
    }
    expect(error.message).toContain("installed package plugin setup failed: OpenClaw CLI exited 8");
    expect(error.message).not.toContain("fixture-plugin-secret");
    expect(String(error.cause)).not.toContain("fixture-plugin-secret");
    const records = await readJsonLines(recordPath);
    expect(records.map((record) => record.kind)).toEqual(["auth", "auth", "plugins"]);
  });

  it("blocks packaged gateway spawn when candidate auth bootstrap fails", async () => {
    const fixtureRoot = await tempDirs.makeTempDir("qa-packaged-auth-fail-");
    const tempParentDir = path.join(fixtureRoot, "gateway-temp");
    const recordPath = path.join(fixtureRoot, "commands.jsonl");
    const fixturePath = await writePackagedGatewayFixture(fixtureRoot);
    await mkdir(tempParentDir);

    const owner = ownGateway();
    const result = owner.start({
      repoRoot: process.cwd(),
      command: {
        executablePath: process.execPath,
        argsPrefix: [fixturePath],
        tempParentDir,
        usePackagedPlugins: true,
      },
      providerMode: "mock-openai",
      transportBaseUrl: "http://127.0.0.1:43123",
      runtimeEnvPatch: {
        QA_FAIL_PROVIDER: "openai",
        QA_RECORD_PATH: recordPath,
      },
    });

    const error = await result.catch((caught: unknown) => caught);
    await expect(owner.stop()).resolves.toMatchObject({ errors: [] });
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) {
      throw new Error("expected package auth bootstrap error");
    }
    expect(error.message).toContain(
      "installed package mock auth bootstrap failed for openai: OpenClaw CLI exited 9: Authorization: Bearer <redacted>",
    );
    const records = await readJsonLines(recordPath);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: "auth",
      dbExists: false,
      configMode: 0o600,
      configRegular: true,
      configSymlink: false,
    });
    const submittedKey = String(records[0]?.stdin).trim();
    expect(submittedKey).toMatch(/^sk-qa-mock-[a-f0-9]{32}$/u);
    expect(error.message).not.toContain(submittedKey);
    expect(String(error.cause)).not.toContain(submittedKey);
    expect(records.some((record) => record.kind === "gateway")).toBe(false);
  });

  it("stages mock profiles only for the requested agents and providers when callers override the defaults", async () => {
    const stateDir = await tempDirs.makeTempDir("qa-mock-auth-override-");

    const cfg = await stageQaMockAuthProfiles({
      cfg: {},
      stateDir,
      agentIds: ["qa"],
      providers: ["openai"],
    });

    const openaiConfigProfile = requireAuthProfile(cfg.auth?.profiles, "qa-mock-openai");
    expect(openaiConfigProfile.provider).toBe("openai");
    expect(openaiConfigProfile.mode).toBe("api_key");
    // Anthropic should NOT be staged when the caller restricts providers.
    expect(cfg.auth?.profiles?.["qa-mock-anthropic"]).toBeUndefined();

    const qaStore = readAuthProfileStore(stateDir, "qa");
    const openaiStoreProfile = requireAuthProfile(qaStore.profiles, "qa-mock-openai");
    expect(openaiStoreProfile.provider).toBe("openai");
    expect(openaiStoreProfile.type).toBe("api_key");
    expect(qaStore.profiles["qa-mock-anthropic"]).toBeUndefined();

    // The main agent's canonical database should not exist because it was not requested.
    await expect(
      lstat(path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite")),
    ).rejects.toThrow(/ENOENT/);
  });

  it("force-stops gateway children that ignore the graceful signal", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 12345,
      exitCode: null as number | null,
      signalCode: null as string | null,
      kill: vi.fn((signal?: "SIGTERM" | "SIGKILL" | number) => {
        if (signal === "SIGKILL") {
          child.signalCode = "SIGKILL";
          queueMicrotask(() => child.emit("exit"));
        }
        return true;
      }),
    });
    const processKill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal === "SIGKILL") {
        child.signalCode = "SIGKILL";
        queueMicrotask(() => child.emit("exit"));
      }
      if (signal === 0 && child.signalCode) {
        throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      }
      return true;
    });

    await stopQaGatewayChildProcessTree(
      child as unknown as Parameters<typeof stopQaGatewayChildProcessTree>[0],
      {
        gracefulTimeoutMs: 1,
        forceTimeoutMs: 10,
      },
    );

    if (process.platform === "win32") {
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    } else {
      expect(processKill).toHaveBeenCalledWith(-12345, "SIGTERM");
      expect(processKill).toHaveBeenCalledWith(-12345, "SIGKILL");
    }
    expect([child.exitCode, child.signalCode]).not.toEqual([null, null]);
  });

  it("force-closes a gateway log stream whose final flush never settles", async () => {
    const stream = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
      final() {
        // Simulate the stalled filesystem flush observed in the release profile.
      },
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await closeQaGatewayLogStream(stream as never, "stdout", 1);

    expect(stream.destroyed).toBe(true);
    expect(stderr).toHaveBeenCalledWith(
      "[qa-suite] stdout gateway log flush exceeded 1ms; forcing close\n",
    );
  });

  it.runIf(process.platform !== "win32")(
    "fails closed when forced gateway process-group shutdown times out",
    async () => {
      const child = Object.assign(new EventEmitter(), {
        pid: 12345,
        exitCode: null as number | null,
        signalCode: null as string | null,
        kill: vi.fn(() => true),
      });
      vi.spyOn(process, "kill").mockImplementation(() => true);

      await expect(
        stopQaGatewayChildProcessTree(child as never, {
          gracefulTimeoutMs: 1,
          forceTimeoutMs: 1,
          inspectLinuxProcessGroup: () => null,
        }),
      ).rejects.toThrow(
        process.platform === "linux"
          ? "qa gateway process tree remained alive after forced shutdown: pgid=12345 members=unknown (/proc unavailable) childExitRecorded=false"
          : "qa gateway process tree remained alive after forced shutdown: pid=12345 childExitRecorded=false",
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not confirm shutdown when an exited leader's group probe is denied",
    async () => {
      const child = Object.assign(new EventEmitter(), {
        pid: 12345,
        exitCode: 17,
        signalCode: null,
        kill: vi.fn(() => false),
      });
      const realKill = process.kill.bind(process);
      const fault = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (pid === -child.pid) {
          throw Object.assign(new Error("owned fake group probe denied"), { code: "EPERM" });
        }
        return realKill(pid, signal);
      });
      try {
        await expect(
          stopQaGatewayChildProcessTree(child as never, {
            gracefulTimeoutMs: 1,
            forceTimeoutMs: 1,
            inspectLinuxProcessGroup: () => null,
          }),
        ).rejects.toThrow("process tree remained alive");
      } finally {
        fault.mockRestore();
      }
    },
  );

  it("reports Linux process-tree diagnostics when forced shutdown times out", async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const child = Object.assign(new EventEmitter(), {
      pid: 12345,
      exitCode: null as number | null,
      signalCode: null as string | null,
      kill: vi.fn(() => true),
    });
    vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      await expect(
        stopQaGatewayChildProcessTree(child as never, {
          gracefulTimeoutMs: 1,
          forceTimeoutMs: 1,
          inspectLinuxProcessGroup: () => ({
            alive: true,
            diagnostics:
              'pgid=12345 members=[pid=12345 state=Z command="gateway", pid=12346 state=S command="worker"]',
          }),
        }),
      ).rejects.toThrow(
        'qa gateway process tree remained alive after forced shutdown: pgid=12345 members=[pid=12345 state=Z command="gateway", pid=12346 state=S command="worker"] childExitRecorded=false',
      );
    } finally {
      if (platformDescriptor) {
        Object.defineProperty(process, "platform", platformDescriptor);
      }
    }
  });

  it("does not trust an exited gateway wrapper while its process group is alive", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 12346,
      exitCode: 0 as number | null,
      signalCode: null as string | null,
      kill: vi.fn(),
    });
    let sawForceKill = false;
    let postKillLivenessChecks = 0;
    const processKill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal === "SIGKILL") {
        sawForceKill = true;
        return true;
      }
      if (signal === 0 && sawForceKill) {
        postKillLivenessChecks += 1;
        if (postKillLivenessChecks >= 2) {
          throw Object.assign(new Error("no such process"), { code: "ESRCH" });
        }
      }
      return true;
    });

    await stopQaGatewayChildProcessTree(
      child as unknown as Parameters<typeof stopQaGatewayChildProcessTree>[0],
      {
        gracefulTimeoutMs: 1,
        forceTimeoutMs: 50,
        inspectLinuxProcessGroup: () => ({
          alive: !sawForceKill || postKillLivenessChecks < 2,
          diagnostics: 'pgid=12346 members=[pid=12347 state=S command="worker"]',
        }),
      },
    );

    if (process.platform === "win32") {
      expect(child.kill).not.toHaveBeenCalled();
    } else {
      expect(processKill).toHaveBeenCalledWith(-12346, "SIGTERM");
      expect(processKill).toHaveBeenCalledWith(-12346, "SIGKILL");
      expect(postKillLivenessChecks).toBe(2);
      expect(child.kill).not.toHaveBeenCalled();
    }
  });

  it.each([
    ["another gateway instance is already listening on ws://127.0.0.1:43124", "bind-collision"],
    [
      "failed to bind gateway socket on ws://127.0.0.1:43124: Error: listen EADDRINUSE",
      "bind-collision",
    ],
    [
      "OpenClaw plugin migration inputs changed during startup convergence; refusing to report the gateway ready. Restart OpenClaw so state migrations run against the final config and plugin inventory.",
      "migration-convergence-restart",
    ],
  ] as const)("classifies %s", (details, expectedKind) => {
    expect(
      resolveQaGatewayStartupRetry({
        attempt: 1,
        details,
        migrationConvergenceRestartUsed: false,
      })?.kind,
    ).toBe(expectedKind);
  });

  it.each([
    "OpenClaw startup migrations did not complete cleanly; refusing to report the gateway ready.",
    "OpenClaw plugin migration inputs changed during startup convergence",
    "Restart OpenClaw so state migrations can continue.",
    "gateway failed to become healthy",
  ])("does not retry unrelated startup failure: %s", (details) => {
    expect(
      resolveQaGatewayStartupRetry({
        attempt: 1,
        details,
        migrationConvergenceRestartUsed: false,
      }),
    ).toBeNull();
  });

  it("restarts migration convergence once with the same launch state", () => {
    const first = resolveQaGatewayStartupRetry({
      attempt: 1,
      details:
        "OpenClaw plugin migration inputs changed during startup convergence; refusing readiness.",
      migrationConvergenceRestartUsed: false,
    });

    expect(first).toEqual({
      kind: "migration-convergence-restart",
      reuseLaunchState: true,
      migrationConvergenceRestartUsed: true,
    });
    expect(
      resolveQaGatewayStartupRetry({
        attempt: 2,
        details:
          "OpenClaw plugin migration inputs changed during startup convergence; refusing readiness.",
        migrationConvergenceRestartUsed: first?.migrationConvergenceRestartUsed ?? false,
      }),
    ).toBeNull();
  });

  it("rotates launch state only for a bind collision", () => {
    expect(
      resolveQaGatewayStartupRetry({
        attempt: 1,
        details: "listen EADDRINUSE: address already in use",
        migrationConvergenceRestartUsed: false,
      }),
    ).toEqual({
      kind: "bind-collision",
      reuseLaunchState: false,
      migrationConvergenceRestartUsed: false,
    });
  });

  it("fails immediately for generic exits and after the startup attempt budget", () => {
    expect(
      resolveQaGatewayStartupRetry({
        attempt: 1,
        details: "gateway exited with code 1",
        migrationConvergenceRestartUsed: false,
      }),
    ).toBeNull();
    expect(
      resolveQaGatewayStartupRetry({
        attempt: 5,
        details: "listen EADDRINUSE",
        migrationConvergenceRestartUsed: false,
      }),
    ).toBeNull();
  });

  it("treats startup token mismatches as retryable rpc startup errors", () => {
    expect(
      isRetryableRpcStartupError(
        "unauthorized: gateway token mismatch (set gateway.remote.token to match gateway.auth.token)",
      ),
    ).toBe(true);
    expect(isRetryableRpcStartupError("permission denied")).toBe(false);
  });

  it("preserves only sanitized gateway debug artifacts", async () => {
    const tempRoot = await tempDirs.makeTempDir("qa-gateway-preserve-src-");
    const repoRoot = await tempDirs.makeTempDir("qa-gateway-preserve-repo-");

    const stdoutLogPath = path.join(tempRoot, "gateway.stdout.log");
    const stderrLogPath = path.join(tempRoot, "gateway.stderr.log");
    const artifactDir = path.join(repoRoot, ".artifacts", "qa-e2e", "gateway-runtime");
    await mkdir(path.dirname(artifactDir), { recursive: true });
    await writeFile(
      stdoutLogPath,
      [
        "OPENCLAW_GATEWAY_TOKEN=qa-suite-token",
        'OPENAI_API_KEY="openai-live"',
        "OPENCLAW_QA_CONVEX_SECRET_CI=convex-ci-secret",
        "OPENCLAW_QA_CONVEX_SECRET_MAINTAINER=convex-maintainer-secret",
        "OPENCLAW_LIVE_CODEX_API_KEY=codex-live-secret",
        "botToken=12345:AbCdEfGhIjKl",
        "--botToken=12345:flag-secret",
        '"driverToken":"12345:driver-secr3t"',
        "sutToken='12345:sut-secr3t'",
        "leaseToken=lease-12345",
        '"apiKey":"secret-json-api-key"',
        "clientSecret=secret-client-secret&secret-tail",
        "url=http://127.0.0.1:18789/#token=abc123",
        "callback=https://gateway.example.test/callback?access_token=secret-access-token&ok=1",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      stderrLogPath,
      [
        "Authorization: Bearer secret+/token=123456",
        "Cookie: qa_session=secret-cookie; theme=dark",
        "Set-Cookie: qa_session=secret-cookie; HttpOnly",
        "x-api-key: secret-header-api-key",
      ].join("\n"),
      "utf8",
    );
    await mkdir(path.join(tempRoot, "state"), { recursive: true });
    await writeFile(path.join(tempRoot, "state", "secret.txt"), "do-not-copy", "utf8");

    await preserveQaGatewayDebugArtifacts({
      preserveToDir: artifactDir,
      stdoutLogPath,
      stderrLogPath,
      tempRoot,
      repoRoot,
    });

    expect((await readdir(artifactDir)).toSorted()).toEqual([
      "README.txt",
      "gateway.stderr.log",
      "gateway.stdout.log",
    ]);
    await expect(readFile(path.join(artifactDir, "gateway.stdout.log"), "utf8")).resolves.toBe(
      [
        "OPENCLAW_GATEWAY_TOKEN=<redacted>",
        "OPENAI_API_KEY=<redacted>",
        "OPENCLAW_QA_CONVEX_SECRET_CI=<redacted>",
        "OPENCLAW_QA_CONVEX_SECRET_MAINTAINER=<redacted>",
        "OPENCLAW_LIVE_CODEX_API_KEY=<redacted>",
        "botToken=<redacted>",
        "--botToken=<redacted>",
        '"driverToken":"<redacted>"',
        "sutToken=<redacted>",
        "leaseToken=<redacted>",
        '"apiKey":"<redacted>"',
        "clientSecret=<redacted>",
        "url=http://127.0.0.1:18789/#token=<redacted>",
        "callback=https://gateway.example.test/callback?access_token=<redacted>&ok=1",
      ].join("\n"),
    );
    await expect(readFile(path.join(artifactDir, "gateway.stderr.log"), "utf8")).resolves.toBe(
      [
        "Authorization: Bearer <redacted>",
        "Cookie: <redacted>",
        "Set-Cookie: <redacted>",
        "x-api-key: <redacted>",
      ].join("\n"),
    );
    await expect(readFile(path.join(artifactDir, "README.txt"), "utf8")).resolves.toContain(
      "was not copied because it may contain credentials or auth tokens",
    );
    await expect(readFile(path.join(artifactDir, "README.txt"), "utf8")).resolves.not.toContain(
      tempRoot,
    );
  });
});

describe("qa bundled plugin dir", () => {
  it("creates a scoped bundled plugin tree with the always-staged runtime facade", async () => {
    const repoRoot = await tempDirs.makeTempDir("qa-bundled-scope-");
    await writeFile(
      path.join(repoRoot, "package.json"),
      JSON.stringify(
        {
          name: "openclaw",
          type: "module",
          exports: {
            "./plugin-sdk/account-id": {
              default: "./dist/plugin-sdk/account-id.js",
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await mkdir(path.join(repoRoot, "dist", "extensions", "qa-channel"), { recursive: true });
    await mkdir(path.join(repoRoot, "dist", "extensions", "memory-core"), { recursive: true });
    await mkdir(path.join(repoRoot, "dist", "extensions", "image-generation-core"), {
      recursive: true,
    });
    await mkdir(path.join(repoRoot, "dist", "extensions", "unused-plugin"), { recursive: true });
    await mkdir(path.join(repoRoot, "dist", "plugin-sdk"), { recursive: true });
    await writeFile(
      path.join(repoRoot, "dist", "plugin-sdk", "account-id.js"),
      "export const normalizeAccountId = (value) => value.toLowerCase();\n",
      "utf8",
    );
    await writeFile(
      path.join(repoRoot, "dist", "extensions", "qa-channel", "package.json"),
      JSON.stringify({ name: "@openclaw/qa-channel", type: "module" }, null, 2),
      "utf8",
    );
    await writeFile(
      path.join(repoRoot, "dist", "extensions", "qa-channel", "index.js"),
      [
        'import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";',
        'export const accountId = normalizeAccountId("QA");',
        "",
      ].join("\n"),
      "utf8",
    );
    await mkdir(path.join(repoRoot, "extensions", "qa-channel"), { recursive: true });
    await writeFile(
      path.join(repoRoot, "extensions", "qa-channel", "openclaw.plugin.json"),
      JSON.stringify({
        id: "qa-channel",
        toolMetadata: { qa_read: { replaySafe: true } },
      }),
      "utf8",
    );
    await writeFile(path.join(repoRoot, "dist", "shared-chunk-abc123.js"), "export {};\n", "utf8");
    const tempRoot = await tempDirs.makeTempDir("qa-bundled-target-");

    const { bundledPluginsDir, stagedRoot } = await createQaBundledPluginsDir({
      repoRoot,
      tempRoot,
      allowedPluginIds: ["qa-channel", "memory-core"],
    });

    expect((await readdir(bundledPluginsDir)).toSorted()).toEqual([
      "image-generation-core",
      "memory-core",
      "qa-channel",
    ]);
    expect(bundledPluginsDir).toBe(
      path.join(
        repoRoot,
        ".artifacts",
        "qa-runtime",
        path.basename(tempRoot),
        "dist",
        "extensions",
      ),
    );
    expect(stagedRoot).toBe(
      path.join(repoRoot, ".artifacts", "qa-runtime", path.basename(tempRoot)),
    );
    await expect(readFile(path.join(stagedRoot, "package.json"), "utf8")).resolves.toContain(
      '"name": "openclaw"',
    );
    const qaChannel = (await import(
      `${pathToFileURL(path.join(bundledPluginsDir, "qa-channel", "index.js")).href}?t=${Date.now()}`
    )) as { accountId: string };
    expect(qaChannel.accountId).toBe("qa");
    await expect(
      readFile(path.join(bundledPluginsDir, "qa-channel", "openclaw.plugin.json"), "utf8"),
    ).resolves.toContain('"replaySafe":true');
    expect((await lstat(path.join(bundledPluginsDir, "qa-channel"))).isDirectory()).toBe(true);
    expect((await lstat(path.join(bundledPluginsDir, "memory-core"))).isDirectory()).toBe(true);
    expect((await lstat(path.join(bundledPluginsDir, "image-generation-core"))).isDirectory()).toBe(
      true,
    );
    const sharedChunkStat = await lstat(
      path.join(
        repoRoot,
        ".artifacts",
        "qa-runtime",
        path.basename(tempRoot),
        "dist",
        "shared-chunk-abc123.js",
      ),
    );
    if (sharedChunkStat.isFile()) {
      expect(sharedChunkStat.isFile()).toBe(true);
    } else {
      expect(sharedChunkStat.isSymbolicLink()).toBe(true);
    }
  });

  it("preserves dist-runtime-only root chunks when dist also exists", async () => {
    const repoRoot = await tempDirs.makeTempDir("qa-bundled-mixed-runtime-");
    await writeFile(
      path.join(repoRoot, "package.json"),
      JSON.stringify({ name: "openclaw", type: "module" }, null, 2),
      "utf8",
    );
    await mkdir(path.join(repoRoot, "dist"), { recursive: true });
    await writeFile(
      path.join(repoRoot, "dist", "shared-dist.js"),
      'export const dist = "dist";\n',
      "utf8",
    );
    await mkdir(path.join(repoRoot, "dist-runtime", "extensions", "runtime-only"), {
      recursive: true,
    });
    await writeFile(
      path.join(repoRoot, "dist-runtime", "runtime-chunk.js"),
      'export const marker = "runtime";\n',
      "utf8",
    );
    await writeFile(
      path.join(repoRoot, "dist-runtime", "extensions", "runtime-only", "package.json"),
      JSON.stringify({ name: "@openclaw/runtime-only", type: "module" }, null, 2),
      "utf8",
    );
    await writeFile(
      path.join(repoRoot, "dist-runtime", "extensions", "runtime-only", "index.js"),
      ['import { marker } from "../../runtime-chunk.js";', "export { marker };", ""].join("\n"),
      "utf8",
    );
    const tempRoot = await tempDirs.makeTempDir("qa-bundled-mixed-target-");

    const { bundledPluginsDir } = await createQaBundledPluginsDir({
      repoRoot,
      tempRoot,
      allowedPluginIds: ["runtime-only"],
    });

    expect(bundledPluginsDir).toBe(
      path.join(
        repoRoot,
        ".artifacts",
        "qa-runtime",
        path.basename(tempRoot),
        "dist",
        "extensions",
      ),
    );
    const runtimeOnly = (await import(
      `${pathToFileURL(path.join(bundledPluginsDir, "runtime-only", "index.js")).href}?t=${Date.now()}`
    )) as { marker: string };
    expect(runtimeOnly.marker).toBe("runtime");
    const runtimeChunkStat = await lstat(
      path.join(
        repoRoot,
        ".artifacts",
        "qa-runtime",
        path.basename(tempRoot),
        "dist",
        "runtime-chunk.js",
      ),
    );
    if (runtimeChunkStat.isFile()) {
      expect(runtimeChunkStat.isFile()).toBe(true);
    } else {
      expect(runtimeChunkStat.isSymbolicLink()).toBe(true);
    }
  });

  it("rejects invalid bundled plugin ids before staging paths are built", async () => {
    const repoRoot = await tempDirs.makeTempDir("qa-bundled-invalid-id-");
    await writeFile(
      path.join(repoRoot, "package.json"),
      JSON.stringify({ name: "openclaw", type: "module" }, null, 2),
      "utf8",
    );
    const tempRoot = await tempDirs.makeTempDir("qa-bundled-invalid-target-");

    await expect(
      createQaBundledPluginsDir({
        repoRoot,
        tempRoot,
        allowedPluginIds: ["../escape"],
      }),
    ).rejects.toThrow("invalid QA bundled plugin id: ../escape");
  });

  it("leaves external allowed plugins to configured load paths", async () => {
    const repoRoot = await tempDirs.makeTempDir("qa-bundled-external-id-");
    await writeFile(
      path.join(repoRoot, "package.json"),
      JSON.stringify({ name: "openclaw", type: "module" }, null, 2),
      "utf8",
    );
    const tempRoot = await tempDirs.makeTempDir("qa-bundled-external-target-");

    const { bundledPluginsDir } = await createQaBundledPluginsDir({
      repoRoot,
      tempRoot,
      allowedPluginIds: ["external-fixture"],
    });

    await expect(readdir(bundledPluginsDir)).resolves.not.toContain("external-fixture");
  });

  it("stages source-only bundled plugins into a repo-like runtime root with node_modules", async () => {
    const repoRoot = await tempDirs.makeTempDir("qa-bundled-source-stage-");
    const fakeDepStoreRoot = await tempDirs.makeTempDir("qa-bundled-source-store-");
    await writeFile(
      path.join(repoRoot, "package.json"),
      JSON.stringify(
        {
          name: "openclaw",
          type: "module",
          exports: {
            "./plugin-sdk/account-id": {
              default: "./dist/plugin-sdk/account-id.js",
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await mkdir(path.join(repoRoot, "dist", "plugin-sdk"), { recursive: true });
    await writeFile(
      path.join(repoRoot, "dist", "plugin-sdk", "account-id.js"),
      "export const normalizeAccountId = (value) => value.toLowerCase();\n",
      "utf8",
    );
    await mkdir(path.join(repoRoot, "extensions", "qa-channel"), { recursive: true });
    await writeFile(
      path.join(repoRoot, "extensions", "qa-channel", "package.json"),
      JSON.stringify({ name: "@openclaw/qa-channel", type: "module" }, null, 2),
      "utf8",
    );
    await writeFile(
      path.join(repoRoot, "extensions", "qa-channel", "index.ts"),
      [
        'import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";',
        'import { marker } from "fake-dep";',
        'export const accountId = `${normalizeAccountId("QA")}:${marker}`;',
        "",
      ].join("\n"),
      "utf8",
    );
    const fakeDepPackageDir = path.join(fakeDepStoreRoot, "fake-dep");
    await mkdir(fakeDepPackageDir, { recursive: true });
    await writeFile(
      path.join(fakeDepPackageDir, "package.json"),
      JSON.stringify({ name: "fake-dep", type: "module" }, null, 2),
      "utf8",
    );
    await writeFile(
      path.join(fakeDepPackageDir, "index.js"),
      'export const marker = "ok";\n',
      "utf8",
    );
    await mkdir(path.join(repoRoot, "node_modules"), { recursive: true });
    await symlink(fakeDepPackageDir, path.join(repoRoot, "node_modules", "fake-dep"), "dir");
    const tempRoot = await tempDirs.makeTempDir("qa-bundled-source-target-");

    const { bundledPluginsDir, stagedRoot } = await createQaBundledPluginsDir({
      repoRoot,
      tempRoot,
      allowedPluginIds: ["qa-channel"],
    });

    expect(bundledPluginsDir).toBe(
      path.join(
        repoRoot,
        ".artifacts",
        "qa-runtime",
        path.basename(tempRoot),
        "dist",
        "extensions",
      ),
    );
    if (!stagedRoot) {
      throw new Error("expected staged runtime root");
    }
    const qaChannel = (await import(
      `${pathToFileURL(path.join(bundledPluginsDir, "qa-channel", "index.ts")).href}?t=${Date.now()}`
    )) as { accountId: string };
    expect(qaChannel.accountId).toBe("qa:ok");
    await expect(
      lstat(path.join(stagedRoot, "node_modules", "fake-dep")).then((stats) =>
        stats.isSymbolicLink(),
      ),
    ).resolves.toBe(true);
    await expect(
      readFile(path.join(stagedRoot, "node_modules", "fake-dep", "index.js"), "utf8"),
    ).resolves.toContain('marker = "ok"');
  });

  it("maps cli backend provider ids to their owning bundled plugin ids", async () => {
    const repoRoot = await tempDirs.makeTempDir("qa-plugin-owner-");
    await writeJsonFixture(
      path.join(repoRoot, "dist", "extensions", "openai", "openclaw.plugin.json"),
      {
        id: "openai",
        providers: ["openai", "openai"],
        cliBackends: ["codex-cli"],
      },
    );

    await expect(
      resolveQaOwnerPluginIdsForProviderIds({
        repoRoot,
        providerIds: ["codex-cli"],
      }),
    ).resolves.toEqual(["openai"]);
  });

  it("maps configured OpenAI Responses provider aliases to the OpenAI plugin", async () => {
    const repoRoot = await tempDirs.makeTempDir("qa-plugin-owner-");
    await writeJsonFixture(
      path.join(repoRoot, "dist", "extensions", "openai", "openclaw.plugin.json"),
      {
        id: "openai",
        providers: ["openai"],
        cliBackends: ["codex-cli"],
      },
    );

    await expect(
      resolveQaOwnerPluginIdsForProviderIds({
        repoRoot,
        providerIds: ["custom-openai"],
        providerConfigs: {
          "custom-openai": {
            baseUrl: "https://api.example.test/v1",
            api: "openai-responses",
            models: [
              {
                id: "model-a",
                name: "model-a",
                api: "openai-responses",
                reasoning: true,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128_000,
                maxTokens: 4096,
              },
            ],
          },
        },
      }),
    ).resolves.toEqual(["openai"]);
  });

  it("copies selected live provider configs from the host config", async () => {
    const configPath = await writeTempProviderConfig({
      models: {
        providers: {
          "custom-openai": {
            baseUrl: "https://api.example.test/v1",
            api: "openai-responses",
            models: [
              {
                id: "model-a",
                name: "model-a",
                api: "openai-responses",
                reasoning: true,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128_000,
                maxTokens: 4096,
              },
            ],
          },
          ignored: {
            baseUrl: "https://ignored.example.test/v1",
            api: "openai-responses",
            models: [],
          },
        },
      },
    });

    const overrides = await readQaLiveProviderConfigOverrides({
      providerIds: ["custom-openai"],
      env: { OPENCLAW_QA_LIVE_PROVIDER_CONFIG_PATH: configPath },
    });
    expect(Object.keys(overrides)).toEqual(["custom-openai"]);
    expect(overrides["custom-openai"]?.baseUrl).toBe("https://api.example.test/v1");
    expect(overrides["custom-openai"]?.api).toBe("openai-responses");
  });

  it("copies OpenAI auth-only live provider configs for default OpenAI runs", async () => {
    const configPath = await writeTempProviderConfig({
      models: {
        providers: {
          openai: {
            apiKey: {
              source: "env",
              id: "OPENCLAW_LIVE_CODEX_API_KEY",
            },
          },
        },
      },
    });

    const overrides = await readQaLiveProviderConfigOverrides({
      providerIds: ["openai"],
      env: { OPENCLAW_QA_LIVE_PROVIDER_CONFIG_PATH: configPath },
    });
    expect(Object.keys(overrides)).toEqual(["openai"]);
    expect(overrides["openai"]).not.toHaveProperty("baseUrl");
    expect(overrides["openai"]?.models).toEqual([]);
    expect(overrides["openai"]?.apiKey).toEqual({
      source: "env",
      id: "OPENCLAW_LIVE_CODEX_API_KEY",
    });
  });

  it("omits empty base URLs without dropping provider configs that inherit auth", async () => {
    const configPath = await writeTempProviderConfig({
      models: {
        providers: {
          openai: {
            baseUrl: "",
            api: "openai-responses",
            models: [],
          },
        },
      },
    });

    const overrides = await readQaLiveProviderConfigOverrides({
      providerIds: ["openai"],
      env: { OPENCLAW_QA_LIVE_PROVIDER_CONFIG_PATH: configPath },
    });
    expect(Object.keys(overrides)).toEqual(["openai"]);
    expect(overrides["openai"]).not.toHaveProperty("baseUrl");
    expect(overrides["openai"]?.api).toBe("openai-responses");
  });

  it("raises the QA runtime host version to the highest allowed plugin floor", async () => {
    const repoRoot = await tempDirs.makeTempDir("qa-runtime-version-");
    await writeJsonFixture(path.join(repoRoot, "package.json"), { version: "2026.4.7-1" });
    const bundledRoot = path.join(repoRoot, "extensions");
    await writeJsonFixture(path.join(bundledRoot, "qa-channel", "package.json"), {
      openclaw: { install: { minHostVersion: ">=2026.4.8" } },
    });

    await writeJsonFixture(path.join(bundledRoot, "memory-core", "package.json"), {
      openclaw: { install: { minHostVersion: ">=2026.4.7" } },
    });

    await expect(
      resolveQaRuntimeHostVersion({
        repoRoot,
        allowedPluginIds: ["memory-core", "qa-channel"],
      }),
    ).resolves.toBe("2026.4.8");
  });

  it("includes the always-staged runtime facade when raising the QA runtime host version", async () => {
    const repoRoot = await tempDirs.makeTempDir("qa-runtime-version-runtime-facade-");
    await writeJsonFixture(path.join(repoRoot, "package.json"), { version: "2026.4.7-1" });
    const bundledRoot = path.join(repoRoot, "extensions");
    await writeJsonFixture(path.join(bundledRoot, "qa-channel", "package.json"), {
      openclaw: { install: { minHostVersion: ">=2026.4.8" } },
    });
    await writeJsonFixture(path.join(bundledRoot, "image-generation-core", "package.json"), {
      openclaw: { install: { minHostVersion: ">=2026.4.9" } },
    });

    await expect(
      resolveQaRuntimeHostVersion({
        repoRoot,
        allowedPluginIds: ["qa-channel"],
      }),
    ).resolves.toBe("2026.4.9");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
