#!/usr/bin/env node

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";

const CODEX_SUITE_PREFIX = "live-codex-harness";
const GENERIC_CODEX_SUITE = "live-codex-harness-docker";
const GPT_56_SUITE_PREFIX = "live-codex-harness-gpt56-";

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function appendLine(file, line) {
  appendFileSync(file, `${line}\n`, "utf8");
}

function readTargetModelIds(targetRoot) {
  const catalogPath = path.join(targetRoot, "extensions/codex/provider-catalog.ts");
  if (!existsSync(catalogPath)) {
    const harnessPath = path.join(targetRoot, "scripts/test-live-codex-harness-docker.sh");
    const source = readFileSync(harnessPath, "utf8");
    const defaults = new Set(
      [...source.matchAll(/\$\{OPENCLAW_LIVE_CODEX_HARNESS_MODEL:-[^/}]+\/([^}\s]+)\}/gu)].map(
        (match) => match[1],
      ),
    );
    if (defaults.size !== 1) {
      throw new Error(`cannot read one frozen Codex harness default from ${harnessPath}`);
    }
    // The harness default proves only the generic lane's model. Specialized
    // lanes need the explicit cohort declaration from the historical catalog.
    return { modelIds: new Set(defaults), supportsGpt56Cohort: false };
  }
  const source = readFileSync(catalogPath, "utf8");
  const start = source.indexOf("export const FALLBACK_CODEX_MODELS = [");
  const end = source.indexOf("] satisfies", start);
  if (start < 0 || end < 0) {
    throw new Error(`cannot read the frozen Codex fallback catalog from ${catalogPath}`);
  }
  const modelIds = new Set(
    [...source.slice(start, end).matchAll(/\bid:\s*["']([^"']+)["']/gu)].map((match) => match[1]),
  );
  const hasSol = modelIds.has("gpt-5.6-sol");
  const hasLuna = modelIds.has("gpt-5.6-luna");
  if (hasSol !== hasLuna) {
    throw new Error("frozen Codex GPT-5.6 capability marker is incomplete; refusing to guess");
  }
  return { modelIds, supportsGpt56Cohort: hasSol && hasLuna };
}

function resolveFrozenCodexCompatibility({ suiteId, targetRoot }) {
  const { modelIds, supportsGpt56Cohort } = readTargetModelIds(targetRoot);

  if (suiteId === GENERIC_CODEX_SUITE) {
    const model = modelIds.has("gpt-5.6-luna")
      ? "openai/gpt-5.6-luna"
      : modelIds.has("gpt-5.5")
        ? "openai/gpt-5.5"
        : modelIds.has("gpt-5.4-mini")
          ? "openai/gpt-5.4-mini"
          : undefined;
    if (!model) {
      throw new Error("frozen Codex catalog has no supported generic live-harness model");
    }
    return { model, runLane: true };
  }

  if (suiteId.startsWith(GPT_56_SUITE_PREFIX)) {
    return { runLane: supportsGpt56Cohort };
  }
  return { runLane: true };
}

function main() {
  const outputFile = requireEnv("GITHUB_OUTPUT");
  const suiteId = requireEnv("OPENCLAW_FROZEN_CODEX_SUITE_ID");
  const selectedSha = requireEnv("OPENCLAW_SELECTED_SHA");
  const workflowSha = requireEnv("OPENCLAW_WORKFLOW_SHA");
  const isFrozenTarget = selectedSha !== workflowSha;
  const omissionsAllowed = process.env.OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS === "1";

  if (!suiteId.startsWith(CODEX_SUITE_PREFIX) || !isFrozenTarget || !omissionsAllowed) {
    appendLine(outputFile, "run_lane=true");
    return;
  }

  const result = resolveFrozenCodexCompatibility({
    suiteId,
    targetRoot: requireEnv("OPENCLAW_FROZEN_TARGET_ROOT"),
  });
  appendLine(outputFile, `run_lane=${result.runLane}`);

  const summaryFile = requireEnv("GITHUB_STEP_SUMMARY");
  if (result.model) {
    appendLine(requireEnv("GITHUB_ENV"), `OPENCLAW_LIVE_CODEX_HARNESS_MODEL=${result.model}`);
    appendLine(
      summaryFile,
      `Frozen Codex target \`${selectedSha}\`: \`${suiteId}\` uses \`${result.model}\`.`,
    );
  } else if (!result.runLane) {
    appendLine(
      summaryFile,
      `Frozen Codex target \`${selectedSha}\`: omitted unsupported current-only suite \`${suiteId}\`.`,
    );
    console.log(`::notice::Omitting unsupported frozen-target Codex suite ${suiteId}`);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
