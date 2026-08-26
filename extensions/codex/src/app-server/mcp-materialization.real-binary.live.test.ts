import fs from "node:fs/promises";
import path from "node:path";
import { materializeStaticMcpToolsForScheduledHarnessRun } from "openclaw/plugin-sdk/codex-mcp-projection";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCodexAppServerRuntimeOptions } from "./config.js";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import {
  flattenCodexDynamicToolFunctions,
  type CodexDynamicToolFunctionSpec,
  type CodexModelListResponse,
} from "./protocol.js";
import { createIsolatedCodexAppServerClient } from "./shared-client.js";

const LIVE =
  process.env.OPENCLAW_LIVE_TEST === "1" &&
  process.env.OPENCLAW_LIVE_CODEX_MCP_MATERIALIZATION === "1";
const describeLive = LIVE ? describe : describe.skip;

afterEach(() => {
  vi.unstubAllEnvs();
});

describeLive("Codex MCP materialization real-binary bridge", () => {
  it("keeps the generic MCP name while a real Codex app-server accepts its provider alias", async () => {
    await withTempDir("openclaw-codex-mcp-materialization-", async (root) => {
      const workspace = path.join(root, "workspace");
      const agentDir = path.join(root, "agent");
      await fs.mkdir(workspace, { recursive: true });
      vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));

      const materialized = await materializeStaticMcpToolsForScheduledHarnessRun({
        sessionId: "codex-mcp-materialization-live",
        provider: "openai",
        model: "codex-live-control",
        workspaceDir: workspace,
        agentDir,
        cfg: {
          mcp: {
            servers: {
              mcp: {
                transport: "stdio",
                command: process.execPath,
                args: [path.resolve("scripts/e2e/mcp-app-conformance-server.mjs")],
                codex: { defaultToolsApprovalMode: "approve" },
              },
            },
          },
        },
        toolsAllow: ["mcp__show"],
        autoApproveCodexAppServerApprovals: true,
        retireSessionRuntimeAfterDispose: true,
      });
      try {
        expect(materialized.mcpToolMaterialization).toEqual({
          provider: "openai",
          model: "codex-live-control",
          materializedToolCount: 3,
          toolsAllowMatchedToolCount: 1,
        });
        expect(materialized.tools.map((tool) => tool.name)).toEqual(["mcp__show"]);

        // Non-Codex control: execute the unprojected generic tool against the
        // same live MCP transport before applying any provider-specific name.
        const genericResult = await materialized.tools[0]!.execute("generic-control", {});
        expect(JSON.stringify(genericResult)).toContain("initial-result");

        const materializedTool = materialized.tools[0];
        if (!materializedTool) {
          throw new Error("expected the real stdio transport to materialize mcp__show");
        }
        const projectedTools = ["mcp", "mcp_", "mcp__show"].map((name) =>
          Object.assign({}, materializedTool, { name }),
        );

        const bridge = createCodexDynamicToolBridge({
          tools: projectedTools,
          registeredTools: projectedTools,
          signal: new AbortController().signal,
          loading: "direct",
        });
        expect(bridge.availableTools.map((tool) => tool.name)).toEqual([
          "mcp",
          "mcp_",
          "mcp__show",
        ]);
        const projectedSpecs = flattenCodexDynamicToolFunctions(bridge.availableSpecs);
        expect(projectedSpecs.map((tool) => tool.name)).toEqual([
          "openclaw_mcp",
          "mcp_",
          "openclaw_mcp__show",
        ]);

        const runtime = resolveCodexAppServerRuntimeOptions({
          pluginConfig: { appServer: { homeScope: "user" } },
          env: {},
        });
        const client = await createIsolatedCodexAppServerClient({
          startOptions: {
            ...runtime.start,
            env: { CODEX_HOME: path.join(root, "codex-home") },
            clearEnv: ["CODEX_API_KEY", "OPENAI_API_KEY"],
          },
          agentDir,
          authProfileId: null,
          timeoutMs: 60_000,
        });
        try {
          const listed = await client.request<CodexModelListResponse>(
            "model/list",
            { limit: 100, cursor: null, includeHidden: false },
            { timeoutMs: 60_000 },
          );
          const modelId =
            listed.data.find((model) => model.isDefault)?.model ?? listed.data[0]?.model;
          if (!modelId) {
            throw new Error("Codex model/list returned no models");
          }
          const started = await client.request(
            "thread/start",
            {
              cwd: workspace,
              model: modelId,
              approvalPolicy: "never",
              sandbox: "danger-full-access",
              dynamicTools: projectedSpecs,
              ephemeral: true,
            },
            { timeoutMs: 60_000 },
          );
          expect(started.thread.id).toEqual(expect.any(String));

          const mcpUnderscoreSpec = projectedSpecs.find((spec) => spec.name === "mcp_");
          if (!mcpUnderscoreSpec) {
            throw new Error("expected Codex projection to preserve mcp_ unchanged");
          }
          const reservedSpec = (name: "mcp" | "mcp__show"): CodexDynamicToolFunctionSpec => ({
            ...mcpUnderscoreSpec,
            name,
          });
          for (const reservedName of ["mcp", "mcp__show"] as const) {
            await expect(
              client.request(
                "thread/start",
                {
                  cwd: workspace,
                  model: modelId,
                  approvalPolicy: "never",
                  sandbox: "danger-full-access",
                  dynamicTools: [reservedSpec(reservedName)],
                  ephemeral: true,
                },
                { timeoutMs: 60_000 },
              ),
            ).rejects.toThrow(`dynamic tool name is reserved: ${reservedName}`);
          }
        } finally {
          await client.closeAndWait();
        }
      } finally {
        await materialized.dispose();
      }
    });
  }, 120_000);
});
