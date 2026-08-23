// A copied persisted Codex session must reactivate its installed harness owner on Gateway startup.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { connectGatewayClient, disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import { upsertSessionEntry } from "../src/plugin-sdk/session-store-runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../src/plugin-sdk/sqlite-runtime-testing.js";
import { writePersistedInstalledPluginIndexInstallRecords } from "../src/plugins/installed-plugin-index-records.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";

const PLUGIN_ID = "codex";
const SESSION_KEY = "agent:main:copied-codex-session";
const VISIBLE_REPLY = "COPIED_CODEX_SESSION_RESUMED";
const TEST_TIMEOUT_MS = 120_000;
const instances: OpenClawTestInstance[] = [];

afterEach(async () => {
  await Promise.all(instances.splice(0).map(async (instance) => await instance.cleanup()));
  closeOpenClawAgentDatabasesForTest();
});

function buildCopiedStateConfig(): OpenClawConfig {
  return {
    plugins: { enabled: true, slots: { memory: "none" } },
    models: {
      providers: {
        "copied-session-proof": {
          api: "openai-responses",
          baseUrl: "https://example.invalid/v1",
          models: [
            {
              id: "proof-model",
              name: "Copied session proof model",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128_000,
              maxTokens: 4_096,
            },
          ],
        },
      },
    },
    agents: { defaults: { model: { primary: "copied-session-proof/proof-model" } } },
  };
}

async function installCodexHarnessFixture(stateDir: string, config: OpenClawConfig): Promise<void> {
  const pluginDir = path.join(stateDir, "extensions", PLUGIN_ID);
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: PLUGIN_ID,
      name: "Copied Codex session proof",
      activation: { onStartup: false, onAgentHarnesses: [PLUGIN_ID] },
      configSchema: { type: "object", additionalProperties: false },
    }),
  );
  await fs.writeFile(
    path.join(pluginDir, "package.json"),
    JSON.stringify({
      name: "@openclaw/codex",
      version: "2026.8.1",
      type: "module",
      openclaw: { extensions: ["./index.js"] },
    }),
  );
  await fs.writeFile(
    path.join(pluginDir, "index.js"),
    `export default {
      id: "codex",
      register(api) {
        api.registerAgentHarness({
          id: "codex",
          label: "Copied Codex session proof",
          authBootstrap: "harness",
          supports: () => ({ supported: true, priority: 100 }),
          async runAttempt() {
            const text = ${JSON.stringify(VISIBLE_REPLY)};
            const assistant = {
              role: "assistant",
              content: [{ type: "text", text }],
              api: "openai-responses",
              provider: "copied-session-proof",
              model: "proof-model",
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: "stop",
              timestamp: Date.now(),
            };
            return {
              terminal: { kind: "ok" },
              sessionIdUsed: "copied-codex-thread",
              messagesSnapshot: [assistant],
              assistantTexts: [text],
              toolMetas: [],
              lastAssistant: assistant,
              didSendViaMessagingTool: false,
              messagingToolSentTexts: [],
              messagingToolSentMediaUrls: [],
              messagingToolSentTargets: [],
              cloudCodeAssistFormatError: false,
              replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
              itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
            };
          },
        });
      },
    };\n`,
  );
  await writePersistedInstalledPluginIndexInstallRecords(
    {
      [PLUGIN_ID]: {
        source: "path",
        sourcePath: pluginDir,
        installPath: pluginDir,
      },
    },
    {
      stateDir,
      config,
      candidates: [
        {
          idHint: PLUGIN_ID,
          source: path.join(pluginDir, "index.js"),
          rootDir: pluginDir,
          origin: "global",
        },
      ],
    },
  );
}

describe("Gateway copied Codex session resume", () => {
  it(
    "resumes a copied persisted Codex session when config no longer selects its harness",
    async () => {
      const config = buildCopiedStateConfig();
      const instance = await createOpenClawTestInstance({
        name: "copied-codex-session-resume",
        config,
        env: {
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_SKIP_PROVIDERS: undefined,
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        },
      });
      instances.push(instance);
      await installCodexHarnessFixture(instance.stateDir, config);

      instance.state.applyEnv();
      await upsertSessionEntry({
        agentId: "main",
        sessionKey: SESSION_KEY,
        entry: {
          sessionId: "copied-codex-thread",
          updatedAt: Date.now(),
          modelProvider: "copied-session-proof",
          model: "proof-model",
          modelSelectionLocked: true,
          agentHarnessId: "codex",
        },
      });
      closeOpenClawAgentDatabasesForTest();

      await instance.startGateway();
      const client = await connectGatewayClient({
        url: instance.url,
        token: instance.gatewayToken,
        requestTimeoutMs: 30_000,
      });
      try {
        const payload = await client.request(
          "agent",
          {
            sessionKey: SESSION_KEY,
            idempotencyKey: "copied-codex-session-resume",
            message: "Resume this copied conversation.",
            deliver: false,
            timeout: 30,
          },
          { expectFinal: true, timeoutMs: 30_000 },
        );

        expect(payload).toMatchObject({
          status: "ok",
          result: { payloads: [{ text: VISIBLE_REPLY }] },
        });
      } finally {
        await disconnectGatewayClient(client).catch(() => undefined);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
