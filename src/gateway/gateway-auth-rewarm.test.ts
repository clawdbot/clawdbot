import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import {
  BUILD_STAMP_FILE,
  resolveGitHead,
  RUNTIME_POSTBUILD_STAMP_FILE,
} from "../../scripts/lib/local-build-metadata.mts";
import { acquireGatewayTestClient } from "../../test/helpers/gateway-client.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../test/helpers/openclaw-test-instance.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

const REWARM_MESSAGE = "provider auth state re-warmed (auth-profile-failure)";
const RATE_OBSERVATION_MS = 5_000;

// Unit regressions prove the immediate no-invalidation decision. This smoke
// preserves the real HTTP -> persisted profile -> Gateway subscriber composition.
describe("Gateway profile failure recovery", () => {
  it(
    "records rate limits and retains authentication recovery through the built Gateway",
    {
      timeout: 180_000,
    },
    async () => {
      const repoRoot = process.cwd();
      const head = resolveGitHead({ cwd: repoRoot });
      expect(head).toMatch(/^[0-9a-f]{40}$/u);
      await fs.access(path.join(repoRoot, "dist/index.js"));
      for (const [file, field] of [
        [BUILD_STAMP_FILE, "head"],
        [RUNTIME_POSTBUILD_STAMP_FILE, "head"],
        ["build-info.json", "commit"],
      ] as const) {
        const metadata = JSON.parse(await fs.readFile(path.join(repoRoot, "dist", file), "utf8"));
        expect(metadata[field], file).toBe(head);
      }

      const credentials = { rate: "qa-rate-profile-key", auth: "qa-auth-profile-key" };
      const profileIds = { rate: "mock-openai:rate", auth: "mock-openai:auth" };
      const requests = { rate: 0, auth: 0 };
      let phase: keyof typeof requests = "rate";
      let unexpectedCredential = false;
      const providerServer = createServer((request, response) => {
        request.resume();
        if (request.method !== "POST" || request.url !== "/v1/responses") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ data: [] }));
          return;
        }
        requests[phase] += 1;
        unexpectedCredential ||= request.headers.authorization !== `Bearer ${credentials[phase]}`;
        response.writeHead(phase === "rate" ? 429 : 401, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              message:
                phase === "rate" ? "Synthetic rate limit" : "Synthetic authentication failure",
              type: phase === "rate" ? "rate_limit_error" : "authentication_error",
            },
          }),
        );
      });
      let instance: OpenClawTestInstance | undefined;
      let client: Awaited<ReturnType<typeof acquireGatewayTestClient>> | undefined;

      await runQaGatewayFixture(
        async () => {
          await new Promise<void>((resolve, reject) => {
            providerServer.once("error", reject);
            providerServer.listen(0, "127.0.0.1", resolve);
          });
          const address = providerServer.address();
          if (!address || typeof address === "string") {
            throw new Error("Mock provider did not expose its listening port");
          }
          const provider = buildMockOpenAiResponsesProvider(
            `http://127.0.0.1:${address.port}/v1`,
            "gpt-5.6-luna",
          );
          instance = await createOpenClawTestInstance({
            name: "auth-rewarm",
            cwd: repoRoot,
            stopTimeoutMs: 10_000,
            env: {
              VITEST: undefined,
              NODE_ENV: "production",
              OPENCLAW_TEST_CONSOLE: "1",
              OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
              OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
              OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
            },
          });
          const gateway = instance;
          const cfg = {
            gateway: {
              port: gateway.port,
              auth: { mode: "token", token: gateway.gatewayToken },
              controlUi: { enabled: false },
            },
            hooks: { enabled: false },
            agents: {
              ownership: "explicit",
              defaults: {
                workspace: gateway.state.workspaceDir,
                skipBootstrap: true,
                heartbeat: { every: "0m" },
                model: { primary: provider.modelRef, fallbacks: [] },
                models: {
                  [provider.modelRef]: {
                    agentRuntime: { id: "openclaw" },
                    params: { transport: "sse", openaiWsWarmup: false },
                  },
                },
              },
              entries: {
                rate: {
                  model: { primary: `${provider.modelRef}@${profileIds.rate}`, fallbacks: [] },
                },
                auth: {
                  model: { primary: `${provider.modelRef}@${profileIds.auth}`, fallbacks: [] },
                },
              },
            },
            auth: {
              profiles: {
                [profileIds.rate]: { provider: provider.providerId, mode: "api_key" },
                [profileIds.auth]: { provider: provider.providerId, mode: "api_key" },
              },
            },
            models: {
              mode: "replace",
              providers: {
                [provider.providerId]: {
                  ...provider.config,
                  apiKey: undefined,
                  request: { allowPrivateNetwork: true },
                },
              },
            },
            plugins: { slots: { memory: "none" } },
            tools: { profile: "minimal" },
          } satisfies OpenClawConfig;
          await gateway.state.writeConfig(cfg);
          for (const agentId of ["rate", "auth"] as const) {
            await gateway.state.writeAuthProfiles(
              {
                version: 1,
                profiles: {
                  [profileIds[agentId]]: {
                    type: "api_key",
                    provider: provider.providerId,
                    key: credentials[agentId],
                  },
                },
              },
              agentId,
            );
          }
          expect(await gateway.entrypoint()).toEqual(["dist/index.js"]);
          await gateway.startGateway();
          client = await acquireGatewayTestClient(
            {
              url: gateway.url,
              token: gateway.gatewayToken,
              clientName: "cli",
              mode: "cli",
              role: "operator",
              scopes: ["operator.admin", "operator.read", "operator.write"],
            },
            {
              timeoutMs: 30_000,
              timeoutMessage: "Auth-rewarm Gateway client did not connect",
              closeMessage: "Auth-rewarm Gateway closed",
            },
          );
          const activeClient = client;
          const failTurn = async (agentId: keyof typeof requests) => {
            const accepted = await activeClient.request<{ runId: string; status: string }>(
              "agent",
              {
                agentId,
                sessionKey: `agent:${agentId}:auth-rewarm`,
                message: `AUTH_REWARM_${agentId.toUpperCase()}`,
                deliver: false,
                idempotencyKey: randomUUID(),
              },
            );
            expect(accepted.status).toBe("accepted");
            const terminal = await activeClient.request<{ status: string }>(
              "agent.wait",
              {
                runId: accepted.runId,
                timeoutMs: 60_000,
              },
              { timeoutMs: 65_000 },
            );
            expect(terminal.status).toBe("error");
            expect(requests[agentId]).toBeGreaterThan(0);
            expect(unexpectedCredential).toBe(false);
            return loadPersistedAuthProfileStore(gateway.state.agentDir(agentId))?.usageStats?.[
              profileIds[agentId]
            ];
          };
          const rewarmCount = () => gateway.logs().split(REWARM_MESSAGE).length - 1;
          expect((await failTurn("rate"))?.cooldownReason).toBe("rate_limit");
          await sleep(RATE_OBSERVATION_MS);
          const afterRate = rewarmCount();
          expect(afterRate).toBe(0);

          phase = "auth";
          const authStats = await failTurn("auth");
          expect(["auth", "auth_permanent"]).toContain(
            authStats?.cooldownReason ?? authStats?.disabledReason,
          );
          await vi.waitFor(() => expect(rewarmCount()).toBe(1), { timeout: 60_000, interval: 100 });
          console.info(
            "[auth-rewarm-runtime-proof]",
            JSON.stringify({
              head,
              requests,
              rateCooldownRecorded: true,
              authFailureRecorded: true,
              rateObservationMs: RATE_OBSERVATION_MS,
              afterRateRewarms: afterRate,
              afterAuthRewarms: rewarmCount(),
            }),
          );
        },
        async () => {
          await client?.stopAndWait({ timeoutMs: 1_000 });
        },
        async () => {
          await instance?.cleanup();
        },
        async () => {
          providerServer.closeAllConnections();
          await new Promise<void>((resolve, reject) => {
            providerServer.close((error) => (error ? reject(error) : resolve()));
          });
        },
      );
    },
  );
});
