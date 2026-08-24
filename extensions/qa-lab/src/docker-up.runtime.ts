// Qa Lab plugin module implements docker up behavior.
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { writeQaDockerHarnessFiles } from "./docker-harness.js";
import {
  execCommand,
  fetchHealthUrl,
  resolveComposeServiceUrl,
  resolveHostPort,
  waitForDockerServiceHealth,
  waitForHealth,
  type FetchLike,
  type RunCommand,
} from "./docker-runtime.js";
import { shellQuote } from "./shell-quote.js";

const QA_DOCKER_HEALTH_REQUEST_TIMEOUT_MS = 2_000;

type QaDockerUpResult = {
  outputDir: string;
  composeFile: string;
  qaLabUrl: string;
  gatewayUrl: string;
  stopCommand: string;
};

function resolveDefaultQaDockerDir(repoRoot: string) {
  return path.resolve(repoRoot, ".artifacts/qa-docker");
}

async function isQaLabDockerHealthReachable(url: string, fetchImpl: FetchLike) {
  let response: Awaited<ReturnType<FetchLike>> | undefined;
  try {
    response = await fetchImpl(url, {
      signal: AbortSignal.timeout(QA_DOCKER_HEALTH_REQUEST_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    try {
      await response?.body?.cancel?.();
    } catch {}
  }
}

function isMissingCommandError(
  error: unknown,
  command: string,
  seen = new Set<unknown>(),
): boolean {
  if (!error || seen.has(error)) {
    return false;
  }
  seen.add(error);
  if (typeof error !== "object") {
    return formatErrorMessage(error).includes(`spawn ${command} ENOENT`);
  }
  const candidate = error as { cause?: unknown; code?: unknown; message?: unknown };
  const message = typeof candidate.message === "string" ? candidate.message : "";
  if (
    candidate.code === "ENOENT" ||
    message.includes(`spawn ${command} ENOENT`) ||
    message.includes(`${command}: command not found`)
  ) {
    return true;
  }
  return isMissingCommandError(candidate.cause, command, seen);
}

async function runQaLabBuild(repoRoot: string, runCommand: RunCommand) {
  try {
    await runCommand("pnpm", ["qa:lab:build"], repoRoot);
  } catch (error) {
    if (!isMissingCommandError(error, "pnpm")) {
      throw error;
    }
    await runCommand("corepack", ["pnpm", "qa:lab:build"], repoRoot);
  }
}

export async function runQaDockerUp(
  params: {
    repoRoot?: string;
    outputDir?: string;
    gatewayPort?: number;
    qaLabPort?: number;
    providerBaseUrl?: string;
    image?: string;
    usePrebuiltImage?: boolean;
    bindUiDist?: boolean;
    skipUiBuild?: boolean;
  },
  deps?: {
    runCommand?: RunCommand;
    fetchImpl?: FetchLike;
    sleepImpl?: (ms: number) => Promise<unknown>;
    resolveHostPortImpl?: typeof resolveHostPort;
  },
): Promise<QaDockerUpResult> {
  const repoRoot = path.resolve(params.repoRoot ?? process.cwd());
  const resolveHostPortImpl = deps?.resolveHostPortImpl ?? resolveHostPort;
  const outputDir = path.resolve(params.outputDir ?? resolveDefaultQaDockerDir(repoRoot));
  const gatewayPort = await resolveHostPortImpl(
    params.gatewayPort ?? 18789,
    params.gatewayPort != null,
  );
  const qaLabPort = await resolveHostPortImpl(params.qaLabPort ?? 43124, params.qaLabPort != null);
  if (gatewayPort === qaLabPort) {
    throw new Error(
      `QA Lab gateway and UI host ports must be different. Both resolved to ${gatewayPort}.`,
    );
  }
  const runCommand = deps?.runCommand ?? execCommand;
  const fetchImpl = deps?.fetchImpl ?? fetchHealthUrl;
  const sleepImpl = deps?.sleepImpl ?? sleep;

  if (!params.skipUiBuild) {
    await runQaLabBuild(repoRoot, runCommand);
  }

  await writeQaDockerHarnessFiles({
    outputDir,
    repoRoot,
    gatewayPort,
    qaLabPort,
    providerBaseUrl: params.providerBaseUrl,
    imageName: params.image,
    usePrebuiltImage: params.usePrebuiltImage,
    bindUiDist: params.bindUiDist,
    includeQaLabUi: true,
  });

  const composeFile = path.join(outputDir, "docker-compose.qa.yml");

  // Tear down any previous stack from this compose file so ports are freed
  // and we get a clean restart every time.
  try {
    await runCommand(
      "docker",
      ["compose", "-f", composeFile, "down", "--remove-orphans"],
      repoRoot,
    );
  } catch {
    // First run or already stopped — ignore.
  }

  const composeArgs = ["compose", "-f", composeFile, "up"];
  if (!params.usePrebuiltImage) {
    composeArgs.push("--build");
  }
  composeArgs.push("-d");

  await runCommand("docker", composeArgs, repoRoot);

  // Brief settle delay so Docker Desktop finishes port-forwarding setup.
  await sleepImpl(3_000);

  const qaLabUrl = `http://127.0.0.1:${qaLabPort}`;
  const hostGatewayUrl = `http://127.0.0.1:${gatewayPort}/`;

  await waitForHealth(`${qaLabUrl}/healthz`, {
    label: "QA Lab",
    fetchImpl,
    sleepImpl,
    composeFile,
  });
  await waitForDockerServiceHealth(
    "openclaw-qa-gateway",
    composeFile,
    repoRoot,
    runCommand,
    sleepImpl,
  );
  let gatewayUrl = hostGatewayUrl;
  if (!(await isQaLabDockerHealthReachable(`${hostGatewayUrl}healthz`, fetchImpl))) {
    const containerGatewayUrl = await resolveComposeServiceUrl(
      "openclaw-qa-gateway",
      18789,
      composeFile,
      repoRoot,
      runCommand,
      fetchImpl,
    );
    if (containerGatewayUrl) {
      gatewayUrl = containerGatewayUrl;
    }
  }

  return {
    outputDir,
    composeFile,
    qaLabUrl,
    gatewayUrl,
    stopCommand: `docker compose -f ${shellQuote(composeFile)} down`,
  };
}
