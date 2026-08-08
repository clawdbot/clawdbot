import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveStorePath } from "../src/config/sessions/paths.js";
import { loadSessionEntry } from "../src/config/sessions/session-accessor.js";
import {
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../src/gateway/test-helpers.e2e.js";
import { closeOpenClawAgentDatabasesForTest } from "../src/state/openclaw-agent-db.js";
import { captureEnv, setTestEnvValue } from "../src/test-utils/env.js";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";

const TEST_TIMEOUT_MS = 30_000;
const TARGET_MODEL = "fixture/selected@work";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_SKIP_CHANNELS",
  "OPENCLAW_SKIP_GMAIL_WATCHER",
  "OPENCLAW_SKIP_CRON",
  "OPENCLAW_SKIP_CANVAS_HOST",
  "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
  "OPENCLAW_SKIP_PROVIDERS",
  "OPENCLAW_TEST_MINIMAL_GATEWAY",
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
] as const;

async function setupTempHome() {
  const env = captureEnv([...ENV_KEYS]);
  const home = tempDirs.make("openclaw-sessions-tool-provenance-");
  const stateDir = path.join(home, ".openclaw");
  const workspace = path.join(home, "workspace");
  const bundledPlugins = path.join(home, "empty-bundled-plugins");
  await Promise.all([
    fs.mkdir(stateDir, { recursive: true }),
    fs.mkdir(workspace, { recursive: true }),
    fs.mkdir(bundledPlugins, { recursive: true }),
  ]);
  setTestEnvValue("HOME", home);
  setTestEnvValue("USERPROFILE", home);
  setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
  setTestEnvValue("OPENCLAW_SKIP_CHANNELS", "1");
  setTestEnvValue("OPENCLAW_SKIP_GMAIL_WATCHER", "1");
  setTestEnvValue("OPENCLAW_SKIP_CRON", "1");
  setTestEnvValue("OPENCLAW_SKIP_CANVAS_HOST", "1");
  setTestEnvValue("OPENCLAW_SKIP_BROWSER_CONTROL_SERVER", "1");
  setTestEnvValue("OPENCLAW_BUNDLED_PLUGINS_DIR", bundledPlugins);
  setTestEnvValue("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
  delete process.env.OPENCLAW_CONFIG_PATH;
  delete process.env.OPENCLAW_SKIP_PROVIDERS;
  delete process.env.OPENCLAW_TEST_MINIMAL_GATEWAY;
  return {
    configPath: path.join(stateDir, "openclaw.json"),
    env,
    workspace,
  };
}

type CreatedSession = {
  key: string;
  sessionId: string;
};

type ToolInvokeResult = {
  ok: boolean;
  error?: { message?: string };
};

describe("Sessions tool model provenance product proof", () => {
  it(
    "persists agent tool patches as automatic and external patches as user-owned",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const temp = await setupTempHome();
      const token = `sessions-tool-provenance-${process.pid}`;
      const cfg = {
        agents: {
          defaults: {
            workspace: temp.workspace,
            model: { primary: "fixture/default" },
            models: {
              "fixture/default": {},
              "fixture/selected": {},
            },
          },
        },
        gateway: { auth: { mode: "token", token } },
        models: {
          mode: "replace",
          providers: {
            fixture: {
              apiKey: "fixture-secret",
              baseUrl: "http://127.0.0.1:9/v1",
              models: [
                { id: "default", name: "Default", contextWindow: 8192 },
                { id: "selected", name: "Selected", contextWindow: 8192 },
              ],
            },
          },
        },
      };
      let started: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
      let agentSession: CreatedSession | undefined;
      let userSession: CreatedSession | undefined;

      try {
        try {
          started = await startGatewayWithClient({
            cfg,
            configPath: temp.configPath,
            token,
            clientDisplayName: "sessions-tool-provenance-proof",
          });
          agentSession = (await started.client.request("sessions.create", {
            agentId: "main",
            label: "Agent provenance proof",
          })) as CreatedSession;
          userSession = (await started.client.request("sessions.create", {
            agentId: "main",
            label: "User provenance proof",
          })) as CreatedSession;

          const toolResult = (await started.client.request("tools.invoke", {
            name: "sessions",
            sessionKey: agentSession.key,
            args: { action: "patch", model: TARGET_MODEL },
          })) as ToolInvokeResult;
          expect(toolResult).toMatchObject({ ok: true });

          await expect(
            started.client.request("sessions.patch", {
              key: userSession.key,
              model: TARGET_MODEL,
              modelOverrideSource: "auto",
            }),
          ).rejects.toThrow(/invalid sessions\.patch params/i);
          await started.client.request("sessions.patch", {
            key: userSession.key,
            model: TARGET_MODEL,
          });
        } finally {
          try {
            if (started) {
              await disconnectGatewayClient(started.client).catch(() => undefined);
              await started.server.close({ reason: "Sessions tool provenance proof complete" });
            }
          } finally {
            closeOpenClawAgentDatabasesForTest();
          }
        }

        if (!agentSession || !userSession) {
          throw new Error("Gateway proof did not create both sessions");
        }
        const storePath = resolveStorePath(undefined, { agentId: "main" });
        const agentEntry = loadSessionEntry({
          agentId: "main",
          sessionKey: agentSession.key,
          storePath,
        });
        const userEntry = loadSessionEntry({
          agentId: "main",
          sessionKey: userSession.key,
          storePath,
        });

        expect(agentEntry).toMatchObject({
          providerOverride: "fixture",
          modelOverride: "selected",
          modelOverrideSource: "auto",
          authProfileOverride: "work",
          authProfileOverrideSource: "auto",
        });
        expect(userEntry).toMatchObject({
          providerOverride: "fixture",
          modelOverride: "selected",
          modelOverrideSource: "user",
          authProfileOverride: "work",
          authProfileOverrideSource: "user",
        });

        console.info(
          `[sessions-tool-provenance-proof] ${JSON.stringify({
            head: process.env.OPENCLAW_PROOF_HEAD ?? "not-specified",
            gateway: "loopback-token-auth",
            agentOrigin: {
              entrypoint: "tools.invoke:sessions",
              dispatch: "in-process",
              modelOverrideSource: agentEntry?.modelOverrideSource,
              authProfileOverride: agentEntry?.authProfileOverride,
              authProfileOverrideSource: agentEntry?.authProfileOverrideSource,
            },
            directUser: {
              entrypoint: "sessions.patch",
              modelOverrideSource: userEntry?.modelOverrideSource,
              authProfileOverride: userEntry?.authProfileOverride,
              authProfileOverrideSource: userEntry?.authProfileOverrideSource,
            },
            publicRpcAllowsCallerProvenance: false,
          })}`,
        );
      } finally {
        closeOpenClawAgentDatabasesForTest();
        temp.env.restore();
      }
    },
  );
});
