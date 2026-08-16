type WorkspaceQuiescenceResumeScriptOptions = {
  processScript: string;
  leaseScript: string;
  processProbeConcurrency: number;
  operatorRecoveryExitCode: number;
};

export function createWorkspaceQuiescenceResumeScript(
  options: WorkspaceQuiescenceResumeScriptOptions,
): string {
  return String.raw`const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
if (typeof process.getuid !== "function") throw new Error("workspace quiescence requires POSIX");
const root = fs.realpathSync(process.argv[1]);
const nonce = process.argv[2];
if (!/^[a-f0-9]{32}$/.test(nonce || "")) throw new Error("invalid workspace quiescence nonce");
const leasePath = path.join(os.homedir(), ".openclaw-worker", "quiescence", crypto.createHash("sha256").update(root).digest("hex") + "." + nonce + ".json");
${options.processScript}
${options.leaseScript}
async function resume() {
  let raw;
  try {
    raw = fs.readFileSync(leasePath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return;
    throw error;
  }
  const input = parseLease(raw, nonce); if (input.recovery !== undefined) throw new WorkspaceOperatorRecoveryError("workspace quiescence recovery " + (input.recovery.state === "recovery-failed" ? "failed" : "timed out") + "; lease retained for operator recovery");
  const references = [
    ...(input.watchdog === null ? [] : [{ ...input.watchdog, signal: "SIGTERM" }]),
    ...input.processes.map((entry) => ({ ...entry, signal: "SIGCONT" })),
  ];
  const recovery = await recoverProcessReferences(
    references,
    ${options.processProbeConcurrency},
    processReferenceDeadlineMs(references.length),
  );
  if (recovery.remaining.length > 0) {
    const watchdog = recovery.remaining.find((entry) => entry.signal === "SIGTERM") ?? null;
    const processes = recovery.remaining
      .filter((entry) => entry.signal === "SIGCONT")
      .map(({ pid, start }) => ({ pid, start }));
    persistLease(
      leasePath,
      {
        ...input,
        processes,
        watchdog: watchdog === null ? null : { pid: watchdog.pid, start: watchdog.start },
        recovery: {
          state: recovery.failed ? "recovery-failed" : "probe-timeout",
          failedAtMs: Date.now(),
        },
      },
      (current) => {
        if (
          current.nonce !== input.nonce ||
          current.expiresAtMs !== input.expiresAtMs ||
          current.watchdog?.pid !== input.watchdog?.pid ||
          current.watchdog?.start !== input.watchdog?.start ||
          !sameProcessReferences(current.processes, input.processes)
        ) {
          throw new Error("workspace quiescence lease changed during operator recovery");
        }
      },
    );
    const failure = recovery.failed ? "failed" : "timed out";
    throw new WorkspaceOperatorRecoveryError("workspace quiescence recovery " + failure + "; lease retained for operator recovery");
  }
  fs.unlinkSync(leasePath);
}
void resume().catch((error) => {
  console.error(error); process.exitCode = error instanceof WorkspaceOperatorRecoveryError ? ${options.operatorRecoveryExitCode} : 1;
});
`;
}
