import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadManifestMetadataSnapshot } from "../../plugins/manifest-contract-eligibility.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import {
  listModels,
  providerCatalogEntry,
} from "./models-list-result.openai-routes.test-support.js";

const config = {
  agents: {
    defaults: { model: { primary: "anthropic/claude-opus-5" } },
    list: [
      {
        id: "main",
        default: true,
        models: {
          "anthropic/claude-opus-5": { agentRuntime: { id: "claude-cli" } },
        },
      },
    ],
  },
} satisfies OpenClawConfig;

async function listClaudeCliModel(
  params: {
    cfg?: OpenClawConfig;
    metadataSnapshot?: PluginMetadataSnapshot;
  } = {},
) {
  return await listModels({
    catalog: [],
    staticEntries: [providerCatalogEntry("anthropic", "claude-opus-5")],
    cfg: params.cfg ?? config,
    ...(params.metadataSnapshot ? { metadataSnapshot: params.metadataSnapshot } : {}),
    view: "configured",
  });
}

describe("models.list CLI runtime availability", () => {
  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("marks a Claude CLI runtime model available through bundled synthetic auth", async () => {
    await expect(listClaudeCliModel()).resolves.toEqual({
      models: [expect.objectContaining({ id: "claude-opus-5", available: true })],
    });
  });

  it("does not use synthetic auth from an explicitly disabled Anthropic plugin", async () => {
    await expect(
      listClaudeCliModel({
        cfg: {
          ...config,
          plugins: { entries: { anthropic: { enabled: false } } },
        },
      }),
    ).resolves.toEqual({
      models: [expect.objectContaining({ id: "claude-opus-5", available: false })],
    });
  });

  it("does not use synthetic auth when plugins are globally disabled", async () => {
    await expect(
      listClaudeCliModel({
        cfg: {
          ...config,
          plugins: { enabled: false },
        },
      }),
    ).resolves.toEqual({
      models: [expect.objectContaining({ id: "claude-opus-5", available: false })],
    });
  });

  it("does not choose between multiple active runtime owners", async () => {
    const metadataSnapshot = loadManifestMetadataSnapshot({ config, env: process.env });
    const anthropic = metadataSnapshot.plugins.find((plugin) => plugin.id === "anthropic");
    if (!anthropic) {
      throw new Error("Anthropic manifest missing from model availability fixture");
    }
    const duplicate = { ...anthropic, id: "anthropic-duplicate" };
    const providerOwners = new Map(metadataSnapshot.owners.providers);
    providerOwners.set("anthropic", [...(providerOwners.get("anthropic") ?? []), duplicate.id]);
    const cliBackendOwners = new Map(metadataSnapshot.owners.cliBackends);
    cliBackendOwners.set("claude-cli", [
      ...(cliBackendOwners.get("claude-cli") ?? []),
      duplicate.id,
    ]);

    await expect(
      listClaudeCliModel({
        metadataSnapshot: {
          ...metadataSnapshot,
          plugins: [...metadataSnapshot.plugins, duplicate],
          byPluginId: new Map([...metadataSnapshot.byPluginId, [duplicate.id, duplicate]]),
          owners: {
            ...metadataSnapshot.owners,
            providers: providerOwners,
            cliBackends: cliBackendOwners,
          },
        },
      }),
    ).resolves.toEqual({
      models: [expect.objectContaining({ id: "claude-opus-5", available: false })],
    });
  });
});
