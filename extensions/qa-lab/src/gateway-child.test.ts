import { EventEmitter } from "node:events";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __testing,
  buildQaRuntimeEnv,
  resolveQaControlUiRoot,
  startQaGatewayChild,
} from "./gateway-child.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());
const resolveQaNodeExecPathMock = vi.hoisted(() => vi.fn(async () => process.execPath));
const qaTempPathState = vi.hoisted(() => ({
  preferredTmpDir: process.env.TMPDIR || "/tmp",
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

vi.mock("openclaw/plugin-sdk/temp-path", () => ({
  resolvePreferredOpenClawTmpDir: () => qaTempPathState.preferredTmpDir,
}));

vi.mock("./node-exec.js", () => ({
  resolveQaNodeExecPath: resolveQaNodeExecPathMock,
}));

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  fetchWithSsrFGuardMock.mockReset();
  resolveQaNodeExecPathMock.mockReset();
  qaTempPathState.preferredTmpDir = process.env.TMPDIR || "/tmp";
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

function createParams(baseEnv?: NodeJS.ProcessEnv) {
  return {
    configPath: "/tmp/openclaw-qa/openclaw.json",
    gatewayToken: "qa-token",
    homeDir: "/tmp/openclaw-qa/home",
    stateDir: "/tmp/openclaw-qa/state",
    xdgConfigHome: "/tmp/openclaw-qa/xdg-config",
    xdgDataHome: "/tmp/openclaw-qa/xdg-data",
    xdgCacheHome: "/tmp/openclaw-qa/xdg-cache",
    bundledPluginsDir: "/tmp/openclaw-qa/bundled-plugins",
    compatibilityHostVersion: "2026.4.8",
    baseEnv,
  };
}

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

    await expect(readdir(tempParent)).resolves.toEqual([]);
  });

  it("keeps the slow-reply QA opt-out enabled under fast mode", () => {
    const env = buildQaRuntimeEnv({
      ...createParams(),
      providerMode: "mock-openai",
    });

    expect(env.OPENCLAW_TEST_FAST).toBe("1");
    expect(env.OPENCLAW_QA_ALLOW_LOCAL_IMAGE_PROVIDER).toBe("1");
    expect(env.OPENCLAW_ALLOW_SLOW_REPLY_TESTS).toBe("1");
    expect(env.OPENCLAW_SKIP_STARTUP_MODEL_PREWARM).toBe("1");
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
    expect(__testing.resolveQaGatewayChildProviderMode(undefined)).toBe("mock-openai");
    expect(__testing.resolveQaGatewayChildProviderMode("live-frontier")).toBe("live-frontier");
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

  it("does not pass Convex credential broker secrets to the gateway child env", () => {
    const env = buildQaRuntimeEnv({
      ...createParams({
        OPENCLAW_QA_CONVEX_SECRET_CI: "convex-ci-secret",
        OPENCLAW_QA_CONVEX_SECRET_MAINTAINER: "convex-maintainer-secret",
      }),
      providerMode: "live-frontier",
    });

    expect(env.OPENCLAW_QA_CONVEX_SECRET_CI).toBeUndefined();
    expect(env.OPENCLAW_QA_CONVEX_SECRET_MAINTAINER).toBeUndefined();
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
          GEMINI_API_KEY: "gemini-live",
          GEMINI_API_KEYS: "gemini-a gemini-b",
          GOOGLE_API_KEY: "google-live",
          OPENAI_API_KEY: "openai-live",
          OPENAI_API_KEYS: "openai-a,openai-b",
          CODEX_HOME: "/host/.codex",
          OPENCLAW_LIVE_ANTHROPIC_KEY: "anthropic-live",
          OPENCLAW_LIVE_ANTHROPIC_KEYS: "anthropic-a,anthropic-b",
          OPENCLAW_LIVE_GEMINI_KEY: "gemini-live",
          OPENCLAW_LIVE_OPENAI_KEY: "openai-live",
        }),
        providerMode,
      });

      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.OPENAI_API_KEYS).toBeUndefined();
      expect(env.CODEX_HOME).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.ANTHROPIC_OAUTH_TOKEN).toBeUndefined();
      expect(env.GEMINI_API_KEY).toBeUndefined();
      expect(env.GEMINI_API_KEYS).toBeUndefined();
      expect(env.GOOGLE_API_KEY).toBeUndefined();
      expect(env.OPENCLAW_LIVE_OPENAI_KEY).toBeUndefined();
      expect(env.OPENCLAW_LIVE_ANTHROPIC_KEY).toBeUndefined();
      expect(env.OPENCLAW_LIVE_ANTHROPIC_KEYS).toBeUndefined();
      expect(env.OPENCLAW_LIVE_GEMINI_KEY).toBeUndefined();
    },
  );

  it("treats restart socket closures as retryable gateway call errors", () => {
    expect(__testing.isRetryableGatewayCallError("gateway closed (1006 abnormal closure)")).toBe(
      true,
    );
    expect(__testing.isRetryableGatewayCallError("gateway closed (1012 service restart)")).toBe(
      true,
    );
    expect(__testing.isRetryableGatewayCallError("service restart in progress")).toBe(true);
    expect(__testing.isRetryableGatewayCallError("permission denied")).toBe(false);
  });

  it("waits for a fresh in-process restart boundary after the current log offset", async () => {
    let logs = "old restart mode: in-process restart\n";
    const offset = logs.length;
    const wait = __testing.waitForQaGatewayRestartBoundary({
      logs: () => logs,
      offset,
      pollMs: 1,
      timeoutMs: 100,
    });

    logs += "signal SIGUSR1 received\nrestart mode: in-process restart\n";

    await expect(wait).resolves.toBeUndefined();
  });

  it("times out when a SIGUSR1 restart never reaches the boundary", async () => {
    await expect(
      __testing.waitForQaGatewayRestartBoundary({
        logs: () => "signal SIGUSR1 received\n",
        offset: 0,
        pollMs: 1,
        timeoutMs: 1,
      }),
    ).rejects.toThrow("qa gateway child did not reach restart boundary");
  });

  it("stages a live Anthropic setup-token profile for isolated QA workers", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "qa-setup-token-state-"));
    cleanups.push(async () => {
      await rm(stateDir, { recursive: true, force: true });
    });
    const token = `sk-ant-oat01-${"c".repeat(80)}`;

    const cfg = await __testing.stageQaLiveAnthropicSetupToken({
      cfg: {},
      stateDir,
      env: {
        OPENCLAW_LIVE_SETUP_TOKEN_VALUE: token,
      },
    });

    expect(cfg.auth?.profiles?.["anthropic:qa-setup-token"]).toMatchObject({
      provider: "anthropic",
      mode: "token",
    });
    const storeRaw = await readFile(
      path.join(stateDir, "agents", "main", "agent", "auth-profiles.json"),
      "utf8",
    );
    expect(JSON.parse(storeRaw)).toMatchObject({
      profiles: {
        "anthropic:qa-setup-token": {
          type: "token",
          provider: "anthropic",
          token,
        },
      },
    });
  });

  it("stages placeholder mock auth profiles per agent dir so mock-openai runs can resolve credentials", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "qa-mock-auth-"));
    cleanups.push(async () => {
      await rm(stateDir, { recursive: true, force: true });
    });

    const cfg = await __testing.stageQaMockAuthProfiles({
      cfg: {},
      stateDir,
    });

    // Config side: both providers should have a profile entry with mode
    // "api_key" so the runtime picks up the staging without any further
    // config mutation.
    expect(cfg.auth?.profiles?.["qa-mock-openai"]).toMatchObject({
      provider: "openai",
      mode: "api_key",
      displayName: "QA mock openai credential",
    });
    expect(cfg.auth?.profiles?.["qa-mock-anthropic"]).toMatchObject({
      provider: "anthropic",
      mode: "api_key",
      displayName: "QA mock anthropic credential",
    });

    // Store side: each agent dir should have its own auth-profiles.json
    // containing the placeholder credential for each staged provider. This
    // is what the scenario runner actually reads when it resolves auth
    // before calling the mock.
    for (const agentId of ["main", "qa"]) {
      const storeRaw = await readFile(
        path.join(stateDir, "agents", agentId, "agent", "auth-profiles.json"),
        "utf8",
      );
      const parsed = JSON.parse(storeRaw) as {
        profiles: Record<string, { type: string; provider: string; key: string }>;
      };
      expect(parsed.profiles["qa-mock-openai"]).toMatchObject({
        type: "api_key",
        provider: "openai",
        key: "qa-mock-not-a-real-key",
      });
      expect(parsed.profiles["qa-mock-anthropic"]).toMatchObject({
        type: "api_key",
        provider: "anthropic",
        key: "qa-mock-not-a-real-key",
      });
    }
  });

  it("stages mock profiles only for the requested agents and providers when callers override the defaults", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "qa-mock-auth-override-"));
    cleanups.push(async () => {
      await rm(stateDir, { recursive: true, force: true });
    });

    const cfg = await __testing.stageQaMockAuthProfiles({
      cfg: {},
      stateDir,
      agentIds: ["qa"],
      providers: ["openai"],
    });

    expect(cfg.auth?.profiles?.["qa-mock-openai"]).toMatchObject({
      provider: "openai",
      mode: "api_key",
    });
    // Anthropic should NOT be staged when the caller restricts providers.
    expect(cfg.auth?.profiles?.["qa-mock-anthropic"]).toBeUndefined();

    const qaStore = JSON.parse(
      await readFile(path.join(stateDir, "agents", "qa", "agent", "auth-profiles.json"), "utf8"),
    ) as { profiles: Record<string, unknown> };
    expect(qaStore.profiles["qa-mock-openai"]).toBeDefined();
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
      __testing.fetchLocalGatewayHealth({
        baseUrl: "http://127.0.0.1:18789",
        healthPath: "/readyz",
      }),
    ).resolves.toBe(true);

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "http://127.0.0.1:18789/readyz",
        policy: { allowPrivateNetwork: true },
        auditContext: "qa-lab-gateway-child-health",
      }),
    );
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
      return true;
    });

    await __testing.stopQaGatewayChildProcessTree(
      child as unknown as Parameters<typeof __testing.stopQaGatewayChildProcessTree>[0],
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
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  it("treats bind collisions as retryable gateway startup errors", () => {
    expect(
      __testing.isRetryableGatewayStartupError(
        "another gateway instance is already listening on ws://127.0.0.1:43124",
      ),
    ).toBe(true);
    expect(
      __testing.isRetryableGatewayStartupError(
        "failed to bind gateway socket on ws://127.0.0.1:43124: Error: listen EADDRINUSE",
      ),
    ).toBe(true);
    expect(__testing.isRetryableGatewayStartupError("gateway failed to become healthy")).toBe(
      false,
    );
  });

  it("treats startup token mismatches as retryable rpc startup errors", () => {
    expect(
      __testing.isRetryableRpcStartupError(
        "unauthorized: gateway token mismatch (set gateway.remote.token to match gateway.auth.token)",
      ),
    ).toBe(true);
    expect(__testing.isRetryableRpcStartupError("permission denied")).toBe(false);
  });

  it("probes gateway health with a one-shot HEAD request through the SSRF guard", async () => {
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValue({
      response: { ok: true },
      release,
    });

    await expect(
      __testing.fetchLocalGatewayHealth({
        baseUrl: "http://127.0.0.1:43124",
        healthPath: "/readyz",
      }),
    ).resolves.toBe(true);

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "http://127.0.0.1:43124/readyz",
        init: expect.objectContaining({
          method: "HEAD",
          headers: {
            connection: "close",
          },
          signal: expect.any(AbortSignal),
        }),
        policy: { allowPrivateNetwork: true },
        auditContext: "qa-lab-gateway-child-health",
      }),
    );
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
        "botToken=12345:AbCdEfGhIjKl",
        '"driverToken":"12345:driver-secr3t"',
        "sutToken='12345:sut-secr3t'",
        "leaseToken=lease-12345",
        "url=http://127.0.0.1:18789/#token=abc123",
      ].join("\n"),
      "utf8",
    );
    await writeFile(stderrLogPath, "Authorization: Bearer secret+/token=123456", "utf8");
    await mkdir(path.join(tempRoot, "state"), { recursive: true });
    await writeFile(path.join(tempRoot, "state", "secret.txt"), "do-not-copy", "utf8");

    await __testing.preserveQaGatewayDebugArtifacts({
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
        "botToken=<redacted>",
        '"driverToken":"<redacted>"',
        "sutToken=<redacted>",
        "leaseToken=<redacted>",
        "url=http://127.0.0.1:18789/#token=<redacted>",
      ].join("\n"),
    );
    await expect(readFile(path.join(artifactDir, "gateway.stderr.log"), "utf8")).resolves.toBe(
      "Authorization: Bearer <redacted>",
    );
    await expect(readFile(path.join(artifactDir, "README.txt"), "utf8")).resolves.toContain(
      "was not copied because it may contain credentials or auth tokens",
    );
  });

  it("rejects preserved gateway artifacts outside the repo root", async () => {
    await expect(
      __testing.assertQaArtifactDirWithinRepo("/tmp/openclaw-repo", "/tmp/outside"),
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
      __testing.assertQaArtifactDirWithinRepo(
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

    await __testing.cleanupQaGatewayTempRoots({
      tempRoot,
      stagedBundledPluginsRoot: stagedRoot,
    });

    await expect(lstat(tempRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(stagedRoot)).rejects.toMatchObject({ code: "ENOENT" });
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
      __testing.resolveQaBundledPluginSourceDir({
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
      __testing.resolveQaBundledPluginSourceDir({
        repoRoot,
        pluginId: "qa-channel",
      }),
    ).toBe(path.join(repoRoot, "extensions", "qa-channel"));
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
      __testing.resolveQaBundledPluginSourceDir({
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
    await mkdir(path.join(repoRoot, "dist", "extensions", "speech-core"), { recursive: true });
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
    await writeFile(path.join(repoRoot, "dist", "shared-chunk-abc123.js"), "export {};\n", "utf8");
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "qa-bundled-target-"));
    cleanups.push(async () => {
      await rm(tempRoot, { recursive: true, force: true });
    });

    const { bundledPluginsDir, stagedRoot } = await __testing.createQaBundledPluginsDir({
      repoRoot,
      tempRoot,
      allowedPluginIds: ["qa-channel", "memory-core"],
    });

    expect((await readdir(bundledPluginsDir)).toSorted()).toEqual([
      "memory-core",
      "qa-channel",
      "speech-core",
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
    expect(stagedRoot).not.toBeNull();
    if (!stagedRoot) {
      throw new Error("expected staged runtime root");
    }
    await expect(readFile(path.join(stagedRoot, "package.json"), "utf8")).resolves.toContain(
      '"name": "openclaw"',
    );
    await expect(
      import(
        `${pathToFileURL(path.join(bundledPluginsDir, "qa-channel", "index.js")).href}?t=${Date.now()}`
      ),
    ).resolves.toMatchObject({
      accountId: "qa",
    });
    expect((await lstat(path.join(bundledPluginsDir, "qa-channel"))).isDirectory()).toBe(true);
    expect((await lstat(path.join(bundledPluginsDir, "memory-core"))).isDirectory()).toBe(true);
    expect((await lstat(path.join(bundledPluginsDir, "speech-core"))).isDirectory()).toBe(true);
    await expect(
      lstat(
        path.join(
          repoRoot,
          ".artifacts",
          "qa-runtime",
          path.basename(tempRoot),
          "dist",
          "shared-chunk-abc123.js",
        ),
      ),
    ).resolves.toBeTruthy();
  });

  it("skips transient runtime dependency artifacts while staging built bundled plugins", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "qa-bundled-runtime-deps-"));
    cleanups.push(async () => {
      await rm(repoRoot, { recursive: true, force: true });
    });
    await writeFile(
      path.join(repoRoot, "package.json"),
      JSON.stringify({ name: "openclaw", type: "module" }, null, 2),
      "utf8",
    );
    const pluginDir = path.join(repoRoot, "dist", "extensions", "qa-channel");
    await mkdir(path.join(pluginDir, ".openclaw-runtime-deps-copy-active", "node_modules"), {
      recursive: true,
    });
    await writeFile(
      path.join(pluginDir, "package.json"),
      JSON.stringify({ name: "@openclaw/qa-channel", type: "module" }, null, 2),
      "utf8",
    );
    await writeFile(path.join(pluginDir, "index.js"), "export const ok = true;\n", "utf8");
    await writeFile(path.join(pluginDir, ".openclaw-runtime-deps.json"), "{}\n", "utf8");
    await writeFile(path.join(pluginDir, ".openclaw-runtime-deps-stamp.json"), "{}\n", "utf8");
    await writeFile(
      path.join(pluginDir, ".openclaw-runtime-deps-copy-active", "node_modules", "transient.js"),
      "export {};\n",
      "utf8",
    );
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "qa-bundled-runtime-deps-target-"));
    cleanups.push(async () => {
      await rm(tempRoot, { recursive: true, force: true });
    });

    const { bundledPluginsDir } = await __testing.createQaBundledPluginsDir({
      repoRoot,
      tempRoot,
      allowedPluginIds: ["qa-channel"],
    });

    const stagedPluginDir = path.join(bundledPluginsDir, "qa-channel");
    await expect(readFile(path.join(stagedPluginDir, "index.js"), "utf8")).resolves.toContain("ok");
    await expect(lstat(path.join(stagedPluginDir, ".openclaw-runtime-deps.json"))).rejects.toThrow(
      /ENOENT/u,
    );
    await expect(
      lstat(path.join(stagedPluginDir, ".openclaw-runtime-deps-stamp.json")),
    ).rejects.toThrow(/ENOENT/u);
    await expect(
      lstat(path.join(stagedPluginDir, ".openclaw-runtime-deps-copy-active")),
    ).rejects.toThrow(/ENOENT/u);
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

    const { bundledPluginsDir } = await __testing.createQaBundledPluginsDir({
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
    await expect(
      import(
        `${pathToFileURL(path.join(bundledPluginsDir, "runtime-only", "index.js")).href}?t=${Date.now()}`
      ),
    ).resolves.toMatchObject({
      marker: "runtime",
    });
    await expect(
      lstat(
        path.join(
          repoRoot,
          ".artifacts",
          "qa-runtime",
          path.basename(tempRoot),
          "dist",
          "runtime-chunk.js",
        ),
      ),
    ).resolves.toBeTruthy();
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
      __testing.createQaBundledPluginsDir({
        repoRoot,
        tempRoot,
        allowedPluginIds: ["../escape"],
      }),
    ).rejects.toThrow("invalid QA bundled plugin id: ../escape");
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

    const { bundledPluginsDir, stagedRoot } = await __testing.createQaBundledPluginsDir({
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
    await expect(
      import(
        `${pathToFileURL(path.join(bundledPluginsDir, "qa-channel", "index.ts")).href}?t=${Date.now()}`
      ),
    ).resolves.toMatchObject({
      accountId: "qa:ok",
    });
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
        providers: ["openai", "openai-codex"],
        cliBackends: ["codex-cli"],
      }),
      "utf8",
    );

    await expect(
      __testing.resolveQaOwnerPluginIdsForProviderIds({
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
      __testing.resolveQaOwnerPluginIdsForProviderIds({
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

    await expect(
      __testing.readQaLiveProviderConfigOverrides({
        providerIds: ["custom-openai"],
        env: { OPENCLAW_QA_LIVE_PROVIDER_CONFIG_PATH: configPath },
      }),
    ).resolves.toEqual({
      "custom-openai": expect.objectContaining({
        baseUrl: "https://api.example.test/v1",
        api: "openai-responses",
      }),
    });
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
      __testing.resolveQaRuntimeHostVersion({
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
    await mkdir(path.join(bundledRoot, "speech-core"), { recursive: true });
    await writeFile(
      path.join(bundledRoot, "speech-core", "package.json"),
      JSON.stringify({ openclaw: { install: { minHostVersion: ">=2026.4.9" } } }),
      "utf8",
    );

    await expect(
      __testing.resolveQaRuntimeHostVersion({
        repoRoot,
        allowedPluginIds: ["qa-channel"],
      }),
    ).resolves.toBe("2026.4.9");
  });
});
