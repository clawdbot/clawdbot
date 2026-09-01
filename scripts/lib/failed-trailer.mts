// Keeps wrapper failures visible even when preceding diagnostics are truncated.
function resolveFailedExitCode(
  exitCode: number | string | null | undefined,
): number | undefined {
  if (typeof exitCode === "number" && Number.isFinite(exitCode) && exitCode !== 0) {
    return exitCode;
  }
  if (typeof exitCode === "string" && exitCode.trim() !== "") {
    const parsed = Number(exitCode);
    if (Number.isFinite(parsed) && parsed !== 0) {
      return parsed;
    }
  }
  return undefined;
}

export function writeFailedTrailer(
  tool: string,
  exitCode: number | string | null | undefined,
  log: (value: unknown) => void = console.error,
): void {
  const resolved = resolveFailedExitCode(exitCode);
  if (resolved !== undefined) {
    log(`[${tool}] FAILED (exit ${resolved})`);
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
