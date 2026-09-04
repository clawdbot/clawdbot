import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import { extractFirstTextBlock } from "../shared/chat-message-content.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";

const ENV_KEYS = [
  "HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_SKIP_CHANNELS",
  "OPENCLAW_SKIP_GMAIL_WATCHER",
  "OPENCLAW_SKIP_CRON",
  "OPENCLAW_SKIP_CANVAS_HOST",
  "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
  "OPENCLAW_SKIP_PROVIDERS",
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR",
] as const;

type ChatFinalPayload = {
  runId?: string;
  state?: string;
  message?: unknown;
};

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("Gateway allowlist command", () => {
  it("surfaces a pairing-store read failure through chat.send", { timeout: 90_000 }, async () => {
    const envSnapshot = captureEnv([...ENV_KEYS]);
    // The native method needs its receiver when restored and called from the fault wrapper.
    // oxlint-disable-next-line typescript/unbound-method
    const originalPrepare = DatabaseSync.prototype.prepare;
    let faultArmed = false;
    let faultObserved = false;
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    let finalTimeout: ReturnType<typeof setTimeout> | undefined;

    try {
      const home = tempDirs.make("openclaw-allowlist-gateway-");
      const stateDir = path.join(home, ".openclaw");
      const configPath = path.join(stateDir, "openclaw.json");
      const workspaceDir = path.join(home, "workspace");
      await Promise.all([
        fs.mkdir(stateDir, { recursive: true }),
        fs.mkdir(workspaceDir, { recursive: true }),
      ]);
      for (const [key, value] of Object.entries({
        HOME: home,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(process.cwd(), "extensions"),
        OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
      })) {
        setTestEnvValue(key, value);
      }

      const runId = randomUUID();
      let resolveFinal: ((payload: ChatFinalPayload) => void) | undefined;
      const final = new Promise<ChatFinalPayload>((resolve) => {
        resolveFinal = resolve;
      });
      gateway = await startGatewayWithClient({
        cfg: {
          agents: {
            defaults: { workspace: workspaceDir, skipBootstrap: true },
            entries: { main: { default: true } },
          },
          channels: {
            telegram: {
              enabled: true,
              botToken: "test-token",
              dmPolicy: "allowlist",
              allowFrom: ["123"],
            },
          },
          commands: { text: true },
          gateway: { auth: { mode: "token", token: "allowlist-gateway-token" } },
          plugins: {
            enabled: true,
            allow: ["telegram"],
            entries: { telegram: { enabled: true } },
          },
        },
        configPath,
        token: "allowlist-gateway-token",
        clientDisplayName: "allowlist-store-read-failure",
        onEvent: (event) => {
          if (event.event !== "chat" || !event.payload || typeof event.payload !== "object") {
            return;
          }
          const payload = event.payload as ChatFinalPayload;
          if (payload.runId === runId && payload.state === "final") {
            resolveFinal?.(payload);
          }
        },
      });

      DatabaseSync.prototype.prepare = function prepareWithAllowlistReadFailure(sql) {
        if (
          faultArmed &&
          sql.includes("channel_pairing_allow_entries") &&
          (new Error().stack ?? "").includes("commands-allowlist")
        ) {
          faultArmed = false;
          faultObserved = true;
          throw new Error("injected pairing-store read failure");
        }
        return originalPrepare.call(this, sql);
      };
      faultArmed = true;

      await gateway.client.request("chat.send", {
        sessionKey: "agent:main:main",
        message: "/allowlist list dm channel=telegram",
        deliver: false,
        idempotencyKey: runId,
      });
      const timeout = new Promise<never>((_resolve, reject) => {
        finalTimeout = setTimeout(
          () => reject(new Error("timed out waiting for allowlist command reply")),
          30_000,
        );
      });
      const payload = await Promise.race([final, timeout]);

      expect(faultObserved).toBe(true);
      expect(extractFirstTextBlock(payload.message)).toContain(
        "Paired allowFrom (store): unavailable (read failed). Retry this command; if it still fails, run openclaw doctor.",
      );
    } finally {
      if (finalTimeout) {
        clearTimeout(finalTimeout);
      }
      DatabaseSync.prototype.prepare = originalPrepare;
      if (gateway) {
        await disconnectGatewayClient(gateway.client).catch(() => undefined);
        await gateway.server.close().catch(() => undefined);
      }
      envSnapshot.restore();
      clearRuntimeConfigSnapshot();
      clearConfigCache();
      clearSessionStoreCacheForTest();
    }
  });
});
