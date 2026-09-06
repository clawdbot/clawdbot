/** Shared test harness for CLI runner bundle-MCP config preparation tests. */
import fs from "node:fs/promises";
import { afterAll, beforeAll } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createBundleMcpTempHarness,
  createBundleProbePlugin,
} from "../../plugins/bundle-mcp.test-support.js";
import { captureEnv, setTestEnvValue, withEnvAsync } from "../../test-utils/env.js";
import { resolveConversationCapabilityProfile } from "../conversation-capability-profile.js";
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

export function requireMcpConfigPath(args: readonly string[] | undefined): string {
  // Claude-style bundle MCP mode appends --mcp-config; callers need the generated path.
  const configFlagIndex = args?.indexOf("--mcp-config") ?? -1;
  if (configFlagIndex < 0) {
    throw new Error("expected --mcp-config arg");
  }
  const generatedConfigPath = args?.[configFlagIndex + 1];
  if (typeof generatedConfigPath !== "string" || generatedConfigPath.length === 0) {
    throw new Error("expected --mcp-config path arg");
  }
  return generatedConfigPath;
}

export function setupCliBundleMcpTestHarness(): void {
  beforeAll(async () => {
    // Use an empty bundled-dir override so only temp fixture plugins participate.
    envSnapshot = captureEnv(["OPENCLAW_BUNDLED_PLUGINS_DIR"]);
    bundleProbeHomeDir = await tempHarness.createTempDir("openclaw-cli-bundle-mcp-home-");
    bundleProbeWorkspaceDir = await tempHarness.createTempDir("openclaw-cli-bundle-mcp-workspace-");
    const emptyBundledDir = await tempHarness.createTempDir("openclaw-cli-bundle-mcp-bundled-");
    setTestEnvValue("OPENCLAW_BUNDLED_PLUGINS_DIR", emptyBundledDir);
    ({ serverPath: bundleProbeServerPath } = await createBundleProbePlugin(bundleProbeHomeDir));
  });

  afterAll(async () => {
    envSnapshot?.restore();
    await tempHarness.cleanup();
  });
}

export async function writeCliMcpPolicyProbeServer(): Promise<string> {
  const filePath = `${cliBundleMcpHarness.bundleProbeWorkspaceDir}/policy-probe.mjs`;
  await fs.writeFile(
    filePath,
    `import readline from "node:readline";
const lines = readline.createInterface({ input: process.stdin });
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send(message.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "policy-probe", version: "1" } });
  if (message.method === "tools/list") send(message.id, { tools: [
    { name: "read_docs", description: "read", inputSchema: { type: "object" } },
    { name: "delete_docs", description: "delete", inputSchema: { type: "object" } },
    { name: "task_docs", description: "task", inputSchema: { type: "object" }, execution: { taskSupport: "required" } },
    { name: "app_docs", description: "app", inputSchema: { type: "object" }, _meta: { ui: { visibility: ["app"] } } }
  ] });
});
`,
    "utf-8",
  );
  return filePath;
}

export function cliNativeMcpPolicyContext(config: OpenClawConfig, sessionId: string) {
  return {
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
    capabilityProfile: resolveConversationCapabilityProfile({
      config,
      sessionKey: `agent:main:${sessionId}`,
      sessionId,
      agentId: "main",
      modelProvider: "openai",
      modelId: "gpt-5.4-codex",
      workspaceDir: cliBundleMcpHarness.bundleProbeWorkspaceDir,
    }),
  };
}

function createEnabledBundleProbeConfig(): OpenClawConfig {
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
  env?: Parameters<typeof prepareCliBundleMcpConfig>[0]["env"];
}) {
  // Bundle discovery reads HOME for per-user plugin roots.
  return await withEnvAsync({ HOME: bundleProbeHomeDir }, async () => {
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
      env: params?.env,
    });
  });
}
