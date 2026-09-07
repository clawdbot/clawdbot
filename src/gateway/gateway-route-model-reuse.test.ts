import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUILD_STAMP_FILE,
  resolveGitHead,
  RUNTIME_POSTBUILD_STAMP_FILE,
} from "../../scripts/lib/local-build-metadata.mts";
import { acquireGatewayTestClient } from "../../test/helpers/gateway-client.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../test/helpers/openclaw-test-instance.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const PROVIDERS = ["route-proof-stable", "route-proof-dynamic"] as const;
const PLUGIN_ID = "route-model-proof";
const capacityModelId = (index: number) => `capacity-${index}`;
type Counts = Record<string, { resolve: number; prepare: number }>;

// This fixture records calls through the public provider and Gateway APIs. Its
// model output remains deterministic; observation never changes routing policy.
async function writeProviderProbe(pluginDir: string) {
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "package.json"),
    JSON.stringify({
      name: PLUGIN_ID,
      type: "commonjs",
      main: "index.js",
      openclaw: { extensions: ["./index.js"] },
      peerDependencies: { openclaw: ">=2026.1.1" },
    }),
  );
  await fs.writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: PLUGIN_ID,
      providers: PROVIDERS,
      activation: { onStartup: true },
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
  );
  await fs.writeFile(
    path.join(pluginDir, "index.js"),
    `
const counts = globalThis[Symbol.for("openclaw.test.routeModelCounts")] ??= {};
function resolve(ctx, phase) {
  const key = ctx.provider + "/" + ctx.modelId;
  const count = counts[key] ??= { resolve: 0, prepare: 0 };
  count[phase] += 1;
  const configured = ctx.providerConfig.models.find(model => model.id === ctx.modelId);
  return { ...configured, provider: ctx.provider, baseUrl: ctx.providerConfig.baseUrl,
    headers: { "x-proof-config-max-tokens": String(configured.maxTokens) } };
}
module.exports = {
  id: "${PLUGIN_ID}",
  register(api) {
    for (const provider of ${JSON.stringify(PROVIDERS)}) {
      api.registerProvider({ id: provider, label: provider, auth: [],
        preferRuntimeResolvedModel: () => true,
        resolveDynamicModel: ctx => resolve(ctx, "resolve"),
        ...(provider.endsWith("-dynamic") ? {
          prepareDynamicModel: async ctx => resolve(ctx, "prepare"),
        } : {}),
      });
    }
    api.registerGatewayMethod("routeModelProof.stats", ({ context, respond }) => {
      respond(true, { counts, reloadSettled: context.isConfigReloadSettled() });
    }, { scope: "operator.read" });
  },
};
`,
  );
}

