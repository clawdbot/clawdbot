// Qa Lab plugin module implements model catalog behavior.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import {
  appendQaChildOutput,
  appendQaChildOutputTail,
  createQaChildOutputCapture,
  createQaChildOutputTail,
  formatQaChildOutputTail,
  QA_CHILD_STDOUT_MAX_BYTES,
  readQaChildOutput,
} from "./child-output.js";
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
import { resolveQaWindowsSystem32ExePath } from "./windows-system-tools.js";

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

function selectQaRunnerModelOptions(rows: ModelRow[]): QaRunnerModelOption[] {
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

function isModelRow(value: unknown): value is ModelRow {
  if (!value || typeof value !== "object") {
    return false;
  }
  const row = value as Partial<ModelRow>;
  return (
    typeof row.key === "string" &&
    typeof row.name === "string" &&
    typeof row.input === "string" &&
    (row.available === true || row.available === false || row.available === null) &&
    typeof row.missing === "boolean"
  );
}

function parseQaRunnerModelOptionsOutput(stdout: string): QaRunnerModelOption[] {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout) as unknown;
  } catch {
    throw new Error("qa model catalog returned malformed JSON");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("qa model catalog returned invalid JSON payload");
  }
  const rows = (payload as { models?: unknown }).models;
  return selectQaRunnerModelOptions(Array.isArray(rows) ? rows.filter(isModelRow) : []);
}

const CATALOG_ABORT_ERROR_MESSAGE = "qa model catalog aborted";
const CATALOG_ABORT_KILL_GRACE_MS = 1_000;
const CATALOG_ABORT_POLL_MS = 50;

function createCatalogAbortError() {
  return new Error(CATALOG_ABORT_ERROR_MESSAGE);
}

function killProcessTree(pid: number | undefined, signal: NodeJS.Signals) {
  if (pid === undefined) {
    return;
  }
  try {
    if (process.platform === "win32") {
      const killer = spawn(
        resolveQaWindowsSystem32ExePath("taskkill.exe"),
        ["/pid", String(pid), "/t", "/f"],
        {
          stdio: "ignore",
          windowsHide: true,
        },
      );
      killer.once("error", () => {
        try {
          process.kill(pid, signal);
        } catch {
          // The process already exited.
        }
      });
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

function processTreeIsAlive(pid: number | undefined) {
  if (pid === undefined || process.platform === "win32") {
    return false;
  }
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

async function waitForProcessTreeExit(pid: number | undefined, timeoutMs: number) {
  const deadlineAt = Date.now() + timeoutMs;
  while (Date.now() < deadlineAt) {
    if (!processTreeIsAlive(pid)) {
      return true;
    }
    await new Promise((resolvePoll) => {
      setTimeout(resolvePoll, CATALOG_ABORT_POLL_MS);
    });
  }
  return !processTreeIsAlive(pid);
}

export async function loadQaRunnerModelOptions(params: {
  repoRoot: string;
  signal?: AbortSignal;
  abortKillGraceMs?: number;
}) {
  const abortKillGraceMs = Math.max(1, params.abortKillGraceMs ?? CATALOG_ABORT_KILL_GRACE_MS);
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

    const stdout = createQaChildOutputCapture();
    const stderr = createQaChildOutputTail();
    const nodeExecPath = await resolveQaNodeExecPath();
    await new Promise<void>((resolve, reject) => {
      let aborted = params.signal?.aborted === true;
      let forceKillTimer: NodeJS.Timeout | undefined;
      let forceKillAt: number | undefined;
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
      const cleanupAbortListener = () => {
        params.signal?.removeEventListener("abort", abortCatalogLoad);
      };
      const cleanup = () => {
        cleanupAbortListener();
        if (forceKillTimer) {
          clearTimeout(forceKillTimer);
          forceKillTimer = undefined;
        }
      };
      const finishAbortedCatalogLoad = async () => {
        cleanupAbortListener();
        const graceRemainingMs =
          forceKillAt === undefined ? abortKillGraceMs : Math.max(0, forceKillAt - Date.now());
        if (graceRemainingMs > 0) {
          await waitForProcessTreeExit(child.pid, graceRemainingMs);
        }
        if (forceKillTimer) {
          clearTimeout(forceKillTimer);
          forceKillTimer = undefined;
        }
        if (processTreeIsAlive(child.pid)) {
          killProcessTree(child.pid, "SIGKILL");
          await waitForProcessTreeExit(child.pid, abortKillGraceMs);
        }
        forceKillAt = undefined;
      };
      const abortCatalogLoad = () => {
        aborted = true;
        killProcessTree(child.pid, "SIGTERM");
        forceKillAt = Date.now() + abortKillGraceMs;
        forceKillTimer ??= setTimeout(() => {
          forceKillAt = undefined;
          killProcessTree(child.pid, "SIGKILL");
        }, abortKillGraceMs);
        forceKillTimer.unref();
      };
      if (aborted) {
        abortCatalogLoad();
      } else {
        params.signal?.addEventListener("abort", abortCatalogLoad, { once: true });
      }
      child.stdout.on("data", (chunk) => appendQaChildOutput(stdout, chunk));
      child.stderr.on("data", (chunk) => appendQaChildOutputTail(stderr, chunk));
      child.once("error", (error) => {
        cleanup();
        reject(aborted ? createCatalogAbortError() : error);
      });
      child.once("exit", (code) => {
        cleanupAbortListener();
        if (aborted) {
          void finishAbortedCatalogLoad().then(
            () => reject(createCatalogAbortError()),
            () => reject(createCatalogAbortError()),
          );
          return;
        }
        cleanup();
        if (code === 0) {
          if (stdout.exceeded) {
            reject(
              new Error(
                `qa model catalog stdout exceeded ${QA_CHILD_STDOUT_MAX_BYTES} bytes; refusing to parse truncated output`,
              ),
            );
            return;
          }
          resolve();
          return;
        }
        const stderrText = formatQaChildOutputTail(stderr, "qa model catalog stderr");
        reject(new Error(`qa model catalog failed (${code ?? "unknown"}): ${stderrText}`));
      });
    });

    return parseQaRunnerModelOptionsOutput(readQaChildOutput(stdout));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}
