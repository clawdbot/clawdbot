// Keeps wrapper failures visible even when preceding diagnostics are truncated.
export function writeFailedTrailer(tool, exitCode, log = console.error) {
  if (typeof exitCode === "number" && exitCode !== 0) {
    log(`[${tool}] FAILED (exit ${exitCode})`);
  }
}

export async function runWithFailedTrailer(tool, run, log = console.error) {
  try {
    await run();
  } catch (error) {
    log(error);
    process.exitCode = 1;
  }
  writeFailedTrailer(tool, process.exitCode, log);
}
