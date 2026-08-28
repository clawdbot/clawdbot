import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CodeModeHeadlessResult } from "../agents/code-mode.js";
import { resolveOpenClawPluginToolsForOptions } from "../agents/openclaw-plugin-tools.js";
import {
  createPreparedInboundRegistryLoader,
  loadPreparedInboundPluginRegistry,
} from "../agents/prepared-model-runtime.inbound-registry.js";
import { prepareOwnedPluginLoadContext } from "../agents/prepared-model-runtime.plugin-context.js";
import { resolveToolSearchConfig, ToolSearchRuntime } from "../agents/tool-search.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import {
  cleanupPluginLoaderFixturesForTest,
  clearPluginLoaderCache,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeRegistryScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { getPluginRuntimeLoadContext } from "../plugins/runtime/load-context.js";
import { resetPluginToolDescriptorCacheForTest } from "../plugins/tools.test-fixtures.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createCronScriptRuntime } from "./trigger-script.js";

type HeadlessParams = Parameters<
  NonNullable<Parameters<typeof createCronScriptRuntime>[0]["runHeadless"]>
>[0];

let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
let config: OpenClawConfig;
let registrations: string;

beforeEach(async () => {
  state = await createOpenClawTestState({
    prefix: "openclaw-cron-preparation-",
    env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
  });
  registrations = state.path("registrations.jsonl");
  const dir = state.path("plugin");
  for (const artifact of ["source", "built"]) {
    const body = `module.exports = {
      id: "cold-probe",
      register(api) {
        require("node:fs").appendFileSync(${JSON.stringify(registrations)}, JSON.stringify({ artifact: ${JSON.stringify(artifact)}, mode: api.registrationMode }) + "\\n");
        if (api.registrationMode !== "tool-discovery") return;
        api.registerTool((ctx) => {
          let calls = 0;
          return {
            name: "cold_probe", label: "Cold probe", description: "Fixture preparation probe",
            parameters: { type: "object", properties: {} },
            async execute() {
              return { content: [], details: { artifact: ${JSON.stringify(artifact)}, calls: ++calls, agentId: ctx.agentId, sessionKey: ctx.sessionKey } };
            }
          };
        }, { names: ["cold_probe"] });
      }
    };`;
    writePlugin({
      id: "cold-probe",
      dir: artifact === "source" ? dir : path.join(dir, "dist"),
      filename: artifact === "source" ? "index.ts" : "index.js",
      body,
    });
  }
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "cold-probe", openclaw: { extensions: ["./index.ts"] } }),
  );
  fs.writeFileSync(
    path.join(dir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "cold-probe",
      configSchema: { type: "object", properties: {} },
      contracts: { tools: ["cold_probe"] },
    }),
  );
  config = {
    agents: {
      defaults: { workspace: state.workspaceDir, skipBootstrap: true },
      entries: {
        main: { workspace: state.workspaceDir },
        other: { workspace: state.path("other-workspace") },
      },
    },
    plugins: {
      allow: ["cold-probe"],
      // Explicit source entry keeps artifact selection at the runtime owner boundary.
      load: { paths: [path.join(dir, "index.ts")] },
      slots: { memory: "none" },
      entries: { "cold-probe": { enabled: true } },
    },
  };
});

afterEach(async () => {
  clearRuntimeConfigSnapshot();
  clearPluginLoaderCache();
  resetPluginToolDescriptorCacheForTest();
  clearPluginMetadataLifecycleCaches();
  await state?.cleanup();
});

afterAll(cleanupPluginLoaderFixturesForTest);

function readRegistrations() {
  return fs
    .readFileSync(registrations, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { artifact: string; mode: string });
}

async function executeProbe({ ctx }: HeadlessParams): Promise<CodeModeHeadlessResult> {
  const tool = ctx.catalogRef?.current?.entries.find(
    (entry) => entry.tool.name === "cold_probe",
  )?.tool;
  const runtime = new ToolSearchRuntime(ctx, resolveToolSearchConfig(ctx.runtimeConfig), {
    prepareInput: true,
    validateInput: true,
  });
  const result = tool ? await runtime.callValue("cold_probe", {}) : null;
  return {
    status: "completed",
    value: { state: result },
    output: [],
    toolCallCount: tool ? 1 : 0,
  };
}

