import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { listRegisteredAgentHarnesses } from "./harness/registry.js";
import {
  createPreparedModelCatalogWorker,
  createPreparedModelCatalogWorkerInput,
} from "./prepared-model-catalog-worker.js";
import { getPreparedModelFullCatalogAuth } from "./prepared-model-runtime-auth.js";
import { prepareWorkspaceBuildGroup } from "./prepared-model-runtime.facts.js";
import { usePreparedCatalogWorkerFixtures } from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const { makeTempDir } = usePreparedCatalogWorkerFixtures();

function writeCodexManifestFixture(root: string): string {
  const pluginDir = path.join(root, "codex-plugin");
  const binDir = path.join(root, "bin");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  const codexCommand = path.join(binDir, "codex");
  fs.writeFileSync(codexCommand, "#!/bin/sh\nprintf 'Logged in using ChatGPT\\n'\n", "utf8");
  fs.chmodSync(codexCommand, 0o755);
  const entry = path.join(pluginDir, "index.cjs");
  fs.writeFileSync(entry, 'module.exports = { id: "codex", register() {} };\n', "utf8");
  fs.writeFileSync(
    path.join(pluginDir, "provider-discovery.cjs"),
    `const { spawnSync } = require("node:child_process");
module.exports = {
  id: "codex",
  aliases: ["openai"],
  label: "Codex",
  auth: [],
  resolveSyntheticAuth({ provider }) {
    if (provider !== "codex" && provider !== "openai") return undefined;
    const result = spawnSync("codex", ["login", "status"], { encoding: "utf8" });
    const output = [result.stdout, result.stderr].filter(Boolean).join("\\n");
    return result.status === 0 && output.includes("Logged in using ")
      ? { apiKey: "codex-app-server", source: "Codex CLI native auth", mode: "oauth", runtime: "codex" }
      : undefined;
  },
};
`,
    "utf8",
  );
  const manifest = JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), "extensions/codex/openclaw.plugin.json"), "utf8"),
  ) as Record<string, unknown>;
  manifest.providerCatalogEntry = "./provider-discovery.cjs";
  manifest.providers = ["openai"];
  manifest.syntheticAuthRefs = ["codex", "openai"];
  manifest.modelCatalog = {
    providers: {
      openai: {
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        models: [{ id: "gpt-5.6-sol", name: "GPT-5.6 Sol", reasoning: true }],
      },
    },
  };
  fs.writeFileSync(path.join(pluginDir, "openclaw.plugin.json"), JSON.stringify(manifest), "utf8");
  return entry;
}

describe("prepared Codex native catalog worker", () => {
  it("carries manifest native auth through the prepared inventory and worker", async () => {
    const root = makeTempDir("openclaw-codex-native-worker-");
    const stateDir = path.join(root, "state");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const workspaceDir = path.join(root, "workspace");
    const pluginEntry = writeCodexManifestFixture(root);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    const env = {
      ...process.env,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: stateDir,
      PATH: `${path.join(root, "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
    };
    vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("PATH", env.PATH);
    const config = {
      agents: { defaults: { model: { primary: "anthropic/claude-opus-5" } } },
      plugins: {
        allow: ["codex"],
        load: { paths: [pluginEntry] },
        entries: { codex: { enabled: true } },
      },
    } satisfies OpenClawConfig;
    const input = {
      agentId: "main",
      agentDir,
      inheritedAuthDir: agentDir,
      workspaceDir,
      config,
      env,
      loadRuntimePlugins: true,
    };
    const metadataSnapshot = loadPluginMetadataSnapshot({ config, env, workspaceDir });
    expect(metadataSnapshot.plugins.find((plugin) => plugin.id === "codex")).toMatchObject({
      providers: ["openai"],
      syntheticAuthRefs: ["codex", "openai"],
    });

    const prepared = await prepareWorkspaceBuildGroup(
      [input],
      "static",
      { preferBuiltPluginArtifacts: false },
      undefined,
      undefined,
      metadataSnapshot,
    );
    const agentFacts = prepared.agentFacts[0];
    if (!agentFacts) {
      throw new Error("expected Codex prepared agent facts");
    }
    expect(prepared.pluginGeneration.pluginMetadataSnapshot.plugins).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "codex", providers: ["openai"] })]),
    );
    expect(prepared.pluginGeneration.preparedStaticProviderCatalog?.providers).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "codex", aliases: ["openai"] })]),
    );
    expect(listRegisteredAgentHarnesses().some(({ harness }) => harness.id === "codex")).toBe(
      false,
    );
    expect(agentFacts.providerIds).toContain("openai");
    expect(agentFacts.credentials.openai).toEqual({ type: "api_key", key: "codex-app-server" });

    const worker = createPreparedModelCatalogWorker({
      input: createPreparedModelCatalogWorkerInput({
        agentFacts,
        pluginMetadataSnapshot: prepared.pluginGeneration.pluginMetadataSnapshot,
      }),
      isCurrent: () => true,
    });
    try {
      const catalog = await worker.loadCatalog();
      expect(getPreparedModelFullCatalogAuth(catalog)?.providerAuth).toMatchObject({
        openai: "api_key",
      });
      const model = catalog.entries.find(
        (entry) => entry.provider === "openai" && entry.id === "gpt-5.6-sol",
      );
      expect(model).toBeDefined();
      if (!model) {
        throw new Error("expected OpenAI model in worker catalog");
      }
      expect(model).toMatchObject({
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
      });
    } finally {
      vi.unstubAllEnvs();
      await worker.close();
    }
  });
});
