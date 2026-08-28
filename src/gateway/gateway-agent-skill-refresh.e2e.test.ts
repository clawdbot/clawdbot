import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { resetConfigOverrides } from "../config/runtime-overrides.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetAgentEventsForTest } from "../infra/agent-events.js";
import { registerSkillsChangeListener } from "../skills/runtime/refresh.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

const execFileAsync = promisify(execFile);
const ENV_KEYS = [
  "HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_TEST_MINIMAL_GATEWAY",
  "OPENCLAW_SKIP_CHANNELS",
  "OPENCLAW_SKIP_GMAIL_WATCHER",
  "OPENCLAW_SKIP_CRON",
  "OPENCLAW_SKIP_CANVAS_HOST",
  "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
  "OPENCLAW_SKIP_PROVIDERS",
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
] as const;

function resetGatewayState(): void {
  resetConfigOverrides();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  clearSessionStoreCacheForTest();
  resetAgentEventsForTest({ preserveListeners: true });
}

afterEach(resetGatewayState);

describe("Gateway agent skill refresh", () => {
  it(
    "refreshes managed-worktree skills once per edit and closes watchers with the Gateway",
    { timeout: 90_000 },
    async () => {
      const env = captureEnv([...ENV_KEYS]);
      const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-skill-refresh-"));
      const stateDir = path.join(home, ".openclaw");
      const workspace = path.join(home, "workspace");
      const seedSkillFile = path.join(workspace, "skills", "seed-proof", "SKILL.md");
      const canonicalSkillFile = path.join(workspace, "skills", "canonical-proof", "SKILL.md");
      const bundledPluginsDir = path.join(home, "empty-bundled-plugins");
      const configPath = path.join(stateDir, "openclaw.json");
      await Promise.all([
        fs.mkdir(path.dirname(seedSkillFile), { recursive: true }),
        fs.mkdir(bundledPluginsDir, { recursive: true }),
        fs.mkdir(stateDir, { recursive: true }),
      ]);
      await writeSkill(seedSkillFile, "seed-proof", "seed-skill-description");
      await initializeGitWorkspace(workspace);
      for (const [key, value] of Object.entries({
        HOME: home,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      })) {
        setTestEnvValue(key, value);
      }
      deleteTestEnvValue("OPENCLAW_CONFIG_PATH");
      deleteTestEnvValue("OPENCLAW_TEST_MINIMAL_GATEWAY");
      resetGatewayState();

      const requests: string[] = [];
      const providerServer = createServer((request, response) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          requests.push(Buffer.concat(chunks).toString("utf8"));
          const message = {
            type: "message",
            id: randomUUID(),
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "ok", annotations: [] }],
          };
          response.writeHead(200, { "content-type": "text/event-stream" });
          for (const event of [
            {
              type: "response.output_item.added",
              item: { ...message, status: "in_progress", content: [] },
            },
            { type: "response.output_item.done", item: message },
            {
              type: "response.completed",
              response: {
                status: "completed",
                usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
              },
            },
          ]) {
            response.write(`data: ${JSON.stringify(event)}\n\n`);
          }
          response.end("data: [DONE]\n\n");
        })().catch((error: unknown) => response.writeHead(500).end(String(error)));
      });
      const lifecycleEvents: string[] = [];
      const unregisterLifecycle = registerSkillsChangeListener((event) => {
        lifecycleEvents.push(event.reason);
      });
      let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
      let gatewayClosed = false;
      try {
        await new Promise<void>((resolve, reject) => {
          providerServer.once("error", reject);
          providerServer.listen(0, "127.0.0.1", resolve);
        });
        const address = providerServer.address();
        if (!address || typeof address === "string") {
          throw new Error("mock provider did not bind");
        }
        const provider = buildMockOpenAiResponsesProvider(
          `http://127.0.0.1:${address.port}/v1`,
          "skill-refresh",
        );
        const token = `skill-refresh-${process.pid}`;
        const gatewayEvents: string[] = [];
        const cfg = {
          agents: {
            defaults: {
              workspace,
              skipBootstrap: true,
              model: { primary: provider.modelRef },
              models: {
                [provider.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } },
              },
            },
          },
          gateway: { auth: { mode: "token", token } },
          models: { mode: "replace", providers: { [provider.providerId]: provider.config } },
          plugins: { slots: { memory: "none" } },
          tools: { profile: "coding" },
        } satisfies OpenClawConfig;
        gateway = await startGatewayWithClient({
          cfg,
          configPath,
          token,
          scopes: ["operator.admin", "operator.read", "operator.write"],
          onEvent: (event) => {
            if (event.event) {
              gatewayEvents.push(event.event);
            }
          },
        });

        const created = await gateway.client.request<{
          key: string;
          worktree: { path: string };
        }>("sessions.create", { agentId: "main", worktree: true, label: "Skill refresh" });
        const sessionKey = created.key;
        const worktreeSeedSkillFile = path.join(
          created.worktree.path,
          "skills",
          "seed-proof",
          "SKILL.md",
        );
        await runAgentTurn(gateway.client, sessionKey, "first");
        const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
        const first = loadSessionEntry({ agentId: "main", sessionKey, storePath });
        expect(first?.skillsSnapshot?.prompt).toContain("seed-skill-description");

        await new Promise((resolve) => {
          setTimeout(resolve, 1_000);
        });
        const firstLifecycleCount = lifecycleEvents.length;
        const firstEventCount = countSkillsChanged(gatewayEvents);
        await writeSkill(worktreeSeedSkillFile, "seed-proof", "worktree-root-description");
        await waitForLifecycleChange(lifecycleEvents, firstLifecycleCount + 1);
        await runAgentTurn(gateway.client, sessionKey, "second");
        const second = loadSessionEntry({ agentId: "main", sessionKey, storePath });
        expect(second?.skillsSnapshot?.version).toBeGreaterThan(
          first?.skillsSnapshot?.version ?? 0,
        );
        expect(second?.skillsSnapshot?.prompt).toContain("worktree-root-description");
        expect(requests.at(-1)).toContain("worktree-root-description");
        await waitForSkillsChanged(gatewayEvents, firstEventCount + 1);

        await runAgentTurn(gateway.client, sessionKey, "third without edit");
        const repeatedTurnEventCount = lifecycleEvents.length;
        await writeSkill(worktreeSeedSkillFile, "seed-proof", "worktree-root-description-v2");
        await waitForLifecycleChange(lifecycleEvents, repeatedTurnEventCount + 1);
        await expectNoAdditionalLifecycleChanges(lifecycleEvents, repeatedTurnEventCount + 1);
        await runAgentTurn(gateway.client, sessionKey, "fourth");
        const fourth = loadSessionEntry({ agentId: "main", sessionKey, storePath });
        expect(fourth?.skillsSnapshot?.version).toBeGreaterThan(
          second?.skillsSnapshot?.version ?? 0,
        );
        expect(fourth?.skillsSnapshot?.prompt).toContain("worktree-root-description-v2");

        await fs.mkdir(path.dirname(canonicalSkillFile), { recursive: true });
        const canonicalEventCount = lifecycleEvents.length;
        await writeSkill(canonicalSkillFile, "canonical-proof", "canonical-root-description");
        await waitForLifecycleChange(lifecycleEvents, canonicalEventCount + 1);
        await runAgentTurn(gateway.client, sessionKey, "fifth");
        const fifth = loadSessionEntry({ agentId: "main", sessionKey, storePath });
        expect(fifth?.skillsSnapshot?.version).toBeGreaterThan(
          fourth?.skillsSnapshot?.version ?? 0,
        );
        expect(fifth?.skillsSnapshot?.prompt).toContain("canonical-root-description");
        expect(requests.at(-1)).toContain("canonical-root-description");

        const localStartedAt = Date.now();
        const local = await execFileAsync(
          process.execPath,
          [
            path.join(process.cwd(), "openclaw.mjs"),
            "agent",
            "--local",
            "--agent",
            "main",
            "--session-key",
            "agent:main:local-skill-control",
            "--message",
            "local watcher control",
            "--json",
          ],
          { cwd: process.cwd(), env: process.env, timeout: 20_000 },
        );
        expect(local.stderr).not.toContain("timed out");
        expect(Date.now() - localStartedAt).toBeLessThan(20_000);

        await disconnectGatewayClient(gateway.client);
        const lifecycleCountBeforeClose = lifecycleEvents.length;
        await gateway.server.close({ reason: "skill refresh lifecycle proof complete" });
        gatewayClosed = true;
        await writeSkill(canonicalSkillFile, "canonical-proof", "after-gateway-close");
        await new Promise((resolve) => {
          setTimeout(resolve, 750);
        });
        expect(lifecycleEvents).toHaveLength(lifecycleCountBeforeClose);
      } finally {
        unregisterLifecycle();
        if (gateway && !gatewayClosed) {
          await disconnectGatewayClient(gateway.client).catch(() => undefined);
          await gateway.server.close({ reason: "skill refresh test cleanup" });
        }
        providerServer.closeAllConnections();
        await new Promise<void>((resolve) => {
          providerServer.close(() => resolve());
        });
        await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
        env.restore();
      }
    },
  );
});

