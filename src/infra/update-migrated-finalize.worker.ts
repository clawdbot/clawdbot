import fs from "node:fs/promises";
import { finishUpdateRun } from "../cli/daemon-cli.js";
import type {
  MigratedUpdateFinalizationInput,
  MigratedUpdateFinalizationResult,
} from "../cli/update-cli/update-command-migrated.js";
import { finishUpdate } from "../cli/update-cli/update-command-post-update.js";
import { UpdateCommandFailure } from "../cli/update-cli/update-command-result.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { getUpdateRun, recordUpdateRunStep } from "./update-run-ledger.js";

async function finalizeMigratedUpdate(): Promise<void> {
  // Validation imports this whole candidate graph before activation. The helper
  // also needs the stable recovery barrel's writer after an actual schema bump.
  if (process.argv[2] === "--check") {
    if (typeof finishUpdateRun !== "function") {
      throw new Error("Candidate recovery writer is unavailable.");
    }
    process.stdout.write(
      JSON.stringify({
        state: OPENCLAW_STATE_SCHEMA_VERSION,
        agent: OPENCLAW_AGENT_SCHEMA_VERSION,
      }),
    );
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const input = JSON.parse(
    Buffer.concat(chunks).toString("utf8"),
  ) as MigratedUpdateFinalizationInput; // SAFETY: Only the typed parent continuation serializes this private input.
  const run = input.params.opts.run;
  if (
    !run ||
    (input.params.rollbackBlockedReason !== "state-migrated-no-rollback" &&
      input.params.rollbackBlockedReason !== "rollback-state-unverified")
  ) {
    throw new Error("Candidate finalization requires its migrated update run.");
  }
  for (const step of input.bufferedSteps) {
    recordUpdateRunStep(run.runId, step, { env: run.env });
  }
  let result;
  let exitCode = 0;
  try {
    result = await finishUpdate(input.params);
  } catch (error) {
    if (!(error instanceof UpdateCommandFailure)) {
      throw error;
    }
    result = error.result;
    exitCode = error.exitCode;
  }
  const terminal = getUpdateRun(run.runId, { env: run.env });
  if (!terminal || terminal.status === "running") {
    throw new Error("Candidate finalization left the update run nonterminal.");
  }
  const response: MigratedUpdateFinalizationResult = {
    result,
    exitCode,
    terminalRunId: terminal.runId,
  };
  await fs.writeFile(input.resultPath, JSON.stringify(response), { mode: 0o600 });
}

void finalizeMigratedUpdate()
  .catch((error: unknown) => {
    process.stderr.write(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => closeOpenClawStateDatabase());
