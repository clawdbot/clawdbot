import { afterAll, beforeAll } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createBundleMcpTempHarness,
  createBundleProbePlugin,
} from "../../plugins/bundle-mcp.test-support.js";
import { captureEnv } from "../../test-utils/env.js";
import { prepareCliBundleMcpConfig } from "./bundle-mcp.js";

const tempHarness = createBundleMcpTempHarness();
let bundleProbeHomeDir = "";
let bundleProbeWorkspaceDir = "";
let bundleProbeServerPath = "";
let envSnapshot: ReturnType<typeof captureEnv> | undefined;

export const cliBundleMcpHarness = {
  tempHarness,
  get bundleProbeHomeDir() {
    return bundleProbeHomeDir;
  },
  get bundleProbeWorkspaceDir() {
    return bundleProbeWorkspaceDir;
  },
  get bundleProbeServerPath() {
    return bundleProbeServerPath;
  },
};

export function setupCliBundleMcpTestHarness(): void {
  beforeAll(async () => {
    envSnapshot = captureEnv(["OPENCLAW_BUNDLED_PLUGINS_DIR"]);
    bundleProbeHomeDir = await tempHarness.createTempDir("openclaw-cli-bundle-mcp-home-");
    bundleProbeWorkspaceDir = await tempHarness.createTempDir("openclaw-cli-bundle-mcp-workspace-");
    const emptyBundledDir = await tempHarness.createTempDir("openclaw-cli-bundle-mcp-bundled-");
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = emptyBundledDir;
    ({ serverPath: bundleProbeServerPath } = await createBundleProbePlugin(bundleProbeHomeDir));
  });

  afterAll(async () => {
    envSnapshot?.restore();
    await tempHarness.cleanup();
  });
}

export function createEnabledBundleProbeConfig(): OpenClawConfig {
  return {
    plugins: {
      entries: {
        "bundle-probe": { enabled: true },
      },
    },
  };
}

export async function prepareBundleProbeCliConfig(params?: {
  additionalConfig?: Parameters<typeof prepareCliBundleMcpConfig>[0]["additionalConfig"];
}) {
  const env = captureEnv(["HOME"]);
  try {
    process.env.HOME = bundleProbeHomeDir;
    return await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "claude-config-file",
      backend: {
        command: "node",
        args: ["./fake-claude.mjs"],
      },
      workspaceDir: bundleProbeWorkspaceDir,
      config: createEnabledBundleProbeConfig(),
      additionalConfig: params?.additionalConfig,
    });
  } finally {
    env.restore();
  }
}
