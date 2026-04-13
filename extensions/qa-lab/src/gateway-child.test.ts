import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __testing, buildQaRuntimeEnv, resolveQaControlUiRoot } from "./gateway-child.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  fetchWithSsrFGuardMock.mockReset();
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
  it("keeps the slow-reply QA opt-out enabled under fast mode", () => {
    const env = buildQaRuntimeEnv({
      ...createParams(),
      providerMode: "mock-openai",
    });

    expect(env.OPENCLAW_TEST_FAST).toBe("1");
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

  it("scrubs direct and live provider keys in mock mode", () => {
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
      providerMode: "mock-openai",
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
  });

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
    const child = spawn(
      process.execPath,
      [
        "-e",
        [
          "process.on('SIGTERM', () => {});",
          "process.stdout.write('ready\\n');",
          "setInterval(() => {}, 1000);",
        ].join(""),
      ],
      {
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    cleanups.push(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          if (process.platform === "win32") {
            child.kill("SIGKILL");
          } else if (child.pid) {
            process.kill(-child.pid, "SIGKILL");
          }
        } catch {
          // The child already exited.
        }
      }
    });

    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.stdout?.once("data", () => resolve());
    });

    await __testing.stopQaGatewayChildProcessTree(child, {
      gracefulTimeoutMs: 50,
      forceTimeoutMs: 1_000,
    });

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
      'OPENCLAW_GATEWAY_TOKEN=qa-suite-token\nOPENAI_API_KEY="openai-live"\nurl=http://127.0.0.1:18789/#token=abc123',
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
      "OPENCLAW_GATEWAY_TOKEN=<redacted>\nOPENAI_API_KEY=<redacted>\nurl=http://127.0.0.1:18789/#token=<redacted>",
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
  it("prefers the built bundled plugin tree when present", async () => {
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

    expect(__testing.resolveQaBundledPluginsSourceRoot(repoRoot)).toBe(
      path.join(repoRoot, "dist", "extensions"),
    );
  });

  it("creates a scoped bundled plugin tree for the allowed plugins only", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "qa-bundled-scope-"));
    cleanups.push(async () => {
      await rm(repoRoot, { recursive: true, force: true });
    });
    await mkdir(path.join(repoRoot, "dist", "extensions", "qa-channel"), { recursive: true });
    await mkdir(path.join(repoRoot, "dist", "extensions", "memory-core"), { recursive: true });
    await mkdir(path.join(repoRoot, "dist", "extensions", "unused-plugin"), { recursive: true });
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

    expect((await readdir(bundledPluginsDir)).toSorted()).toEqual(["memory-core", "qa-channel"]);
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
    expect((await lstat(path.join(bundledPluginsDir, "qa-channel"))).isDirectory()).toBe(true);
    expect((await lstat(path.join(bundledPluginsDir, "memory-core"))).isDirectory()).toBe(true);
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
        bundledPluginsSourceRoot: bundledRoot,
        allowedPluginIds: ["memory-core", "qa-channel"],
      }),
    ).resolves.toBe("2026.4.8");
  });
});
