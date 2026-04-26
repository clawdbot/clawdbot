import { describe, expect, it } from "vitest";
import {
  prepareBundleProbeCliConfig,
  setupCliBundleMcpTestHarness,
} from "./bundle-mcp.test-support.js";

setupCliBundleMcpTestHarness();

describe("prepareCliBundleMcpConfig resume hash", () => {
  it("stabilizes the resume hash when only the OpenClaw loopback port changes", async () => {
    const first = await prepareBundleProbeCliConfig({
      additionalConfig: {
        mcpServers: {
          openclaw: {
            type: "http",
            url: "http://127.0.0.1:23119/mcp",
            headers: {
              Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}",
            },
          },
        },
      },
    });
    const second = await prepareBundleProbeCliConfig({
      additionalConfig: {
        mcpServers: {
          openclaw: {
            type: "http",
            url: "http://127.0.0.1:24567/mcp",
            headers: {
              Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}",
            },
          },
        },
      },
    });

    expect(first.mcpConfigHash).not.toBe(second.mcpConfigHash);
    expect(first.mcpResumeHash).toBe(second.mcpResumeHash);

    await first.cleanup?.();
    await second.cleanup?.();
  });

  it("changes the resume hash when stable MCP semantics change", async () => {
    const first = await prepareBundleProbeCliConfig({
      additionalConfig: {
        mcpServers: {
          openclaw: {
            type: "http",
            url: "http://127.0.0.1:23119/mcp",
            headers: {
              Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}",
            },
          },
        },
      },
    });
    const second = await prepareBundleProbeCliConfig({
      additionalConfig: {
        mcpServers: {
          openclaw: {
            type: "http",
            url: "http://127.0.0.1:23119/other",
            headers: {
              Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}",
            },
          },
        },
      },
    });

    expect(first.mcpResumeHash).not.toBe(second.mcpResumeHash);

    await first.cleanup?.();
    await second.cleanup?.();
  });
});