describe("Gateway route model reuse", () => {
  it(
    "bounds stable resolution reuse and refreshes generation facts without suppressing dynamic preparation",
    { timeout: 180_000 },
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
        expect(
          JSON.parse(await fs.readFile(path.join(repoRoot, "dist", file), "utf8"))[field],
          file,
        ).toBe(head);
      }
      const requests: Array<{ model: string; maxTokens: string | undefined }> = [];
      let unexpectedCredential = false;
      const server = createServer((request, response) => {
        void (async () => {
          if (request.method !== "POST" || request.url !== "/v1/responses") {
            request.resume();
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ data: [] }));
            return;
          }
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model: string };
          unexpectedCredential ||= request.headers.authorization !== "Bearer qa-route-model-key";
          requests.push({
            model: parsed.model,
            maxTokens: request.headers["x-proof-config-max-tokens"] as string | undefined,
          });
          writeOpenAiResponsesText(response, {
            text: "ROUTE_MODEL_OK",
            messageId: `msg_${requests.length}`,
            responseId: `resp_${requests.length}`,
          });
        })().catch((error: unknown) => response.writeHead(500).end(String(error)));
      });
      let instance: OpenClawTestInstance | undefined;
      let client: Awaited<ReturnType<typeof acquireGatewayTestClient>> | undefined;
      await runQaGatewayFixture(
        async () => {
          await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
          });
          const address = server.address();
          if (!address || typeof address === "string") {
            throw new Error("Synthetic provider has no port");
          }
          instance = await createOpenClawTestInstance({
            name: "route-model-reuse",
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
          const pluginDir = path.join(gateway.state.stateDir, "proof-provider");
          await writeProviderProbe(pluginDir);
          const capacityModels = Array.from({ length: 65 }, (_, index) => capacityModelId(index));
          const modelIds = ["warmup", "stable", "dynamic", ...capacityModels];
          const definitions = modelIds.map((id) => ({
            id,
            name: id,
            api: "openai-responses" as const,
            reasoning: false,
            input: ["text" as const],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128_000,
            maxTokens: 1024,
          }));
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
                model: { primary: `${PROVIDERS[0]}/stable`, fallbacks: [] },
                models: Object.fromEntries(
                  PROVIDERS.flatMap((provider) =>
                    modelIds.map((id) => [
                      `${provider}/${id}`,
                      {
                        agentRuntime: { id: "openclaw" },
                        params: { transport: "sse", openaiWsWarmup: false },
                      },
                    ]),
                  ),
                ),
              },
              entries: { main: {} },
            },
            auth: {
              profiles: Object.fromEntries(
                PROVIDERS.map((provider) => [
                  `${provider}:proof`,
                  { provider, mode: "api_key" as const },
                ]),
              ),
            },
            models: {
              mode: "replace",
              providers: Object.fromEntries(
                PROVIDERS.map((provider) => [
                  provider,
                  {
                    baseUrl: `http://127.0.0.1:${address.port}/v1`,
                    api: "openai-responses" as const,
                    models: definitions,
                    request: { allowPrivateNetwork: true },
                  },
                ]),
              ),
            },
            plugins: {
              allow: [PLUGIN_ID],
              load: { paths: [pluginDir] },
              entries: { [PLUGIN_ID]: { enabled: true } },
              slots: { memory: "none" },
            },
            tools: { profile: "minimal" },
          } satisfies OpenClawConfig;
          await gateway.state.writeConfig(cfg);
          await gateway.state.writeAuthProfiles(
            {
              version: 1,
              profiles: Object.fromEntries(
                PROVIDERS.map((provider) => [
                  `${provider}:proof`,
                  { type: "api_key" as const, provider, key: "qa-route-model-key" },
                ]),
              ),
            },
            "main",
          );
          expect(await gateway.entrypoint()).toEqual(["dist/index.js"]);
          await gateway.startGateway();
          const gatewayPid = gateway.child?.pid;
          expect(gatewayPid).toBeTypeOf("number");
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
              timeoutMessage: "Route-model Gateway did not connect",
              closeMessage: "Route-model Gateway closed",
            },
          );
          const activeClient = client;
          const stats = () =>
            activeClient.request<{ counts: Counts; reloadSettled: boolean }>(
              "routeModelProof.stats",
              {},
            );
          const turn = async (provider: string, model: string) => {
            const key = `${provider}/${model}`;
            const before = (await stats()).counts[key] ?? { resolve: 0, prepare: 0 };
            const beforeRequests = requests.length;
            const started = performance.now();
            const sessionKey = `agent:main:route-model-${randomUUID()}`;
            const accepted = await activeClient.request<{ runId: string; status: string }>(
              "agent",
              {
                agentId: "main",
                sessionKey,
                provider,
                model,
                message: "Reply ROUTE_MODEL_OK.",
                deliver: false,
                idempotencyKey: randomUUID(),
              },
            );
            expect(accepted.status).toBe("accepted");
            const terminal = await activeClient.request<{ status: string }>(
              "agent.wait",
              { runId: accepted.runId, timeoutMs: 60_000 },
              { timeoutMs: 65_000 },
            );
            expect(terminal.status, gateway.logs()).toBe("ok");
            expect(requests.length).toBe(beforeRequests + 1);
            expect(requests.at(-1)?.model).toBe(model);
            expect(unexpectedCredential).toBe(false);
            const elapsedMs = performance.now() - started;
            const history = await activeClient.request<{ messages: unknown[] }>("chat.history", {
              sessionKey,
            });
            expect(history.messages).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  role: "assistant",
                  content: expect.arrayContaining([
                    expect.objectContaining({ type: "text", text: "ROUTE_MODEL_OK" }),
                  ]),
                }),
              ]),
            );
            const after = (await stats()).counts[key];
            assert(after, `Provider observations missing for ${key}`);
            return {
              resolve: after.resolve - before.resolve,
              prepare: after.prepare - before.prepare,
              elapsedMs,
            };
          };
          await turn(PROVIDERS[0], "warmup");
          const stable = [
            await turn(PROVIDERS[0], "stable"),
            await turn(PROVIDERS[0], "stable"),
          ] as const;
          await turn(PROVIDERS[1], "warmup");
          const dynamic = [
            await turn(PROVIDERS[1], "dynamic"),
            await turn(PROVIDERS[1], "dynamic"),
          ] as const;
          // Churn more than a memo-sized set through the Gateway and verify each output.
          // Owner tests isolate exact eviction from other model-discovery caches.
          const cold = [];
          for (const model of capacityModels.slice(0, 64)) {
            cold.push(await turn(PROVIDERS[0], model));
          }
          const oldestAt64 = await turn(PROVIDERS[0], capacityModelId(0));
          const newestAt64 = await turn(PROVIDERS[0], capacityModelId(63));
          await turn(PROVIDERS[0], capacityModelId(64));
          const oldestAfter65 = await turn(PROVIDERS[0], capacityModelId(0));
          const newestAfter65 = await turn(PROVIDERS[0], capacityModelId(64));
          expect(requests.at(-1)?.maxTokens).toBe("1024");
          const currentConfig = await activeClient.request<{ hash: string }>("config.get", {});
          expect(currentConfig.hash).toBeTypeOf("string");
          const updatedDefinitions = structuredClone(definitions);
          for (const model of updatedDefinitions) {
            model.maxTokens = 2048;
          }
          // config.patch acknowledges a hot write only after runtime application.
          await activeClient.request(
            "config.patch",
            {
              baseHash: currentConfig.hash,
              raw: JSON.stringify({
                models: {
                  providers: {
                    [PROVIDERS[0]]: {
                      models: updatedDefinitions,
                    },
                  },
                },
              }),
            },
            { timeoutMs: 60_000 },
          );
          await expect
            .poll(async () => (await stats()).reloadSettled, { timeout: 30_000 })
            .toBe(true);
          const afterReload = await turn(PROVIDERS[0], capacityModelId(64));
          expect(requests.at(-1)?.maxTokens).toBe("2048");
          expect(gateway.child?.pid).toBe(gatewayPid);
          const churn = {
            coldFirst: cold[0],
            coldLast: cold[63],
            oldestAt64,
            newestAt64,
            oldestAfter65,
            newestAfter65,
          };
          console.info(
            "[route-model-runtime-proof]",
            JSON.stringify({
              head,
              gatewayPid,
              stable,
              dynamic,
              churn,
              afterReload,
              requests: requests.length,
              responseTextVerified: true,
              generationHeader: "1024→2048",
              sameGatewayProcess: true,
            }),
          );
          expect(dynamic[0].prepare).toBeGreaterThan(0);
          expect(dynamic[1].prepare).toBe(dynamic[0].prepare);
          expect(stable[0].resolve).toBeGreaterThan(0);
          expect(stable[1].resolve).toBeLessThan(stable[0].resolve);
        },
        async () => {
          await client?.stopAndWait({ timeoutMs: 1_000 });
        },
        async () => {
          await instance?.cleanup();
        },
        async () => {
          server.closeAllConnections();
          await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          });
        },
      );
    },
  );
});
