import {
  readUpdateStateSchemaVersionsInProcess,
  snapshotUpdateCandidateState,
} from "./update-candidate-state.js";

// Internal one-shot subprocess: a hard process deadline can interrupt SQLite
// integrity checks and backup/VACUUM, which expose no AbortSignal contract.
async function snapshotCandidateState(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  // SAFETY: Only the updater's typed snapshot/versions launchers serialize this private worker's stdin.
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as
    | (Parameters<typeof snapshotUpdateCandidateState>[0] & { mode: "snapshot" })
    | (Parameters<typeof readUpdateStateSchemaVersionsInProcess>[0] & { mode: "versions" });
  if (input.mode !== "snapshot" && input.mode !== "versions") {
    throw new Error("Unknown update state inspection mode");
  }
  const versions =
    input.mode === "snapshot"
      ? await snapshotUpdateCandidateState(input)
      : await readUpdateStateSchemaVersionsInProcess(input);
  process.stdout.write(JSON.stringify(versions));
}

void snapshotCandidateState().catch((error: unknown) => {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