async function runAgentTurn(
  client: Awaited<ReturnType<typeof startGatewayWithClient>>["client"],
  sessionKey: string,
  message: string,
): Promise<void> {
  const runId = randomUUID();
  const accepted = await client.request<{ runId?: string; status?: string }>("agent", {
    sessionKey,
    message,
    deliver: false,
    idempotencyKey: runId,
  });
  expect(accepted.status).toBe("accepted");
  const completed = await client.request<{ status?: string }>(
    "agent.wait",
    { runId: accepted.runId ?? runId, timeoutMs: 30_000 },
    { timeoutMs: 35_000 },
  );
  expect(completed.status).toBe("ok");
}

function countSkillsChanged(events: readonly string[]): number {
  return events.filter((event) => event === "skills.changed").length;
}

async function waitForSkillsChanged(events: readonly string[], expected: number): Promise<void> {
  await expect
    .poll(() => countSkillsChanged(events), { interval: 25, timeout: 35_000 })
    .toBe(expected);
}

async function waitForLifecycleChange(events: readonly string[], expected: number): Promise<void> {
  await expect.poll(() => events.length, { interval: 25, timeout: 5_000 }).toBe(expected);
}

async function expectNoAdditionalLifecycleChanges(
  events: readonly string[],
  expected: number,
): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 750);
  });
  expect(events).toHaveLength(expected);
}

async function initializeGitWorkspace(workspace: string): Promise<void> {
  await execFileAsync("git", ["init", "-b", "main", workspace]);
  await execFileAsync("git", ["-C", workspace, "config", "user.name", "OpenClaw Tests"]);
  await execFileAsync("git", ["-C", workspace, "config", "user.email", "tests@openclaw.invalid"]);
  await execFileAsync("git", ["-C", workspace, "add", "."]);
  await execFileAsync("git", ["-C", workspace, "commit", "-m", "initial"]);
}

async function writeSkill(file: string, name: string, description: string): Promise<void> {
  await fs.writeFile(
    file,
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    "utf8",
  );
}
