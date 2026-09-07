import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach } from "vitest";
import { gatewayOriginScope } from "../../packages/gateway-client/src/gateway-origin-scope.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { storeOriginDeviceToken } from "../infra/device-auth-store.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { runCliProcessChild } from "./cli-process-child.test-helpers.js";
import { closeActiveGatewayServers } from "./gateway-backed-exit.test-helpers.js";

export const tempDirs = useAutoCleanupTempDirTracker(afterEach);
export const UNREACHABLE_GATEWAY_URL = "ws://127.0.0.1:9";
afterEach(async () => {
  await closeActiveGatewayServers();
});

export async function prepareGatewayCliFixture(
  root: string,
  gateway: Record<string, unknown>,
): Promise<{ stateDir: string; configPath: string }> {
  const stateDir = path.join(root, "state");
  const configPath = path.join(stateDir, "openclaw.json");
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(configPath, JSON.stringify({ gateway }));
  return { stateDir, configPath };
}

export async function snapshotDirectoryContents(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  const visit = async (directory: string): Promise<void> => {
    for (const name of (await fs.readdir(directory)).toSorted()) {
      const absolutePath = path.join(directory, name);
      const relativePath = path.relative(root, absolutePath);
      const stat = await fs.lstat(absolutePath);
      if (stat.isDirectory()) {
        snapshot[relativePath] = "directory";
        await visit(absolutePath);
      } else if (stat.isSymbolicLink()) {
        snapshot[relativePath] = `symlink:${await fs.readlink(absolutePath)}`;
      } else {
        snapshot[relativePath] = `file:${createHash("sha256")
          .update(await fs.readFile(absolutePath))
          .digest("hex")}`;
      }
    }
  };
  await visit(root);
  return snapshot;
}

export async function snapshotSharedStateArtifacts(
  stateDir: string,
): Promise<Record<string, string>> {
  const sharedStateDir = path.join(stateDir, "state");
  try {
    return await snapshotDirectoryContents(sharedStateDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

export async function prepareUnreachableGatewayCliFixture(params: {
  label: string;
  seeded: boolean;
}): Promise<{ root: string; stateDir: string; configPath: string }> {
  const root = tempDirs.make(`openclaw-${params.label}-${params.seeded ? "seeded" : "absent"}-`);
  const { stateDir, configPath } = await prepareGatewayCliFixture(root, {
    mode: "remote",
    auth: { mode: "none" },
    remote: { url: UNREACHABLE_GATEWAY_URL },
  });
  if (params.seeded) {
    const stateEnv = {
      ...process.env,
      HOME: root,
      OPENCLAW_HOME: root,
      OPENCLAW_STATE_DIR: stateDir,
    };
    const identity = loadOrCreateDeviceIdentity({ env: stateEnv });
    storeOriginDeviceToken({
      gatewayScope: gatewayOriginScope(UNREACHABLE_GATEWAY_URL),
      deviceId: identity.deviceId,
      role: "operator",
      token: "stored-device-token",
      scopes: ["operator.admin"],
      env: stateEnv,
    });
    closeOpenClawStateDatabaseForTest();
  }
  return { root, stateDir, configPath };
}

export async function runIsolatedGatewayCli(params: {
  args: string[];
  root: string;
  stateDir: string;
  configPath: string;
  env?: NodeJS.ProcessEnv;
  onStdout?: (stdout: string) => void;
}): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}> {
  return await runCliProcessChild({
    nodeArgs: ["--import", "tsx", "src/entry.ts", ...params.args],
    env: {
      ...process.env,
      HOME: params.root,
      USERPROFILE: params.root,
      // CI shard runners export NODE_COMPILE_CACHE; in a source checkout entry.ts
      // then respawns a detached grandchild that shares this child's stdio pipes,
      // so a SIGKILLed parent leaves an orphan holding them open. Keep these
      // children single-process; entry.compile-cache owns that respawn contract.
      NODE_DISABLE_COMPILE_CACHE: "1",
      NODE_ENV: undefined,
      NODE_OPTIONS: undefined,
      OPENCLAW_CONFIG_PATH: params.configPath,
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_GATEWAY_PASSWORD: undefined,
      OPENCLAW_GATEWAY_TOKEN: undefined,
      OPENCLAW_GATEWAY_URL: undefined,
      OPENCLAW_HOME: params.root,
      OPENCLAW_NO_RESPAWN: "1",
      OPENCLAW_STATE_DIR: params.stateDir,
      DISCORD_BOT_TOKEN: undefined,
      TWILIO_ACCOUNT_SID: undefined,
      TWILIO_AUTH_TOKEN: undefined,
      TWILIO_FROM_NUMBER: undefined,
      VITEST: undefined,
      ...params.env,
    },
    onStdout: params.onStdout,
  });
}
