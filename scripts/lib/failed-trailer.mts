// Keeps wrapper failures visible even when preceding diagnostics are truncated.
export function writeFailedTrailer(
  tool: string,
  exitCode: number | string | null | undefined,
  log: (value: unknown) => void = console.error,
): void {
  if (typeof exitCode === "number" && exitCode !== 0) {
    log(`[${tool}] FAILED (exit ${exitCode})`);
  }
}

export async function runWithFailedTrailer(
  tool: string,
  run: () => void | Promise<void>,
  log: (value: unknown) => void = console.error,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    log(error);
    process.exitCode = 1;
  }
  writeFailedTrailer(tool, process.exitCode, log);
}
