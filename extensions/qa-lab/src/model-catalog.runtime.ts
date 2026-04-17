import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { resolveQaNodeExecPath } from "./node-exec.js";
import {
  isPreferredQaLiveFrontierCatalogModel,
  QA_FRONTIER_CATALOG_ALTERNATE_MODEL,
  QA_FRONTIER_CATALOG_PRIMARY_MODEL,
  QA_FRONTIER_PROVIDER_IDS,
} from "./providers/live-frontier/catalog.js";
import {
  createQaChannelGatewayConfig,
  QA_CHANNEL_REQUIRED_PLUGIN_IDS,
} from "./qa-channel-transport.js";
import { buildQaGatewayConfig } from "./qa-gateway-config.js";

type ModelRow = {
  key: string;
  name: string;
  input: string;
  available: boolean | null;
  missing: boolean;
};

export type QaRunnerModelOption = {
  key: string;
  name: string;
  provider: string;
  input: string;
  preferred: boolean;
};

function splitModelKey(key: string) {
  const slash = key.indexOf("/");
  if (slash <= 0 || slash === key.length - 1) {
    return null;
  }
  return {
    provider: key.slice(0, slash),
    model: key.slice(slash + 1),
  };
}

export function selectQaRunnerModelOptions(rows: ModelRow[]): QaRunnerModelOption[] {
  const options = rows
    .filter((row) => row.available === true && !row.missing)
    .map((row) => {
      const parsed = splitModelKey(row.key);
      return {
        key: row.key,
        name: row.name,
        provider: parsed?.provider ?? "unknown",
        input: row.input,
        preferred: isPreferredQaLiveFrontierCatalogModel(row.key),
      } satisfies QaRunnerModelOption;
    });

  return options.toSorted((left, right) => {
    if (left.preferred !== right.preferred) {
      return left.preferred ? -1 : 1;
    }
    const providerCompare = left.provider.localeCompare(right.provider);
    if (providerCompare !== 0) {
      return providerCompare;
    }
    return left.name.localeCompare(right.name);
  });
}

const CATALOG_ABORT_ERROR_MESSAGE = "qa model catalog aborted";

function createCatalogAbortError() {
  return new Error(CATALOG_ABORT_ERROR_MESSAGE);
}

function killProcessTree(pid: number | undefined, signal: NodeJS.Signals) {
  if (pid === undefined) {
    return;
  }
  try {
    if (process.platform === "win32") {
      process.kill(pid, signal);
      return;
    }
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // The process already exited.
    }
  }
}

export async function loadQaRunnerModelOptions(params: { repoRoot: string; signal?: AbortSignal }) {
  const tempRoot = await fs.mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "openclaw-qa-model-catalog-"),
  );
  const workspaceDir = path.join(tempRoot, "workspace");
  const stateDir = path.join(tempRoot, "state");
  const homeDir = path.join(tempRoot, "home");
  const configPath = path.join(tempRoot, "openclaw.json");

  try {
    await Promise.all([
      fs.mkdir(workspaceDir, { recursive: true }),
      fs.mkdir(stateDir, { recursive: true }),
      fs.mkdir(homeDir, { recursive: true }),
    ]);
    const cfg = buildQaGatewayConfig({
      bind: "loopback",
      gatewayPort: 0,
      gatewayToken: "qa-model-catalog",
      workspaceDir,
      providerMode: "live-frontier",
      primaryModel: QA_FRONTIER_CATALOG_PRIMARY_MODEL,
      alternateModel: QA_FRONTIER_CATALOG_ALTERNATE_MODEL,
      enabledProviderIds: [...QA_FRONTIER_PROVIDER_IDS],
      imageGenerationModel: null,
      controlUiEnabled: false,
      transportPluginIds: QA_CHANNEL_REQUIRED_PLUGIN_IDS,
      transportConfig: createQaChannelGatewayConfig({
        baseUrl: "http://127.0.0.1:9",
      }),
    });
    await fs.writeFile(configPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const nodeExecPath = await resolveQaNodeExecPath();
    await new Promise<void>((resolve, reject) => {
      let aborted = params.signal?.aborted === true;
      let forceKillTimer: NodeJS.Timeout | undefined;
      const child = spawn(nodeExecPath, ["dist/index.js", "models", "list", "--all", "--json"], {
        cwd: params.repoRoot,
        env: {
          ...process.env,
          HOME: homeDir,
          OPENCLAW_HOME: homeDir,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_OAUTH_DIR: path.join(stateDir, "credentials"),
          OPENCLAW_CODEX_DISCOVERY_LIVE: "0",
        },
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const cleanup = () => {
        params.signal?.removeEventListener("abort", abortCatalogLoad);
        if (forceKillTimer) {
          clearTimeout(forceKillTimer);
        }
      };
      const abortCatalogLoad = () => {
        aborted = true;
        killProcessTree(child.pid, "SIGTERM");
        forceKillTimer = setTimeout(() => {
          killProcessTree(child.pid, "SIGKILL");
        }, 1_000);
        forceKillTimer.unref();
      };
      if (aborted) {
        abortCatalogLoad();
      } else {
        params.signal?.addEventListener("abort", abortCatalogLoad, { once: true });
      }
      child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
      child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
      child.once("error", (error) => {
        cleanup();
        reject(aborted ? createCatalogAbortError() : error);
      });
      child.once("exit", (code) => {
        cleanup();
        if (aborted) {
          reject(createCatalogAbortError());
          return;
        }
        if (code === 0) {
          resolve();
          return;
        }
        reject(
          new Error(
            `qa model catalog failed (${code ?? "unknown"}): ${Buffer.concat(stderr).toString("utf8").trim()}`,
          ),
        );
      });
    });

    const payload = JSON.parse(Buffer.concat(stdout).toString("utf8")) as { models?: ModelRow[] };
    return selectQaRunnerModelOptions(payload.models ?? []);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}
