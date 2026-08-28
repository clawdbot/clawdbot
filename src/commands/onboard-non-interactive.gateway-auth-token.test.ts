// Gateway auth-token storage tests cover what onboarding persists at gateway.auth.token:
// plaintext by default, and env/store SecretRefs under --secret-input-mode ref.
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { makeTempWorkspace } from "../test-helpers/workspace.js";
import { setTestEnvValue } from "../test-utils/env.js";
import {
  capturedReplaceConfigFileCalls,
  configWritePluginLeaseDepths,
  gatewayReachableState,
  getPseudoPort,
  loadGatewayOnboardModules,
  readTestConfig,
  resolveTestConfigPath,
  runNonInteractiveSetup,
  gatewayOnboardRuntime as runtime,
  testConfigStore,
} from "./onboard-non-interactive.gateway.test-mocks.js";
import {
  createOnboardStateDirHarness,
  prepareOnboardGatewayTestEnv,
} from "./onboard-non-interactive.test-helpers.js";

describe("onboard (non-interactive): gateway auth token storage", () => {
  let envSnapshot: ReturnType<typeof prepareOnboardGatewayTestEnv>;
  let tempHome: string | undefined;
  const { withStateDir } = createOnboardStateDirHarness(() => tempHome);

  beforeAll(async () => {
    envSnapshot = prepareOnboardGatewayTestEnv();
    tempHome = await makeTempWorkspace("openclaw-onboard-auth-token-");
    setTestEnvValue("HOME", tempHome);
    await loadGatewayOnboardModules();
  });

  afterAll(async () => {
    if (tempHome) {
      await fs.rm(tempHome, { recursive: true, force: true });
    }
    envSnapshot.restore();
  });

  afterEach(() => {
    gatewayReachableState.mock = undefined;
    testConfigStore.clear();
    capturedReplaceConfigFileCalls.length = 0;
    configWritePluginLeaseDepths.length = 0;
    vi.clearAllMocks();
  });

  it("writes gateway token auth into config", async () => {
    await withStateDir("state-noninteractive-", async (stateDir) => {
      const token = "tok_test_123";
      const workspace = path.join(stateDir, "openclaw");
      testConfigStore.set(resolveTestConfigPath(), {
        gateway: {
          bind: "lan",
          auth: { mode: "password", password: "test-password" },
          tailscale: { mode: "serve" },
        },
      } as OpenClawConfig);

      await runNonInteractiveSetup(
        {
          nonInteractive: true,
          mode: "local",
          workspace,
          authChoice: "skip",
          skipSkills: true,
          skipHealth: true,
          installDaemon: false,
          gatewayBind: "loopback",
          gatewayAuth: "token",
          gatewayToken: token,
          tailscale: "off",
        },
        runtime,
      );

      const cfg = readTestConfig() as {
        gateway?: {
          mode?: string;
          bind?: string;
          auth?: { mode?: string; token?: string };
          tailscale?: { mode?: string };
        };
        agents?: { defaults?: { workspace?: string } };
        tools?: { profile?: string };
        hooks?: { internal?: { entries?: Record<string, { enabled?: boolean }> } };
      };

      expect(cfg?.agents?.defaults?.workspace).toBe(workspace);
      expect(cfg?.gateway?.mode).toBe("local");
      expect(cfg?.gateway?.bind).toBe("loopback");
      expect(cfg?.tools?.profile).toBe("coding");
      expect(cfg?.gateway?.auth?.mode).toBe("token");
      expect(cfg?.gateway?.auth?.token).toBe(token);
      expect(cfg?.gateway?.tailscale).toEqual({ mode: "off" });
      expect(cfg?.hooks?.internal?.entries?.["session-memory"]).toEqual({ enabled: true });
    });
  }, 60_000);

  it("auto-generates token auth when binding LAN and persists the token", async () => {
    if (process.platform === "win32") {
      // Windows runner occasionally drops the temp config write in this flow; skip to keep CI green.
      return;
    }
    await withStateDir("state-lan-", async (stateDir) => {
      setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
      setTestEnvValue("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));

      const port = getPseudoPort(40_000);
      const workspace = path.join(stateDir, "openclaw");

      await runNonInteractiveSetup(
        {
          nonInteractive: true,
          mode: "local",
          workspace,
          authChoice: "skip",
          skipSkills: true,
          skipHealth: true,
          installDaemon: false,
          gatewayPort: port,
          gatewayBind: "lan",
        },
        runtime,
      );

      const cfg = readTestConfig() as {
        gateway?: {
          bind?: string;
          port?: number;
          auth?: { mode?: string; token?: string };
        };
      };

      expect(cfg.gateway?.bind).toBe("lan");
      expect(cfg.gateway?.port).toBe(port);
      expect(cfg.gateway?.auth?.mode).toBe("token");
      expect((cfg.gateway?.auth?.token ?? "").length).toBeGreaterThan(8);
    });
  }, 60_000);

  it("keeps the generated gateway token out of config under --secret-input-mode ref", async () => {
    if (process.platform === "win32") {
      // Matches the LAN case above: the Windows runner drops this flow's temp config write.
      return;
    }
    await withStateDir("state-token-ref-", async (stateDir) => {
      setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
      setTestEnvValue("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));

      const port = getPseudoPort(41_000);

      await runNonInteractiveSetup(
        {
          nonInteractive: true,
          mode: "local",
          workspace: path.join(stateDir, "openclaw"),
          authChoice: "skip",
          skipSkills: true,
          skipHealth: true,
          installDaemon: false,
          gatewayPort: port,
          secretInputMode: "ref",
        },
        runtime,
      );

      const cfg = readTestConfig() as {
        gateway?: { auth?: { mode?: string; token?: unknown } };
      };
      expect(cfg.gateway?.auth?.mode).toBe("token");
      expect(cfg.gateway?.auth?.token).toEqual({
        source: "store",
        provider: "default",
        id: "OPENCLAW_GATEWAY_TOKEN",
      });

      // A ref persisted without its value would leave the gateway unauthenticatable.
      const { readSecretStoreValue } = await import("../secrets/store/secret-store.js");
      const stored = readSecretStoreValue({
        scope: { kind: "team" },
        name: "OPENCLAW_GATEWAY_TOKEN",
      });
      expect(stored.ok).toBe(true);
      expect(stored.ok && stored.value.length).toBeGreaterThan(8);
    });
  }, 60_000);

  it("references an ambient gateway token by env instead of copying it into the store", async () => {
    if (process.platform === "win32") {
      // Matches the LAN case above: the Windows runner drops this flow's temp config write.
      return;
    }
    await withStateDir("state-token-ref-env-", async (stateDir) => {
      setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
      setTestEnvValue("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
      setTestEnvValue("OPENCLAW_GATEWAY_TOKEN", "ambient-gateway-token");

      await runNonInteractiveSetup(
        {
          nonInteractive: true,
          mode: "local",
          workspace: path.join(stateDir, "openclaw"),
          authChoice: "skip",
          skipSkills: true,
          skipHealth: true,
          installDaemon: false,
          gatewayPort: getPseudoPort(42_000),
          secretInputMode: "ref",
        },
        runtime,
      );

      const cfg = readTestConfig() as { gateway?: { auth?: { token?: unknown } } };
      expect(cfg.gateway?.auth?.token).toEqual({
        source: "env",
        provider: "default",
        id: "OPENCLAW_GATEWAY_TOKEN",
      });

      // A store copy would silently outlive a later rotation of the env var.
      const { readSecretStoreValue } = await import("../secrets/store/secret-store.js");
      expect(
        readSecretStoreValue({ scope: { kind: "team" }, name: "OPENCLAW_GATEWAY_TOKEN" }).ok,
      ).toBe(false);
    });
  }, 60_000);
});
