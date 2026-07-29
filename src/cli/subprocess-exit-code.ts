import { constants as osConstants } from "node:os";

export function resolveSubprocessExitCode(
  exitCode: number | null | undefined,
  signal: NodeJS.Signals | null | undefined,
): number {
  if (typeof exitCode === "number") {
    return exitCode;
  }
  const signalNumber = signal ? (osConstants.signals as Record<string, number>)[signal] : undefined;
  return typeof signalNumber === "number" ? 128 + signalNumber : 1;
}
