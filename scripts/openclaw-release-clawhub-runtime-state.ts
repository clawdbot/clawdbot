#!/usr/bin/env -S node --import tsx
import { parseStrictBooleanArg } from "./lib/arg-utils.mts";
import { buildOpenClawReleaseClawHubRuntimeState } from "./lib/openclaw-release-clawhub-plan.ts";

function parseArgs(argv: string[]) {
  const values = [...argv];
  if (values[0] === "--") {
    values.shift();
  }

  let repository: string | undefined;
  let waitForClawHub: boolean | undefined;
  let forceSkipClawHub: boolean | undefined;
  let normalRunId: string | undefined;
  let normalPublicationStaged = false;
  let bootstrapRunId: string | undefined;
  let bootstrapCompleted: boolean | undefined;

  for (let index = 0; index < values.length; index += 1) {
    const arg = values[index];
    const next = () => {
      const value = values[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error(`${arg} requires a value.`);
      }
      index += 1;
      return value;
    };

    switch (arg) {
      case "--repository":
        repository = next();
        break;
      case "--wait-for-clawhub":
        waitForClawHub = parseStrictBooleanArg(next(), "--wait-for-clawhub");
        break;
      case "--force-skip-clawhub":
        forceSkipClawHub = parseStrictBooleanArg(next(), "--force-skip-clawhub");
        break;
      case "--normal-run-id":
        normalRunId = next();
        break;
      case "--normal-publication-staged":
        normalPublicationStaged = parseStrictBooleanArg(next(), "--normal-publication-staged");
        break;
      case "--bootstrap-run-id":
        bootstrapRunId = next();
        break;
      case "--bootstrap-completed":
        bootstrapCompleted = parseStrictBooleanArg(next(), "--bootstrap-completed");
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!repository?.trim()) {
    throw new Error("--repository is required.");
  }
  if (waitForClawHub === undefined) {
    throw new Error("--wait-for-clawhub is required.");
  }
  if (forceSkipClawHub === undefined) {
    throw new Error("--force-skip-clawhub is required.");
  }
  if (bootstrapCompleted === undefined) {
    throw new Error("--bootstrap-completed is required.");
  }

  return {
    repository,
    waitForClawHub,
    forceSkipClawHub,
    normalRunId,
    normalPublicationStaged,
    bootstrapRunId,
    bootstrapCompleted,
  };
}

try {
  const state = buildOpenClawReleaseClawHubRuntimeState(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
