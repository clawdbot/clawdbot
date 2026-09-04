import { describe, expect, it } from "vitest";
import { finalizeAgentTools } from "../../src/agents/agent-tools.finalize.js";
import { applyToolPolicyPipeline } from "../../src/agents/tool-policy-pipeline.js";
import {
  applyToolSearchCatalog,
  clearToolSearchCatalog,
  createToolSearchCatalogRef,
  createToolSearchTools,
} from "../../src/agents/tool-search.js";
import type { AnyAgentTool } from "../../src/agents/tools/common.js";
import { createTestPluginApi } from "../../src/plugin-sdk/plugin-test-api.js";
import { getPluginToolMeta, setPluginToolMeta } from "../../src/plugins/tool-metadata.js";
import type { OpenClawPluginApi } from "../../src/plugins/types.js";
import { loadBundledPluginFacade } from "../../src/test-utils/bundled-plugin-public-surface.js";

describe("public plugin registrations in Tool Search", () => {
  it.each(["feishu", "file-transfer"])(
    "preserves selected %s metadata and rejects excluded companions",
    async (pluginId) => {
      const registered: AnyAgentTool[] = [];
      const config = {
        channels: {
          feishu: {
            enabled: true,
            appId: "cli_test",
            appSecret: "unused",
          },
        },
        tools: { toolSearch: { enabled: true, mode: "tools" as const } },
      };
      const api = createTestPluginApi({
        id: pluginId,
        config,
        registerTool(tool, options) {
          const resolved = typeof tool === "function" ? tool({ config }) : tool;
          for (const entry of resolved ? (Array.isArray(resolved) ? resolved : [resolved]) : []) {
            setPluginToolMeta(entry, { pluginId, optional: options?.optional === true });
            registered.push(entry);
          }
        },
      });
      if (pluginId === "feishu") {
        const surface = await loadBundledPluginFacade<{
          registerFeishuBitableTools(api: OpenClawPluginApi): void;
        }>({ pluginId, artifactBasename: "api.js" });
        surface.registerFeishuBitableTools(api);
      } else {
        const surface = await loadBundledPluginFacade<{
          default: { register(api: OpenClawPluginApi): void };
        }>({ pluginId, artifactBasename: "index.js" });
        surface.default.register(api);
      }
      expect(registered.length).toBeGreaterThan(1);

      // Plugin suites own exact wording. This core contract protects its passage
      // through real policy, normalization, and the final model-visible catalog.
      for (const selected of registered) {
        const authorized = applyToolPolicyPipeline({
          tools: registered,
          toolMeta: getPluginToolMeta,
          steps: [
            {
              policy: { allow: [selected.name] },
              label: "tools.allow",
              stripPluginOnlyAllowlist: true,
            },
          ],
          warn: () => {},
        });
        expect(authorized.map((tool) => tool.name)).toEqual([selected.name]);
        const tools = finalizeAgentTools({
          tools: authorized,
          hookContext: {},
          wrapBeforeToolCallHook: false,
        });
        const normalized = tools[0];
        if (!normalized) {
          throw new Error(`Selected tool disappeared: ${selected.name}`);
        }
        const catalogRef = createToolSearchCatalogRef();
        try {
          const controls = createToolSearchTools({ config, catalogRef });
          const surface = applyToolSearchCatalog({
            tools: [...controls, ...tools],
            config,
            catalogRef,
          });
          const describeTool = surface.tools.find((tool) => tool.name === "tool_describe");
          if (!describeTool) {
            throw new Error("Missing tool_describe control");
          }
          const result = await describeTool.execute("describe-selected", { id: selected.name });
          const metadata = {
            name: normalized.name,
            description: normalized.description,
            parameters: normalized.parameters,
          };
          expect(result.details).toMatchObject(metadata);
          const content = result.content
            .flatMap((block) => (block.type === "text" ? [block.text] : []))
            .join("\n");
          expect(JSON.parse(content)).toMatchObject(metadata);
          for (const companion of registered.filter((tool) => tool !== selected)) {
            await expect(
              describeTool.execute("describe-excluded", { id: companion.name }),
            ).rejects.toThrow(`Unknown tool id: ${companion.name}`);
          }
        } finally {
          clearToolSearchCatalog({ catalogRef });
        }
      }
    },
  );
});
