import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveCodexAppServerRuntimeOptions } from "./config.js";
import { setManagedCodexPluginRoot } from "./managed-binary.js";
import { createIsolatedCodexAppServerClient } from "./shared-client.js";
import {
  createParams,
  resetThreadLifecycleTestFixtures,
  startOrResumeThread,
} from "./thread-lifecycle.test-fixtures.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

const LIVE =
  process.env.OPENCLAW_LIVE_TEST === "1" && process.env.OPENCLAW_LIVE_CODEX_RESTRICTED_MCP === "1";
const describeLive = LIVE ? describe : describe.skip;

describeLive("Codex restricted MCP real-binary lifecycle", () => {
  beforeEach(() => {
    setManagedCodexPluginRoot(fileURLToPath(new URL("../../", import.meta.url)));
  });

  afterEach(() => {
    resetThreadLifecycleTestFixtures();
    setManagedCodexPluginRoot(undefined);
  });

  it("starts with inherited MCP disabled and exposes no tools", async () => {
    await withTempDir("openclaw-codex-restricted-mcp-", async (root) => {
      const agentDir = path.join(root, "agent");
      const workspace = path.join(root, "workspace");
      const launchMarker = path.join(root, "mcp-launched");
      await fs.mkdir(workspace, { recursive: true });
      const launchScript = `require("node:fs").writeFileSync(${JSON.stringify(launchMarker)}, "launched")`;

      const runtime = resolveCodexAppServerRuntimeOptions({ env: {} });
      const client = await createIsolatedCodexAppServerClient({
        startOptions: runtime.start,
        agentDir,
        authProfileId: null,
        timeoutMs: 60_000,
      });
      const request = vi.spyOn(client, "request");
      try {
        expect(client.getServerVersion()).toBe(CODEX_APP_SERVER_VERSION);
        const signal = AbortSignal.timeout(60_000);
        const params = createParams(path.join(root, "session.jsonl"), workspace);
        params.toolsAllow = ["openclaw"];
        params.provider = "openai";
        params.modelId = "gpt-5.6-luna";
        params.model = {
          ...params.model,
          id: params.modelId,
          name: params.modelId,
          provider: params.provider,
        };
        const binding = await startOrResumeThread({
          client,
          params,
          signal,
          cwd: workspace,
          dynamicTools: [],
          config: {
            mcp_servers: {
              inherited: {
                command: process.execPath,
                args: ["-e", launchScript],
                cwd: workspace,
                env: { RESTRICTED_MCP_TEST: "1" },
              },
            },
          },
          appServer: runtime,
          nativeCodeModeEnabled: false,
          userMcpServersEnabled: false,
          hostSystemAgentActive: true,
        });
        expect(request.mock.calls.find(([method]) => method === "thread/start")?.[1]).toMatchObject(
          {
            environments: [],
            dynamicTools: [],
            config: {
              mcp_servers: {
                inherited: {
                  command: process.execPath,
                  args: ["-e", launchScript],
                  cwd: workspace,
                  env: { RESTRICTED_MCP_TEST: "1" },
                  enabled: false,
                },
              },
            },
          },
        );
        const status = await client.request(
          "mcpServerStatus/list",
          { threadId: binding.threadId, detail: "toolsAndAuthOnly" },
          { timeoutMs: 60_000 },
        );

        expect(status.data).toEqual([
          expect.objectContaining({ name: "inherited", serverInfo: null, tools: {} }),
        ]);
        await expect(fs.stat(launchMarker)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await client.closeAndWait();
      }
    });
  }, 120_000);
});