describe("cron preparation plugin ownership", () => {
  it.each(["gateway", "standalone"] as const)(
    "preserves %s artifact selection through both real preparation loads",
    async (owner) => {
      const metadataSnapshot = loadPluginMetadataSnapshot({
        config,
        workspaceDir: state.workspaceDir,
      });
      setCurrentPluginMetadataSnapshot(metadataSnapshot, { config });
      const contexts: Array<ReturnType<typeof getPluginRuntimeLoadContext>> = [];
      const deps = {
        config,
        ...(owner === "gateway" ? { loadPluginRegistry: loadPreparedInboundPluginRegistry } : {}),
        runHeadless: async (params: HeadlessParams) => {
          contexts.push(
            getPluginRuntimeLoadContext(getPluginRuntimeGatewayRequestScope()?.pluginRegistry),
          );
          return executeProbe(params);
        },
      };
      const runtime = createCronScriptRuntime(deps);
      const artifact = owner === "gateway" ? "built" : "source";
      const run = (jobId: string, agentId = "main", toolsAllow = ["*"]) =>
        runtime.executePayload({
          jobId,
          agentId,
          toolsAllow,
          script: "return {}",
          state: null,
          timeoutSeconds: 5,
        });
      for (const [jobId, agentId, calls] of [
        ["first", "main", 1],
        ["first", "main", 2],
        ["second", "main", 1],
        ["first", "other", 1],
      ] as const) {
        await expect(run(jobId, agentId)).resolves.toMatchObject({
          kind: "completed",
          state: { artifact, calls, agentId, sessionKey: `agent:${agentId}:cron:${jobId}:trigger` },
        });
      }
      expect(readRegistrations()).toEqual(
        expect.arrayContaining([
          { artifact, mode: "discovery" },
          { artifact, mode: "tool-discovery" },
        ]),
      );
      expect(readRegistrations().every((entry) => entry.artifact === artifact)).toBe(true);
      if (owner === "gateway") {
        expect(contexts[0]?.metadataSnapshot).toBe(metadataSnapshot);
        expect(contexts[1]).toBe(contexts[0]);
      }
      await expect(run("first", "other", [])).resolves.toMatchObject({
        kind: "completed",
        state: null,
      });
      await expect(run("first", "other", ["cold_probe"])).resolves.toMatchObject({
        kind: "completed",
        state: { calls: 1 },
      });
      const nextConfig = structuredClone(config);
      nextConfig.tools = { deny: ["cold_probe"] };
      setRuntimeConfigSnapshot(nextConfig, config);
      await expect(run("first", "other", ["cold_probe"])).resolves.toMatchObject({
        kind: "completed",
        state: null,
      });
    },
  );

  it.each(["scoped", "global"] as const)(
    "uses only %s registry ownership during downstream loading without a model runtime",
    async (owner) => {
      const input = { config, workspaceDir: state.workspaceDir, agentDir: state.agentDir() };
      const metadataSnapshot = loadPluginMetadataSnapshot(input);
      const registry = createPreparedInboundRegistryLoader()(input, metadataSnapshot);
      prepareOwnedPluginLoadContext(input, process.env, registry, metadataSnapshot, true);
      if (owner === "global") {
        setActivePluginRegistry(registry);
      }
      const tools = withPluginRuntimeRegistryScope(owner === "scoped" ? registry : undefined, () =>
        resolveOpenClawPluginToolsForOptions({
          options: {
            config,
            workspaceDir: state.workspaceDir,
            agentSessionKey: "agent:main:cron:scoped:trigger",
            pluginToolAllowlist: ["cold_probe"],
          },
          resolvedConfig: config,
        }),
      );
      expect(tools.map((tool) => tool.name)).toEqual(["cold_probe"]);
      await expect(tools[0]!.execute("scoped-call", {})).resolves.toMatchObject({
        details: {
          artifact: owner === "scoped" ? "built" : "source",
          agentId: "main",
          sessionKey: "agent:main:cron:scoped:trigger",
        },
      });
      expect(readRegistrations()).toEqual([
        { artifact: "built", mode: "discovery" },
        { artifact: owner === "scoped" ? "built" : "source", mode: "tool-discovery" },
      ]);
    },
  );
});
