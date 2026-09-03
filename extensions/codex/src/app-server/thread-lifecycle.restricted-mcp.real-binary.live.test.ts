import fs from "node:fs/promises";
import path from "node:path";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCodexAppServerRuntimeOptions } from "./config.js";
import { createIsolatedCodexAppServerClient } from "./shared-client.js";
import {
  createAppServerOptions,
  createParams,
  resetThreadLifecycleTestFixtures,
  startOrResumeThread,
} from "./thread-lifecycle.test-fixtures.js";

const LIVE =
  process.env.OPENCLAW_LIVE_TEST === "1" && process.env.OPENCLAW_LIVE_CODEX_RESTRICTED_MCP === "1";
const describeLive = LIVE ? describe : describe.skip;

afterEach(() => {
  resetThreadLifecycleTestFixtures();
});

describeLive("Codex restricted MCP real-binary lifecycle", () => {
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
        const signal = AbortSignal.timeout(60_000);
        const params = createParams(path.join(root, "session.jsonl"), workspace);
        params.toolsAllow = ["openclaw"];
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
          appServer: { ...createAppServerOptions(), start: runtime.start },
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
