import { spawn } from "node:child_process";
// Qa Lab tests cover gateway child plugin behavior.
import { EventEmitter, once } from "node:events";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  testing,
  buildQaRuntimeEnv,
  resolveQaControlUiRoot,
  startQaGatewayChild,
} from "./gateway-child.js";
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

const cleanups: Array<() => Promise<void>> = [];
const tempDirs = createTempDirHarness();

afterEach(async () => {
  fetchWithSsrFGuardMock.mockReset();
  resolveQaNodeExecPathMock.mockReset();
  qaTempPathState.preferredTmpDir = process.env.TMPDIR || "/tmp";
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
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

function parseAuthProfileStore(raw: string): AuthProfileStore {
  return JSON.parse(raw) as AuthProfileStore;
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

async function expectPathMissing(filePath: string): Promise<void> {
  try {
    await lstat(filePath);
  } catch (error) {
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
    return;
  }
  throw new Error(`expected ${filePath} to be missing`);
}

describe("runQaGatewayCliCommand", () => {
  it("runs CLI commands with the Gateway fixture environment", async () => {
    const output = await testing.runQaGatewayCliCommand({
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
      testing.runQaGatewayCliCommand({
        executablePath: process.execPath,
        argsPrefix: ["--eval", 'process.stderr.write("fixture failure"); process.exit(7)'],
        args: [],
        cwd: process.cwd(),
        env: process.env,
      }),
    ).rejects.toThrow("OpenClaw CLI exited 7: fixture failure");
  });

  it.each(["stdout", "stderr"] as const)(
    "rejects and stops the CLI child when its %s pipe fails",
    async (streamName) => {
      const child = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const close = once(child, "close");
      const result = testing.readQaGatewayCliCommand(child);
      const message = `synthetic ${streamName} read failure`;

      child[streamName]?.destroy(new Error(message));

      await expect(result).rejects.toThrow(
        `qa gateway cli ${streamName} stream failed: ${message}`,
      );
      await close;
    },
  );
});

describe("monitorQaGatewayChildFailure", () => {
  it("records the first pipe failure and stops the detached Gateway child", async () => {
    const child = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const close = once(child, "close");
    const output = testing.createQaGatewayChildLogCollector();
    const getFailure = testing.monitorQaGatewayChildFailure(child, output);
    const error = new Error("synthetic gateway stdout read failure");

    child.stdout?.destroy(error);
    child.stderr?.destroy(new Error("later stderr read failure"));

    await vi.waitFor(() => expect(getFailure()).toEqual({ source: "stdout", error }));
    await close;
    expect(output.text()).toContain(
      "gateway child stdout stream failed: synthetic gateway stdout read failure",
    );
    expect(output.text()).not.toContain("later stderr read failure");
    expect(() => testing.throwQaGatewayChildFailure(getFailure, () => output.text())).toThrow(
      "gateway child stdout stream failed: synthetic gateway stdout read failure",
    );
  });
});

describe("formatQaGatewayProcessBoundaryStartupFailure", () => {
  it("includes only a bounded, redacted launcher log tail", () => {
    const prefix = "x".repeat(9_000);
    const longSecret = "s".repeat(9_000);
    const message = testing.formatQaGatewayProcessBoundaryStartupFailure(
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
});

describe("Gateway child fixture helpers", () => {
  it("creates an empty transport config seam", () => {
    expect(testing.createQaGatewayEmptyTransport()).toEqual({
      requiredPluginIds: [],
      createGatewayConfig: expect.any(Function),
    });
  });

  it("resolves source and built Gateway CLI commands", async () => {
    const repoRoot = await tempDirs.makeTempDir("qa-gateway-command-");
    await mkdir(path.join(repoRoot, "src"), { recursive: true });
    await writeFile(path.join(repoRoot, "src", "entry.ts"), "export {};\n", "utf8");

    expect(testing.resolveQaGatewayChildCommand(repoRoot)).toEqual({
      executablePath: process.execPath,
      argsPrefix: ["--import", "tsx", path.join(repoRoot, "src", "entry.ts")],
      cwd: repoRoot,
    });

    await mkdir(path.join(repoRoot, "dist"), { recursive: true });
    await writeFile(path.join(repoRoot, "dist", "index.js"), "export {};\n", "utf8");
    expect(testing.resolveQaGatewayChildCommand(repoRoot)).toEqual({
      executablePath: process.execPath,
      argsPrefix: [path.join(repoRoot, "dist", "index.js")],
      cwd: repoRoot,
      usePackagedPlugins: true,
    });
  });
});

describe("buildQaRuntimeEnv", () => {
  it("cleans up temp QA gateway roots when node path resolution fails before startup", async () => {
    const tempParent = await mkdtemp(path.join(os.tmpdir(), "qa-gateway-node-exec-fail-"));
    cleanups.push(async () => {
      await rm(tempParent, { recursive: true, force: true });
    });
    qaTempPathState.preferredTmpDir = tempParent;
    resolveQaNodeExecPathMock.mockRejectedValueOnce(new Error("node missing"));

    await expect(
      startQaGatewayChild({
        repoRoot: process.cwd(),
        transport: {
          requiredPluginIds: [],
          createGatewayConfig: () => ({}),
        },
        transportBaseUrl: "http://127.0.0.1:43123",
      }),
    ).rejects.toThrow("node missing");

    await expect(readdir(tempParent)).resolves.toStrictEqual([]);
  });

  it("reports command spawn errors instead of leaking unhandled child errors", async () => {
    const preferredTempParent = await mkdtemp(
      path.join(os.tmpdir(), "qa-gateway-default-spawn-fail-"),
    );
    const commandTempParent = await mkdtemp(
      path.join(os.tmpdir(), "qa-gateway-command-spawn-fail-"),
    );
    cleanups.push(async () => {
      await rm(preferredTempParent, { recursive: true, force: true });
      await rm(commandTempParent, { recursive: true, force: true });
    });
    qaTempPathState.preferredTmpDir = preferredTempParent;
    const missingExecutable = path.join(commandTempParent, "missing-openclaw-node");

    await expect(
      startQaGatewayChild({
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
    ).rejects.toThrow(/gateway failed to spawn: .*ENOENT/u);

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
    expect(env.OPENCLAW_ALLOW_SLOW_REPLY_TESTS).toBe("1");
    expect(env.OPENCLAW_BUNDLED_PLUGINS_DIR).toBe("/tmp/openclaw-qa/bundled-plugins");
    expect(env.OPENCLAW_COMPATIBILITY_HOST_VERSION).toBe("2026.4.8");
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

  it("defaults gateway-child provider mode to mock-openai when omitted", () => {
    expect(testing.resolveQaGatewayChildProviderMode(undefined)).toBe("mock-openai");
    expect(testing.resolveQaGatewayChildProviderMode("live-frontier")).toBe("live-frontier");
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
    const hostHome = await mkdtemp(path.join(os.tmpdir(), "qa-host-home-"));
    cleanups.push(async () => {
      await rm(hostHome, { recursive: true, force: true });
    });
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
    const hostHome = await mkdtemp(path.join(os.tmpdir(), "qa-host-home-"));
    cleanups.push(async () => {
      await rm(hostHome, { recursive: true, force: true });
    });

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
    const hostHome = await mkdtemp(path.join(os.tmpdir(), "qa-host-home-"));
    cleanups.push(async () => {
      await rm(hostHome, { recursive: true, force: true });
    });

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
    const hostHome = await mkdtemp(path.join(os.tmpdir(), "qa-host-home-"));
    cleanups.push(async () => {
      await rm(hostHome, { recursive: true, force: true });
    });

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
    const hostHome = await mkdtemp(path.join(os.tmpdir(), "qa-host-home-"));
    cleanups.push(async () => {
      await rm(hostHome, { recursive: true, force: true });
    });

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
  });

  it("re-scrubs blocked credentials in the spawned gateway child env", async () => {
    const tempParent = await mkdtemp(path.join(os.tmpdir(), "qa-gateway-env-scrub-"));
    cleanups.push(async () => {
      await rm(tempParent, { recursive: true, force: true });
    });
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

    await expect(
      startQaGatewayChild({
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

    await expect(readFile(observedEnvPath, "utf8")).resolves.toBe(
      JSON.stringify({ SAFE_VALUE: "patched" }),
    );
  });

  it("requires an Anthropic key for live Claude CLI API-key mode", async () => {
    const hostHome = await mkdtemp(path.join(os.tmpdir(), "qa-host-home-"));
    cleanups.push(async () => {
      await rm(hostHome, { recursive: true, force: true });
    });

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

  it("treats restart socket closures as retryable gateway call errors", () => {
    expect(testing.isRetryableGatewayCallError("gateway closed (1006 abnormal closure)")).toBe(
      true,
    );
    expect(testing.isRetryableGatewayCallError("gateway closed (1012 service restart)")).toBe(true);
    expect(testing.isRetryableGatewayCallError("service restart in progress")).toBe(true);
    expect(testing.isRetryableGatewayCallError("permission denied")).toBe(false);
  });

  it("waits for a fresh in-process restart boundary after the current log offset", async () => {
    let logs = "old restart mode: in-process restart\n";
    const offset = logs.length;
    const wait = testing.waitForQaGatewayRestartBoundary({
      logs: () => logs,
      offset,
      pollMs: 1,
      timeoutMs: 100,
    });

    logs += "signal SIGUSR1 received\nrestart mode: in-process restart\n";

    await expect(wait).resolves.toBeUndefined();
  });

  it("keeps restart offsets stable after stderr output", async () => {
    const output = testing.createQaGatewayChildLogCollector();
    output.push(Buffer.from("gateway ready\n"));
    output.push(Buffer.from("stderr warning\n"));
    const offset = output.text().length;
    const wait = testing.waitForQaGatewayRestartBoundary({
      logs: () => output.text(),
      offset,
      pollMs: 1,
      timeoutMs: 100,
    });

    output.push(Buffer.from("signal SIGUSR1 received\nrestart mode: in-process restart\n"));

    await expect(wait).resolves.toBeUndefined();
  });

  it("times out when a SIGUSR1 restart never reaches the boundary", async () => {
    await expect(
      testing.waitForQaGatewayRestartBoundary({
        logs: () => "signal SIGUSR1 received\n",
        offset: 0,
        pollMs: 1,
        timeoutMs: 1,
      }),
    ).rejects.toThrow("qa gateway child did not reach restart boundary");
  });

  it("keeps oversized restart-boundary poll intervals within the timeout", async () => {
    await expect(
      testing.waitForQaGatewayRestartBoundary({
        logs: () => "signal SIGUSR1 received\n",
        offset: 0,
        pollMs: Number.MAX_SAFE_INTEGER,
        timeoutMs: 5,
      }),
    ).rejects.toThrow("qa gateway child did not reach restart boundary");
  });

  it("stages a live Anthropic setup-token profile for isolated QA workers", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "qa-setup-token-state-"));
    cleanups.push(async () => {
      await rm(stateDir, { recursive: true, force: true });
    });
    const token = `sk-ant-oat01-${"c".repeat(80)}`;

    const cfg = await testing.stageQaLiveAnthropicSetupToken({
      cfg: {},
      stateDir,
      env: {
        OPENCLAW_LIVE_SETUP_TOKEN_VALUE: token,
      },
    });

    const configProfile = requireAuthProfile(cfg.auth?.profiles, "anthropic:qa-setup-token");
    expect(configProfile.provider).toBe("anthropic");
    expect(configProfile.mode).toBe("token");
    const storeRaw = await readFile(
      path.join(stateDir, "agents", "main", "agent", "auth-profiles.json"),
      "utf8",
    );
    const storeProfile = requireAuthProfile(
      parseAuthProfileStore(storeRaw).profiles,
      "anthropic:qa-setup-token",
    );
    expect(storeProfile.type).toBe("token");
    expect(storeProfile.provider).toBe("anthropic");
    expect(storeProfile.token).toBe(token);
  });

  it("stages live env API-key profiles for isolated QA workers", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "qa-live-api-key-state-"));
    cleanups.push(async () => {
      await rm(stateDir, { recursive: true, force: true });
    });

    const cfg = await testing.stageQaLiveApiKeyProfiles({
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

    for (const agentId of ["main", "qa"]) {
      const storeRaw = await readFile(
        path.join(stateDir, "agents", agentId, "agent", "auth-profiles.json"),
        "utf8",
      );
      const storeProfile = requireAuthProfile(
        parseAuthProfileStore(storeRaw).profiles,
        "qa-live-openai-env",
      );
      expect(storeProfile.type).toBe("api_key");
      expect(storeProfile.provider).toBe("openai");
      expect(storeProfile.key).toBe("qa-live-not-a-real-key");
    }
  });

  it("stages the OpenAI API-key fallback for live OpenAI QA workers", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "qa-live-codex-api-key-state-"));
    cleanups.push(async () => {
      await rm(stateDir, { recursive: true, force: true });
    });

    const cfg = await testing.stageQaLiveApiKeyProfiles({
      cfg: {},
      stateDir,
      providerIds: ["openai"],
      env: {
        OPENCLAW_LIVE_OPENAI_KEY: "qa-live-codex-fallback-key",
      },
    });

    for (const [profileId, provider] of [
      ["qa-live-openai-env", "openai"],
      ["qa-live-openai-env", "openai"],
    ] as const) {
      const configProfile = requireAuthProfile(cfg.auth?.profiles, profileId);
      expect(configProfile.provider).toBe(provider);
      expect(configProfile.mode).toBe("api_key");
    }

    for (const agentId of ["main", "qa"]) {
      const storeRaw = await readFile(
        path.join(stateDir, "agents", agentId, "agent", "auth-profiles.json"),
        "utf8",
      );
      const storeProfiles = parseAuthProfileStore(storeRaw).profiles;
      for (const [profileId, provider] of [
        ["qa-live-openai-env", "openai"],
        ["qa-live-openai-env", "openai"],
      ] as const) {
        const storeProfile = requireAuthProfile(storeProfiles, profileId);
        expect(storeProfile.type).toBe("api_key");
        expect(storeProfile.provider).toBe(provider);
        expect(storeProfile.key).toBe("qa-live-codex-fallback-key");
      }
    }
  });

  it("stages direct live OpenAI API-key aliases for isolated QA workers", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "qa-live-codex-direct-key-state-"));
    cleanups.push(async () => {
      await rm(stateDir, { recursive: true, force: true });
    });

    const cfg = await testing.stageQaLiveApiKeyProfiles({
      cfg: {},
      stateDir,
      providerIds: ["openai"],
      env: {
        OPENCLAW_LIVE_CODEX_API_KEY: "qa-live-direct-codex-key",
      },
    });

    const storeRaw = await readFile(
      path.join(stateDir, "agents", "qa", "agent", "auth-profiles.json"),
      "utf8",
    );
    const storeProfile = requireAuthProfile(
      parseAuthProfileStore(storeRaw).profiles,
      "qa-live-openai-env",
    );
    expect(storeProfile.type).toBe("api_key");
    expect(storeProfile.provider).toBe("openai");
    expect(storeProfile.key).toBe("qa-live-direct-codex-key");

    expect(() =>
      testing.assertQaLiveCodexAuthAvailable({
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
      testing.assertQaLiveCodexAuthAvailable({
        cfg: {},
        providerIds: ["openai"],
        env: {
          CODEX_HOME: path.join(os.tmpdir(), "missing-openclaw-codex-home"),
        },
        readCodexCredentials: () => null,
      }),
    ).toThrow("QA live-frontier cannot run Codex-backed OpenAI models");
  });

  it("fails fast when default OpenAI model refs route through Codex without portable QA auth", () => {
    expect(() =>
      testing.assertQaLiveCodexAuthAvailable({
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
      testing.assertQaLiveCodexAuthAvailable({
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
      testing.assertQaLiveCodexAuthAvailable({
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
      testing.assertQaLiveCodexAuthAvailable({
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
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "qa-live-codex-config-key-state-"));
    cleanups.push(async () => {
      await rm(stateDir, { recursive: true, force: true });
    });
    const cfg = await testing.stageQaLiveApiKeyProfiles({
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
      const storeRaw = await readFile(
        path.join(stateDir, "agents", agentId, "agent", "auth-profiles.json"),
        "utf8",
      );
      const storeProfile = requireAuthProfile(
        parseAuthProfileStore(storeRaw).profiles,
        "qa-live-openai-env",
      );
      expect(storeProfile.type).toBe("api_key");
      expect(storeProfile.provider).toBe("openai");
      expect(storeProfile.key).toBe("qa-configured-not-a-real-key");
    }

    expect(() =>
      testing.assertQaLiveCodexAuthAvailable({
        cfg,
        providerIds: ["openai"],
        env: {},
        readCodexCredentials: () => null,
      }),
    ).not.toThrow();
  });

  it("stages configured OpenAI env secret refs for default OpenAI live QA runs", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "qa-live-codex-config-ref-state-"));
    cleanups.push(async () => {
      await rm(stateDir, { recursive: true, force: true });
    });
    const env = {
      OPENCLAW_LIVE_CODEX_API_KEY: "qa-configured-env-ref-not-a-real-key",
    };
    const cfg = await testing.stageQaLiveApiKeyProfiles({
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

    const storeRaw = await readFile(
      path.join(stateDir, "agents", "qa", "agent", "auth-profiles.json"),
      "utf8",
    );
    const storeProfile = requireAuthProfile(
      parseAuthProfileStore(storeRaw).profiles,
      "qa-live-openai-env",
    );
    expect(storeProfile.type).toBe("api_key");
    expect(storeProfile.provider).toBe("openai");
    expect(storeProfile.key).toBe("qa-configured-env-ref-not-a-real-key");

    expect(() =>
      testing.assertQaLiveCodexAuthAvailable({
        cfg,
        providerIds: ["openai"],
        env,
        readCodexCredentials: () => null,
      }),
    ).not.toThrow();
  });

  it("stages configured OpenAI env markers for live QA runs", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "qa-live-codex-config-marker-state-"));
    cleanups.push(async () => {
      await rm(stateDir, { recursive: true, force: true });
    });
    const cfg = await testing.stageQaLiveApiKeyProfiles({
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

    const storeRaw = await readFile(
      path.join(stateDir, "agents", "main", "agent", "auth-profiles.json"),
      "utf8",
    );
    const storeProfile = requireAuthProfile(
      parseAuthProfileStore(storeRaw).profiles,
      "qa-live-openai-env",
    );
    expect(storeProfile.type).toBe("api_key");
    expect(storeProfile.provider).toBe("openai");
    expect(storeProfile.key).toBe("qa-configured-marker-not-a-real-key");

    expect(() =>
      testing.assertQaLiveCodexAuthAvailable({
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
      testing.assertQaLiveCodexAuthAvailable({
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
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "qa-mock-auth-"));
    cleanups.push(async () => {
      await rm(stateDir, { recursive: true, force: true });
    });

    const cfg = await testing.stageQaMockAuthProfiles({
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

    // Store side: each agent dir should have its own auth-profiles.json
    // containing the placeholder credential for each staged provider. This
    // is what the scenario runner actually reads when it resolves auth
    // before calling the mock.
    for (const agentId of ["main", "qa"]) {
      const storeRaw = await readFile(
        path.join(stateDir, "agents", agentId, "agent", "auth-profiles.json"),
        "utf8",
      );
      const parsed = parseAuthProfileStore(storeRaw);
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

  it("stages mock profiles only for the requested agents and providers when callers override the defaults", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "qa-mock-auth-override-"));
    cleanups.push(async () => {
      await rm(stateDir, { recursive: true, force: true });
    });

    const cfg = await testing.stageQaMockAuthProfiles({
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

    const qaStore = JSON.parse(
      await readFile(path.join(stateDir, "agents", "qa", "agent", "auth-profiles.json"), "utf8"),
    ) as AuthProfileStore;
    const openaiStoreProfile = requireAuthProfile(qaStore.profiles, "qa-mock-openai");
    expect(openaiStoreProfile.provider).toBe("openai");
    expect(openaiStoreProfile.type).toBe("api_key");
    expect(qaStore.profiles["qa-mock-anthropic"]).toBeUndefined();

    // main/agent should not exist because it wasn't in the agentIds list.
    await expect(
      readFile(path.join(stateDir, "agents", "main", "agent", "auth-profiles.json"), "utf8"),
    ).rejects.toThrow(/ENOENT/);
  });

  it("allows loopback gateway health probes through the SSRF guard", async () => {
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: { ok: true },
      release,
    });

    await expect(
      testing.fetchLocalGatewayHealth({
        baseUrl: "http://127.0.0.1:18789",
        healthPath: "/readyz",
      }),
    ).resolves.toBe(true);

    const request = requireSsrFetchCall();
    expect(request.url).toBe("http://127.0.0.1:18789/readyz");
    expect(request.policy).toEqual({ allowPrivateNetwork: true });
    expect(request.auditContext).toBe("qa-lab-gateway-child-health");
    expect(release).toHaveBeenCalledTimes(1);
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

    await testing.stopQaGatewayChildProcessTree(
      child as unknown as Parameters<typeof testing.stopQaGatewayChildProcessTree>[0],
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
        testing.stopQaGatewayChildProcessTree(child as never, {
          gracefulTimeoutMs: 1,
          forceTimeoutMs: 1,
        }),
      ).rejects.toThrow("qa gateway process tree remained alive after forced shutdown");
    },
  );

  it("force-kills Windows gateway process trees when graceful taskkill fails", () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
    const originalSystemRoot = process.env.SystemRoot;
    const originalWindir = process.env.WINDIR;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    process.env.SystemRoot = "C:\\Windows";
    delete process.env.WINDIR;
    try {
      const child = Object.assign(new EventEmitter(), {
        pid: 12345,
        exitCode: null as number | null,
        signalCode: null as string | null,
        kill: vi.fn(),
      });
      const runTaskkill = vi
        .fn()
        .mockReturnValueOnce({ status: 1 })
        .mockReturnValueOnce({ status: 0 });

      testing.signalQaGatewayChildProcessTree(
        child as unknown as Parameters<typeof testing.signalQaGatewayChildProcessTree>[0],
        "SIGTERM",
        runTaskkill,
      );

      const taskkillPath = path.win32.join("C:\\Windows", "System32", "taskkill.exe");
      expect(runTaskkill).toHaveBeenNthCalledWith(1, taskkillPath, ["/PID", "12345", "/T"], {
        stdio: "ignore",
        windowsHide: true,
      });
      expect(runTaskkill).toHaveBeenNthCalledWith(2, taskkillPath, ["/PID", "12345", "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      if (platformDescriptor) {
        Object.defineProperty(process, "platform", platformDescriptor);
      }
      if (originalSystemRoot === undefined) {
        delete process.env.SystemRoot;
      } else {
        process.env.SystemRoot = originalSystemRoot;
      }
      if (originalWindir === undefined) {
        delete process.env.WINDIR;
      } else {
        process.env.WINDIR = originalWindir;
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

    await testing.stopQaGatewayChildProcessTree(
      child as unknown as Parameters<typeof testing.stopQaGatewayChildProcessTree>[0],
      {
        gracefulTimeoutMs: 1,
        forceTimeoutMs: 50,
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

  it("treats bind collisions as retryable gateway startup errors", () => {
    expect(
      testing.isRetryableGatewayStartupError(
        "another gateway instance is already listening on ws://127.0.0.1:43124",
      ),
    ).toBe(true);
    expect(
      testing.isRetryableGatewayStartupError(
        "failed to bind gateway socket on ws://127.0.0.1:43124: Error: listen EADDRINUSE",
      ),
    ).toBe(true);
    expect(testing.isRetryableGatewayStartupError("gateway failed to become healthy")).toBe(false);
  });

  it("treats startup token mismatches as retryable rpc startup errors", () => {
    expect(
      testing.isRetryableRpcStartupError(
        "unauthorized: gateway token mismatch (set gateway.remote.token to match gateway.auth.token)",
      ),
    ).toBe(true);
    expect(testing.isRetryableRpcStartupError("permission denied")).toBe(false);
  });

  it("probes gateway health with a one-shot HEAD request through the SSRF guard", async () => {
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: { ok: true },
      release,
    });

    await expect(
      testing.fetchLocalGatewayHealth({
        baseUrl: "http://127.0.0.1:43124",
        healthPath: "/readyz",
      }),
    ).resolves.toBe(true);

    const request = requireSsrFetchCall();
    expect(request.url).toBe("http://127.0.0.1:43124/readyz");
    expect(request.init?.method).toBe("HEAD");
    expect(request.init?.headers).toEqual({ connection: "close" });
    expect(request.init?.signal).toBeInstanceOf(AbortSignal);
    expect(request.policy).toEqual({ allowPrivateNetwork: true });
    expect(request.auditContext).toBe("qa-lab-gateway-child-health");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("preserves only sanitized gateway debug artifacts", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "qa-gateway-preserve-src-"));
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "qa-gateway-preserve-repo-"));
    cleanups.push(async () => {
      await rm(tempRoot, { recursive: true, force: true });
      await rm(repoRoot, { recursive: true, force: true });
    });

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

    await testing.preserveQaGatewayDebugArtifacts({
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

  it("rejects preserved gateway artifacts outside the repo root", async () => {
    await expect(
      testing.assertQaArtifactDirWithinRepo("/tmp/openclaw-repo", "/tmp/outside"),
    ).rejects.toThrow("QA gateway artifact directory must stay within the repo root.");
  });

  it("rejects preserved gateway artifacts that traverse symlinks", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "qa-gateway-guard-repo-"));
    const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "qa-gateway-guard-outside-"));
    cleanups.push(async () => {
      await rm(repoRoot, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    });
    await mkdir(path.join(repoRoot, ".artifacts"), { recursive: true });
    await symlink(outsideRoot, path.join(repoRoot, ".artifacts", "qa-e2e"), "dir");

    await expect(
      testing.assertQaArtifactDirWithinRepo(
        repoRoot,
        path.join(repoRoot, ".artifacts", "qa-e2e", "gateway-runtime"),
      ),
    ).rejects.toThrow("QA gateway artifact directory must not traverse symlinks.");
  });

  it("cleans startup temp roots when they are not preserved", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "qa-gateway-cleanup-src-"));
    const stagedRoot = await mkdtemp(path.join(os.tmpdir(), "qa-gateway-cleanup-stage-"));
    cleanups.push(async () => {
      await rm(tempRoot, { recursive: true, force: true });
      await rm(stagedRoot, { recursive: true, force: true });
    });

    await writeFile(path.join(tempRoot, "openclaw.json"), "{}", "utf8");
    await writeFile(path.join(stagedRoot, "marker.txt"), "x", "utf8");

    await testing.cleanupQaGatewayTempRoots({
      tempRoot,
      stagedBundledPluginsRoot: stagedRoot,
    });

    await expectPathMissing(tempRoot);
    await expectPathMissing(stagedRoot);
  });
});

describe("resolveQaControlUiRoot", () => {
  it("returns the built control ui root when repo assets exist", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "qa-control-ui-root-"));
    cleanups.push(async () => {
      await rm(repoRoot, { recursive: true, force: true });
    });
    const controlUiRoot = path.join(repoRoot, "dist", "control-ui");
    await mkdir(controlUiRoot, { recursive: true });
    await writeFile(path.join(controlUiRoot, "index.html"), "<html></html>", "utf8");

    expect(resolveQaControlUiRoot({ repoRoot })).toBe(controlUiRoot);
  });

  it("returns undefined when control ui is disabled or not built", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "qa-control-ui-root-missing-"));
    cleanups.push(async () => {
      await rm(repoRoot, { recursive: true, force: true });
    });

    expect(resolveQaControlUiRoot({ repoRoot })).toBeUndefined();
    expect(resolveQaControlUiRoot({ repoRoot, controlUiEnabled: false })).toBeUndefined();
  });
});

describe("qa bundled plugin dir", () => {
  it("prefers a built bundled plugin when present", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "qa-bundled-root-"));
    cleanups.push(async () => {
      await rm(repoRoot, { recursive: true, force: true });
    });
    await mkdir(path.join(repoRoot, "dist", "extensions", "qa-channel"), {
      recursive: true,
    });
    await writeFile(
      path.join(repoRoot, "dist", "extensions", "qa-channel", "package.json"),
      "{}",
      "utf8",
    );
    await mkdir(path.join(repoRoot, "dist-runtime", "extensions", "qa-channel"), {
      recursive: true,
    });
    await writeFile(
      path.join(repoRoot, "dist-runtime", "extensions", "qa-channel", "package.json"),
      "{}",
      "utf8",
    );
    await mkdir(path.join(repoRoot, "extensions", "qa-channel"), { recursive: true });
    await writeFile(path.join(repoRoot, "extensions", "qa-channel", "package.json"), "{}", "utf8");

    expect(
      testing.resolveQaBundledPluginSourceDir({
        repoRoot,
        pluginId: "qa-channel",
      }),
    ).toBe(path.join(repoRoot, "dist", "extensions", "qa-channel"));
  });

  it("falls back to the source bundled plugin when no built copy exists", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "qa-bundled-source-root-"));
    cleanups.push(async () => {
      await rm(repoRoot, { recursive: true, force: true });
    });
    await mkdir(path.join(repoRoot, "extensions", "qa-channel"), { recursive: true });
    await writeFile(path.join(repoRoot, "extensions", "qa-channel", "package.json"), "{}", "utf8");

    expect(
      testing.resolveQaBundledPluginSourceDir({
        repoRoot,
        pluginId: "qa-channel",
      }),
    ).toBe(path.join(repoRoot, "extensions", "qa-channel"));
  });

  it("resolves bundled plugins by manifest id when the directory name differs", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "qa-bundled-manifest-id-root-"));
    cleanups.push(async () => {
      await rm(repoRoot, { recursive: true, force: true });
    });
    await mkdir(path.join(repoRoot, "dist", "extensions", "kimi-coding"), {
      recursive: true,
    });
    await writeFile(
      path.join(repoRoot, "dist", "extensions", "kimi-coding", "openclaw.plugin.json"),
      JSON.stringify({ id: "kimi", providers: ["kimi"] }),
      "utf8",
    );
    await writeFile(
      path.join(repoRoot, "dist", "extensions", "kimi-coding", "package.json"),
      "{}",
      "utf8",
    );

    expect(
      testing.resolveQaBundledPluginSourceDir({
        repoRoot,
        pluginId: "kimi",
      }),
    ).toBe(path.join(repoRoot, "dist", "extensions", "kimi-coding"));
  });

  it("uses a source bundled plugin when the built copy is missing CLI metadata", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "qa-bundled-cli-metadata-root-"));
    cleanups.push(async () => {
      await rm(repoRoot, { recursive: true, force: true });
    });
    await mkdir(path.join(repoRoot, "dist", "extensions", "memory-core"), { recursive: true });
    await writeFile(
      path.join(repoRoot, "dist", "extensions", "memory-core", "package.json"),
      "{}",
      "utf8",
    );
    await writeFile(
      path.join(repoRoot, "dist", "extensions", "memory-core", "openclaw.plugin.json"),
      JSON.stringify({ id: "memory-core", kind: "memory" }),
      "utf8",
    );
    await mkdir(path.join(repoRoot, "extensions", "memory-core"), { recursive: true });
    await writeFile(path.join(repoRoot, "extensions", "memory-core", "package.json"), "{}", "utf8");
    await writeFile(
      path.join(repoRoot, "extensions", "memory-core", "openclaw.plugin.json"),
      JSON.stringify({ id: "memory-core", kind: "memory" }),
      "utf8",
    );
    await writeFile(
      path.join(repoRoot, "extensions", "memory-core", "cli-metadata.ts"),
      "export default { id: 'memory-core' };\n",
      "utf8",
    );

    expect(
      testing.resolveQaBundledPluginSourceDir({
        repoRoot,
        pluginId: "memory-core",
      }),
    ).toBe(path.join(repoRoot, "extensions", "memory-core"));
  });

  it("creates a scoped bundled plugin tree for allowed plugins plus always-allowed runtime facades", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "qa-bundled-scope-"));
    cleanups.push(async () => {
      await rm(repoRoot, { recursive: true, force: true });
    });
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
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "qa-bundled-target-"));
    cleanups.push(async () => {
      await rm(tempRoot, { recursive: true, force: true });
    });

    const { bundledPluginsDir, stagedRoot } = await testing.createQaBundledPluginsDir({
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
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "qa-bundled-mixed-runtime-"));
    cleanups.push(async () => {
      await rm(repoRoot, { recursive: true, force: true });
    });
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
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "qa-bundled-mixed-target-"));
    cleanups.push(async () => {
      await rm(tempRoot, { recursive: true, force: true });
    });

    const { bundledPluginsDir } = await testing.createQaBundledPluginsDir({
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
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "qa-bundled-invalid-id-"));
    cleanups.push(async () => {
      await rm(repoRoot, { recursive: true, force: true });
    });
    await writeFile(
      path.join(repoRoot, "package.json"),
      JSON.stringify({ name: "openclaw", type: "module" }, null, 2),
      "utf8",
    );
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "qa-bundled-invalid-target-"));
    cleanups.push(async () => {
      await rm(tempRoot, { recursive: true, force: true });
    });

    await expect(
      testing.createQaBundledPluginsDir({
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

    const { bundledPluginsDir } = await testing.createQaBundledPluginsDir({
      repoRoot,
      tempRoot,
      allowedPluginIds: ["external-fixture"],
    });

    await expect(readdir(bundledPluginsDir)).resolves.not.toContain("external-fixture");
  });

  it("stages source-only bundled plugins into a repo-like runtime root with node_modules", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "qa-bundled-source-stage-"));
    cleanups.push(async () => {
      await rm(repoRoot, { recursive: true, force: true });
    });
    const fakeDepStoreRoot = await mkdtemp(path.join(os.tmpdir(), "qa-bundled-source-store-"));
    cleanups.push(async () => {
      await rm(fakeDepStoreRoot, { recursive: true, force: true });
    });
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
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "qa-bundled-source-target-"));
    cleanups.push(async () => {
      await rm(tempRoot, { recursive: true, force: true });
    });

    const { bundledPluginsDir, stagedRoot } = await testing.createQaBundledPluginsDir({
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
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "qa-plugin-owner-"));
    cleanups.push(async () => {
      await rm(repoRoot, { recursive: true, force: true });
    });
    await mkdir(path.join(repoRoot, "dist", "extensions", "openai"), { recursive: true });
    await writeFile(
      path.join(repoRoot, "dist", "extensions", "openai", "openclaw.plugin.json"),
      JSON.stringify({
        id: "openai",
        providers: ["openai", "openai"],
        cliBackends: ["codex-cli"],
      }),
      "utf8",
    );

    await expect(
      testing.resolveQaOwnerPluginIdsForProviderIds({
        repoRoot,
        providerIds: ["codex-cli"],
      }),
    ).resolves.toEqual(["openai"]);
  });

  it("maps configured OpenAI Responses provider aliases to the OpenAI plugin", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "qa-plugin-owner-"));
    cleanups.push(async () => {
      await rm(repoRoot, { recursive: true, force: true });
    });
    await mkdir(path.join(repoRoot, "dist", "extensions", "openai"), { recursive: true });
    await writeFile(
      path.join(repoRoot, "dist", "extensions", "openai", "openclaw.plugin.json"),
      JSON.stringify({
        id: "openai",
        providers: ["openai"],
        cliBackends: ["codex-cli"],
      }),
      "utf8",
    );

    await expect(
      testing.resolveQaOwnerPluginIdsForProviderIds({
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
    const configPath = path.join(
      await mkdtemp(path.join(os.tmpdir(), "qa-provider-config-")),
      "openclaw.json",
    );
    cleanups.push(async () => {
      await rm(path.dirname(configPath), { recursive: true, force: true });
    });
    await writeFile(
      configPath,
      JSON.stringify({
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
      }),
      "utf8",
    );

    const overrides = await testing.readQaLiveProviderConfigOverrides({
      providerIds: ["custom-openai"],
      env: { OPENCLAW_QA_LIVE_PROVIDER_CONFIG_PATH: configPath },
    });
    expect(Object.keys(overrides)).toEqual(["custom-openai"]);
    expect(overrides["custom-openai"]?.baseUrl).toBe("https://api.example.test/v1");
    expect(overrides["custom-openai"]?.api).toBe("openai-responses");
  });

  it("copies OpenAI auth-only live provider configs for default OpenAI runs", async () => {
    const configPath = path.join(
      await mkdtemp(path.join(os.tmpdir(), "qa-provider-config-")),
      "openclaw.json",
    );
    cleanups.push(async () => {
      await rm(path.dirname(configPath), { recursive: true, force: true });
    });
    await writeFile(
      configPath,
      JSON.stringify({
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
      }),
      "utf8",
    );

    const overrides = await testing.readQaLiveProviderConfigOverrides({
      providerIds: ["openai"],
      env: { OPENCLAW_QA_LIVE_PROVIDER_CONFIG_PATH: configPath },
    });
    expect(Object.keys(overrides)).toEqual(["openai"]);
    expect(overrides["openai"]?.baseUrl).toBe("");
    expect(overrides["openai"]?.models).toEqual([]);
    expect(overrides["openai"]?.apiKey).toEqual({
      source: "env",
      id: "OPENCLAW_LIVE_CODEX_API_KEY",
    });
  });

  it("does not copy OpenAI provider configs for custom OpenAI-compatible runs", async () => {
    const configPath = path.join(
      await mkdtemp(path.join(os.tmpdir(), "qa-provider-config-")),
      "openclaw.json",
    );
    cleanups.push(async () => {
      await rm(path.dirname(configPath), { recursive: true, force: true });
    });
    await writeFile(
      configPath,
      JSON.stringify({
        models: {
          providers: {
            openai: {
              baseUrl: "https://proxy.example.test/v1",
              models: [],
              apiKey: {
                source: "env",
                id: "OPENCLAW_LIVE_CODEX_API_KEY",
              },
            },
          },
        },
      }),
      "utf8",
    );

    const overrides = await testing.readQaLiveProviderConfigOverrides({
      providerIds: ["openai"],
      env: { OPENCLAW_QA_LIVE_PROVIDER_CONFIG_PATH: configPath },
    });
    expect(Object.keys(overrides)).toEqual(["openai"]);
    expect(overrides.openai?.baseUrl).toBe("https://proxy.example.test/v1");
  });

  it("raises the QA runtime host version to the highest allowed plugin floor", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "qa-runtime-version-"));
    cleanups.push(async () => {
      await rm(repoRoot, { recursive: true, force: true });
    });
    await writeFile(
      path.join(repoRoot, "package.json"),
      JSON.stringify({ version: "2026.4.7-1" }),
      "utf8",
    );
    const bundledRoot = path.join(repoRoot, "extensions");
    await mkdir(path.join(bundledRoot, "qa-channel"), { recursive: true });
    await writeFile(
      path.join(bundledRoot, "qa-channel", "package.json"),
      JSON.stringify({ openclaw: { install: { minHostVersion: ">=2026.4.8" } } }),
      "utf8",
    );

    await mkdir(path.join(bundledRoot, "memory-core"), { recursive: true });
    await writeFile(
      path.join(bundledRoot, "memory-core", "package.json"),
      JSON.stringify({ openclaw: { install: { minHostVersion: ">=2026.4.7" } } }),
      "utf8",
    );

    await expect(
      testing.resolveQaRuntimeHostVersion({
        repoRoot,
        allowedPluginIds: ["memory-core", "qa-channel"],
      }),
    ).resolves.toBe("2026.4.8");
  });

  it("includes always-allowed runtime facade plugins when raising the QA runtime host version", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "qa-runtime-version-runtime-facade-"));
    cleanups.push(async () => {
      await rm(repoRoot, { recursive: true, force: true });
    });
    await writeFile(
      path.join(repoRoot, "package.json"),
      JSON.stringify({ version: "2026.4.7-1" }),
      "utf8",
    );
    const bundledRoot = path.join(repoRoot, "extensions");
    await mkdir(path.join(bundledRoot, "qa-channel"), { recursive: true });
    await writeFile(
      path.join(bundledRoot, "qa-channel", "package.json"),
      JSON.stringify({ openclaw: { install: { minHostVersion: ">=2026.4.8" } } }),
      "utf8",
    );
    await mkdir(path.join(bundledRoot, "image-generation-core"), { recursive: true });
    await writeFile(
      path.join(bundledRoot, "image-generation-core", "package.json"),
      JSON.stringify({ openclaw: { install: { minHostVersion: ">=2026.4.9" } } }),
      "utf8",
    );

    await expect(
      testing.resolveQaRuntimeHostVersion({
        repoRoot,
        allowedPluginIds: ["qa-channel"],
      }),
    ).resolves.toBe("2026.4.9");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
