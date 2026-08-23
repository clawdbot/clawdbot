#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { fail, freezeScenario, writeJson } from "./telegram-visible-proof-contract.mjs";
import { evaluateVisibleProof } from "./telegram-visible-proof-evidence.mjs";

export {
  freezeScenario,
  scenarioDigest,
  stableStringify,
  validateAssertions,
  validateScenarioDirectory,
} from "./telegram-visible-proof-contract.mjs";
export {
  eventMatches,
  evaluateAssertion,
  normalizeInvocations,
  normalizeVisibleEvents,
  visibleEvents,
} from "./telegram-visible-proof-events.mjs";
export { evaluateVisibleProof } from "./telegram-visible-proof-evidence.mjs";

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      fail(`Invalid arguments for ${command ?? "command"}.`);
    }
    values[key.slice(2).replaceAll("-", "_")] = value;
  }
  return { command, values };
}

function requiredArg(values, name) {
  const value = values[name];
  if (!value) {
    fail(`Missing --${name.replaceAll("_", "-")}.`);
  }
  return value;
}

export function main(argv = process.argv.slice(2)) {
  const { command, values } = parseArgs(argv);
  if (command === "freeze") {
    const result = freezeScenario({
      draftDir: requiredArg(values, "draft"),
      frozenDir: requiredArg(values, "frozen"),
    });
    if (values.metadata) {
      writeJson(values.metadata, result);
    }
    console.log(JSON.stringify(result));
    return;
  }
  if (command === "evaluate") {
    const result = evaluateVisibleProof({
      baselineExit: requiredArg(values, "baseline_exit"),
      baselineFacts: requiredArg(values, "baseline_facts"),
      baselineRef: requiredArg(values, "baseline_ref"),
      baselineSha: requiredArg(values, "baseline_sha"),
      candidateExit: requiredArg(values, "candidate_exit"),
      candidateFacts: requiredArg(values, "candidate_facts"),
      candidateRef: requiredArg(values, "candidate_ref"),
      candidateSha: requiredArg(values, "candidate_sha"),
      outputDir: requiredArg(values, "output_dir"),
      publishedRoot: requiredArg(values, "published_root"),
      scenarioDir: requiredArg(values, "scenario"),
      scenarioHash: requiredArg(values, "scenario_hash"),
    });
    console.log(JSON.stringify({ outcome: result.manifest.comparison.outcome }));
    return;
  }
  fail("Usage: telegram-visible-proof.mjs <freeze|evaluate> ...");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
