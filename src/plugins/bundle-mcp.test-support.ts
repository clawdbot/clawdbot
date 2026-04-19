import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { captureEnv } from "../test-utils/env.js";
import { clearPluginDiscoveryCache } from "./discovery.js";
import { clearPluginManifestRegistryCache } from "./manifest-registry.js";

export function createBundleMcpTempHarness() {
  const tempDirs: string[] = [];

  return {
    async createTempDir(prefix: string): Promise<string> {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
      tempDirs.push(dir);
      return dir;
    },
    async cleanup() {
      clearPluginDiscoveryCache();
      clearPluginManifestRegistryCache();
      await Promise.all(
        tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
      );
    },
  };
}

export function resolveBundlePluginRoot(homeDir: string, pluginId: string) {
  return path.join(homeDir, ".openclaw", "extensions", pluginId);
}

export async function writeClaudeBundleManifest(params: {
  homeDir: string;
  pluginId: string;
  manifest: Record<string, unknown>;
}) {
  const pluginRoot = resolveBundlePluginRoot(params.homeDir, params.pluginId);
  await fs.mkdir(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
  await fs.writeFile(
    path.join(pluginRoot, ".claude-plugin", "plugin.json"),
    `${JSON.stringify(params.manifest, null, 2)}\n`,
    "utf-8",
  );
  return pluginRoot;
}

export async function writeBundleTextFiles(
  rootDir: string,
  files: Readonly<Record<string, string>>,
) {
  await Promise.all(
    Object.entries(files).map(async ([relativePath, contents]) => {
      const filePath = path.join(rootDir, relativePath);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, contents, "utf-8");
    }),
  );
}

export function createEnabledPluginEntries(pluginIds: readonly string[]) {
  return Object.fromEntries(pluginIds.map((pluginId) => [pluginId, { enabled: true }]));
}

export async function createBundleProbePlugin(homeDir: string) {
  const pluginRoot = resolveBundlePluginRoot(homeDir, "bundle-probe");
  const serverPath = path.join(pluginRoot, "servers", "probe.mjs");
  await fs.mkdir(path.dirname(serverPath), { recursive: true });
  await fs.writeFile(serverPath, "export {};\n", "utf-8");
  await writeClaudeBundleManifest({
    homeDir,
    pluginId: "bundle-probe",
    manifest: { name: "bundle-probe" },
  });
  await fs.writeFile(
    path.join(pluginRoot, ".mcp.json"),
    `${JSON.stringify(
      {
        mcpServers: {
          bundleProbe: {
            command: "node",
            args: ["./servers/probe.mjs"],
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
  return { pluginRoot, serverPath };
}

export async function withBundleHomeEnv<T>(
  tempHarness: { createTempDir: (prefix: string) => Promise<string> },
  prefix: string,
  run: (params: { homeDir: string; workspaceDir: string }) => Promise<T>,
): Promise<T> {
  const env = captureEnv(["HOME", "USERPROFILE", "OPENCLAW_HOME", "OPENCLAW_STATE_DIR"]);
  try {
    const homeDir = await tempHarness.createTempDir(`${prefix}-home-`);
    const workspaceDir = await tempHarness.createTempDir(`${prefix}-workspace-`);
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    delete process.env.OPENCLAW_HOME;
    delete process.env.OPENCLAW_STATE_DIR;
    return await run({ homeDir, workspaceDir });
  } finally {
    env.restore();
  }
}
