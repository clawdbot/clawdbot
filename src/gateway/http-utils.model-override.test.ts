import fs from "node:fs/promises";
/**
 * Tests HTTP model override parsing from gateway request headers and URLs.
 */
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isCliProvider } from "../agents/model-selection-cli.js";
import type { OpenClawConfig } from "../config/config.js";
import { installPluginMetadataOwner } from "../plugins/current-plugin-metadata.test-support.js";
import { createPluginCache } from "../plugins/plugin-cache.js";
import { createPluginMetadataOwner } from "../plugins/plugin-metadata-collection.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import {
  createColdPluginFixture,
  isColdPluginRuntimeLoaded,
} from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";

const loadConfigMock = vi.fn();
const loadGatewayModelCatalogMock = vi.fn();

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => loadConfigMock(),
}));

vi.mock("../config/io.js", () => ({
  getRuntimeConfig: () => loadConfigMock(),
}));

vi.mock("./server-model-catalog.js", () => ({
  loadGatewayModelCatalog: () => loadGatewayModelCatalogMock(),
}));

import { resolveOpenAiCompatModelOverride } from "./http-utils.js";

function createReq(headers: Record<string, string> = {}): IncomingMessage {
  return { headers } as IncomingMessage;
}

describe("resolveOpenAiCompatModelOverride", () => {
  beforeEach(() => {
    loadConfigMock.mockReset();
    loadGatewayModelCatalogMock.mockReset();
  });

  it("rejects CLI model overrides outside the configured allowlist", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const rootDir = state.path("http-cli-provider");
      await fs.mkdir(rootDir, { recursive: true });
      const fixture = createColdPluginFixture({
        rootDir,
        pluginId: "http-cli-provider",
        providerId: "fixture-http-cli",
        manifest: {
          channels: [],
          channelConfigs: {},
          providerAuthChoices: [],
          cliBackends: ["claude-cli"],
        },
      });
      await fs.writeFile(
        fixture.runtimeSource,
        `require("node:fs").writeFileSync(${JSON.stringify(fixture.runtimeMarker)}, "loaded");
module.exports = {
  id: ${JSON.stringify(fixture.pluginId)},
  register(api) {
    api.registerProvider({ id: "fixture-http-cli", label: "Fixture CLI", hookAliases: ["claude-cli"], auth: [] });
    api.registerCliBackend({ id: "claude-cli", modelProvider: "fixture-http-cli", config: { command: "fixture-cli" } });
  }
};
`,
      );
      const cfg: OpenClawConfig = {
        plugins: {
          allow: [fixture.pluginId],
          load: { paths: [rootDir] },
          entries: { [fixture.pluginId]: { enabled: true } },
        },
        agents: {
          defaults: {
            workspace: state.workspaceDir,
            model: { primary: "openai/gpt-5.4" },
            models: { "openai/gpt-5.4": {} },
          },
        },
      };
      const pluginCache = createPluginCache();
      const owner = createPluginMetadataOwner(pluginCache);
      const dispose = installPluginMetadataOwner(owner, pluginCache);
      try {
        owner.publish(owner.prepare({ config: cfg }), { config: cfg });
        loadConfigMock.mockReturnValue(cfg);
        loadGatewayModelCatalogMock.mockResolvedValue([
          { id: "gpt-5.4", name: "GPT 5.4", provider: "openai" },
        ]);
        expect(isCliProvider("claude-cli", cfg)).toBe(true);

        await expect(
          resolveOpenAiCompatModelOverride({
            req: createReq({ "x-openclaw-model": "claude-cli/opus" }),
            agentId: "main",
            model: "openclaw",
          }),
        ).resolves.toEqual({
          errorMessage: "Model 'claude-cli/opus' is not allowed for agent 'main'.",
        });
        expect(isColdPluginRuntimeLoaded(fixture)).toBe(true);
      } finally {
        dispose();
        clearPluginMetadataLifecycleCaches();
      }
    });
  });

  it("keeps the requested workspace policy when metadata reloads during the catalog read", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const workspaces = { main: state.workspaceDir, work: state.path("work") };
      const fixtures = [];
      for (const [agentId, workspace] of Object.entries(workspaces)) {
        const rootDir = path.join(workspace, ".openclaw", "extensions", `${agentId}-model-policy`);
        await fs.mkdir(rootDir, { recursive: true });
        const fixture = createColdPluginFixture({
          rootDir,
          pluginId: `${agentId}-model-policy`,
          providerId: "fixture-http",
          manifest: {
            channels: [],
            channelConfigs: {},
            providerAuthChoices: [],
            modelIdNormalization: {
              providers: { "fixture-http": { aliases: { legacy: `${agentId}-current` } } },
            },
          },
        });
        await fs.writeFile(
          fixture.runtimeSource,
          `require("node:fs").writeFileSync(${JSON.stringify(fixture.runtimeMarker)}, "loaded");
module.exports = {
  id: ${JSON.stringify(fixture.pluginId)},
  register(api) {
    api.registerProvider({ id: "fixture-http", label: "Fixture HTTP", auth: [] });
  }
};
`,
        );
        fixtures.push(fixture);
      }
      const cfg: OpenClawConfig = {
        plugins: {
          allow: fixtures.map(({ pluginId }) => pluginId),
          entries: Object.fromEntries(
            fixtures.map(({ pluginId }) => [pluginId, { enabled: true }]),
          ),
        },
        agents: {
          ownership: "explicit",
          defaults: {
            systemAgent: { agentId: "main" },
            model: { primary: "fixture-http/default" },
            models: { "fixture-http/work-current": {} },
          },
          entries: Object.fromEntries(
            Object.entries(workspaces).map(([agentId, workspace]) => [
              agentId,
              { workspace, agentDir: state.agentDir(agentId) },
            ]),
          ),
        },
      };
      const pluginCache = createPluginCache();
      const owner = createPluginMetadataOwner(pluginCache);
      const dispose = installPluginMetadataOwner(owner, pluginCache);
      try {
        owner.publish(owner.prepare({ config: cfg }), { config: cfg });
        loadConfigMock.mockReturnValue(cfg);
        loadGatewayModelCatalogMock.mockImplementationOnce(async () => {
          const replacement = { ...cfg, plugins: { enabled: false } };
          owner.publish(owner.prepare({ config: replacement }), { config: replacement });
          return [{ id: "work-current", name: "Work model", provider: "fixture-http" }];
        });

        await expect(
          resolveOpenAiCompatModelOverride({
            req: createReq({ "x-openclaw-model": "fixture-http/legacy" }),
            agentId: "work",
            model: "openclaw",
          }),
        ).resolves.toEqual({ modelOverride: "fixture-http/legacy" });
        expect(fixtures.filter(isColdPluginRuntimeLoaded).map(({ pluginId }) => pluginId)).toEqual([
          "work-model-policy",
        ]);
      } finally {
        dispose();
        clearPluginMetadataLifecycleCaches();
      }
    });
  });
});
