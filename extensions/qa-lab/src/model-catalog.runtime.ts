// Qa Lab plugin module implements model catalog behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { runCommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { QA_CHILD_STDERR_TAIL_BYTES, QA_CHILD_STDOUT_MAX_BYTES } from "./child-output.js";
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

function createCatalogAbortError() {
  return new Error(CATALOG_ABORT_ERROR_MESSAGE);
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

    const nodeExecPath = await resolveQaNodeExecPath();
    const result = await runCommandWithTimeout(
      [nodeExecPath, "dist/index.js", "models", "list", "--all", "--json"],
      {
        cwd: params.repoRoot,
        env: {
          HOME: homeDir,
          OPENCLAW_HOME: homeDir,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_OAUTH_DIR: path.join(stateDir, "credentials"),
          OPENCLAW_CODEX_DISCOVERY_LIVE: "0",
        },
        killProcessTree: true,
        maxOutputBytes: {
          stdout: QA_CHILD_STDOUT_MAX_BYTES,
          stderr: QA_CHILD_STDERR_TAIL_BYTES,
        },
        outputCapture: { stdout: "head", stderr: "tail" },
        signal: params.signal,
        terminateOnOutputLimit: { stdout: true },
      },
    );
    if (
      params.signal?.aborted ||
      (result.termination === "signal" && !result.outputLimitExceeded)
    ) {
      throw createCatalogAbortError();
    }
    if (result.outputLimitExceeded || result.stdoutTruncatedBytes) {
      throw new Error(
        `qa model catalog stdout exceeded ${QA_CHILD_STDOUT_MAX_BYTES} bytes; refusing to parse truncated output`,
      );
    }
    if (result.code !== 0) {
      const stderrText = result.stderr.trim();
      const stderrDetail = result.stderrTruncatedBytes
        ? `[qa model catalog stderr truncated to last ${QA_CHILD_STDERR_TAIL_BYTES} bytes]\n${stderrText}`
        : stderrText;
      throw new Error(`qa model catalog failed (${result.code ?? "unknown"}): ${stderrDetail}`);
    }

    return parseQaRunnerModelOptionsOutput(result.stdout);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}
