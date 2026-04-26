import { afterEach, describe, expect, it } from "vitest";
import {
  createBundleMcpTempHarness,
  createBundleProbePlugin,
  withBundleHomeEnv,
} from "../plugins/bundle-mcp.test-support.js";
import { loadMergedBundleMcpConfig, toCliBundleMcpServerConfig } from "./bundle-mcp-config.js";

const tempHarness = createBundleMcpTempHarness();

afterEach(async () => {
  await tempHarness.cleanup();
});

describe("loadMergedBundleMcpConfig", () => {
  it("lets OpenClaw mcp.servers override bundle defaults while preserving raw transport shape", async () => {
    await withBundleHomeEnv(
      tempHarness,
      "openclaw-bundle-mcp-config",
      async ({ homeDir, workspaceDir }) => {
        await createBundleProbePlugin(homeDir);

        const merged = loadMergedBundleMcpConfig({
          workspaceDir,
          cfg: {
            plugins: {
              entries: {
                "bundle-probe": { enabled: true },
              },
            },
            mcp: {
              servers: {
                bundleProbe: {
                  transport: "streamable-http",
                  url: "https://mcp.example.com/mcp",
                },
              },
            },
          },
        });

        expect(merged.config.mcpServers.bundleProbe).toEqual({
          transport: "streamable-http",
          url: "https://mcp.example.com/mcp",
        });
      },
    );
  });

  it("maps OpenClaw transports to downstream CLI types when requested", () => {
    expect(
      toCliBundleMcpServerConfig({
        transport: "streamable-http",
        url: "https://mcp.example.com/mcp",
      }),
    ).toEqual({
      type: "http",
      url: "https://mcp.example.com/mcp",
    });
    expect(toCliBundleMcpServerConfig({ type: "sse", transport: "streamable-http" })).toEqual({
      type: "sse",
    });
  });
});
