import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
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
  const runCommand = deps?.runCommand ?? execCommand;
  const fetchImpl = deps?.fetchImpl ?? fetchHealthUrl;
  const sleepImpl = deps?.sleepImpl ?? sleep;

  if (!params.skipUiBuild) {
    await runCommand("pnpm", ["qa:lab:build"], repoRoot);
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
  if (
    !(await fetchImpl(`${hostGatewayUrl}healthz`)
      .then((response) => response.ok)
      .catch(() => false))
  ) {
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
    stopCommand: `docker compose -f ${composeFile} down`,
  };
}
