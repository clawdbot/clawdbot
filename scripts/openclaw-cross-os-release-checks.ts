#!/usr/bin/env node

// Executed directly via Node.js native type stripping in the release workflow.

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CandidateBuild, LaneResult } from "./lib/cross-os-release-checks/config.ts";
import {
  isSupportedCrossOsSuite,
  parseArgs,
  readRunnerOverrideEnv,
  resolveProviderConfig,
  resolveRunnerMatrix,
} from "./lib/cross-os-release-checks/config.ts";
import { prepareCandidate, readProvidedCandidate } from "./lib/cross-os-release-checks/install.ts";
import {
  runDevUpdateSuite,
  runFreshLane,
  runInstallerFreshSuite,
  runUpgradeLane,
} from "./lib/cross-os-release-checks/lanes.ts";
import { startStaticFileServer } from "./lib/cross-os-release-checks/process.ts";
import {
  requireArg,
  writeCandidateManifest,
  writeSummary,
} from "./lib/cross-os-release-checks/reporting.ts";
import { formatError } from "./lib/cross-os-release-checks/shared.ts";

const SCRIPT_PATH = fileURLToPath(import.meta.url);

if (isMainModule()) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${formatError(error)}\n`);
    process.exit(1);
  }
}

function isMainModule() {
  const invokedPath = process.argv[1]?.trim();
  if (!invokedPath) {
    return false;
  }
  return resolve(invokedPath) === SCRIPT_PATH;
}

async function main(argv: string[]) {
  const args = parseArgs(argv);

  if (args["resolve-matrix"] === "true") {
    const mode = args["mode"] ?? "both";
    const ref = args["ref"]?.trim() || "main";
    const runnerOverrideEnv = readRunnerOverrideEnv(process.env);
    process.stdout.write(
      `${JSON.stringify(
        resolveRunnerMatrix({
          mode,
          ref,
          ubuntuRunner: args["ubuntu-runner"],
          windowsRunner: args["windows-runner"],
          macosRunner: args["macos-runner"],
          suiteFilter: args["suite-filter"],
          ...runnerOverrideEnv,
        }),
      )}\n`,
    );
    return;
  }

  const outputDir = resolve(requireArg(args, "output-dir"));
  const prepareOnly = args["prepare-only"] === "true";
  const sourceDir = args["source-dir"]?.trim() ? resolve(args["source-dir"].trim()) : "";
  const provider = args["provider"]?.trim() || "";
  const suite = args["suite"]?.trim() || "";
  const mode = args["mode"] ?? "both";
  const inputRef = args["ref"]?.trim() || "";
  const previousVersion = args["previous-version"]?.trim() || "";
  const baselineSpec =
    args["baseline-spec"]?.trim() ||
    (previousVersion ? `openclaw@${previousVersion}` : "openclaw@latest");
  const providedBaselineTgz = args["baseline-tgz"]?.trim()
    ? resolve(args["baseline-tgz"].trim())
    : "";
  const providedCandidateTgz = args["candidate-tgz"]?.trim()
    ? resolve(args["candidate-tgz"].trim())
    : "";
  const providedCandidateVersion = args["candidate-version"]?.trim() || "";
  const providedSourceSha = args["source-sha"]?.trim() || "";
  const runDiscordRoundtrip = args["run-discord-roundtrip"] === "true";

  mkdirSync(outputDir, { recursive: true });
  const logsDir = join(outputDir, "logs");
  mkdirSync(logsDir, { recursive: true });

  if (prepareOnly) {
    if (!sourceDir) {
      throw new Error("--prepare-only requires --source-dir.");
    }
    const build = await prepareCandidate({
      outputDir,
      sourceDir,
      logsDir,
    });
    writeCandidateManifest(outputDir, build);
    return;
  }

  if (!isSupportedCrossOsSuite(suite)) {
    throw new Error(`Unsupported suite "${suite}".`);
  }

  const selectedProvider = resolveProviderConfig(provider);
  if (!selectedProvider) {
    throw new Error(`Unsupported provider "${provider}".`);
  }
  const providerSecretValue = process.env[selectedProvider.secretEnv]?.trim();
  if (!providerSecretValue) {
    throw new Error(`Missing ${selectedProvider.secretEnv}.`);
  }

  const summary = {
    platform: process.platform,
    runnerOs: process.env.OPENCLAW_RELEASE_CHECK_OS ?? "",
    runnerLabel: process.env.OPENCLAW_RELEASE_CHECK_RUNNER ?? "",
    provider,
    mode,
    suite,
    ref: inputRef || null,
    previousVersion: previousVersion || null,
    sourceDir,
    sourceSha: "",
    candidateVersion: "",
    candidateTgz: "",
    baselineSpec,
    result: {
      status: "pending",
    } as LaneResult,
    discordRoundtrip: runDiscordRoundtrip,
  };

  let build: CandidateBuild;
  try {
    build = sourceDir
      ? await prepareCandidate({
          outputDir,
          sourceDir,
          logsDir,
        })
      : readProvidedCandidate({
          candidateTgz: providedCandidateTgz,
          candidateVersion: providedCandidateVersion,
          sourceSha: providedSourceSha,
        });
    summary.sourceSha = build.sourceSha;
    summary.candidateVersion = build.candidateVersion;
    summary.candidateTgz = build.candidateTgz;

    if (suite === "packaged-fresh") {
      summary.result = await runFreshLane({
        build,
        logsDir,
        providerConfig: selectedProvider,
        providerSecretValue,
      });
    } else if (suite === "packaged-upgrade") {
      const tgzServer = await startStaticFileServer({
        filePath: build.candidateTgz,
        logPath: join(logsDir, "candidate-http-server.log"),
      });
      try {
        summary.result = await runUpgradeLane({
          baselineSpec,
          baselineTgz: providedBaselineTgz,
          build,
          candidateUrl: tgzServer.url,
          logsDir,
          providerConfig: selectedProvider,
          providerSecretValue,
        });
      } finally {
        await tgzServer.close();
      }
    } else if (suite === "installer-fresh") {
      summary.result = await runInstallerFreshSuite({
        build,
        logsDir,
        providerConfig: selectedProvider,
        providerSecretValue,
        runDiscordRoundtrip,
      });
    } else {
      summary.result = await runDevUpdateSuite({
        baselineSpec,
        logsDir,
        providerConfig: selectedProvider,
        providerSecretValue,
        ref: inputRef || "main",
        sourceSha: build.sourceSha,
        runDiscordRoundtrip,
      });
    }
  } catch (error) {
    summary.result = {
      status: "fail",
      error: formatError(error),
    };
  }

  writeSummary(outputDir, summary);

  if (summary.result.status !== "pass") {
    process.exit(1);
  }
}
