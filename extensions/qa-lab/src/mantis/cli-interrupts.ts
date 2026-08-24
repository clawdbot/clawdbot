type MantisCliInterrupt = "SIGINT" | "SIGTERM";

const INTERRUPT_EXIT_CODES: Record<MantisCliInterrupt, number> = {
  SIGINT: 130,
  SIGTERM: 143,
};

export async function runWithMantisCliInterrupts(
  run: (signal: AbortSignal) => Promise<void>,
): Promise<void> {
  const abortController = new AbortController();
  let interruptedBy: MantisCliInterrupt | undefined;
  const interrupt = (signal: MantisCliInterrupt) => {
    if (interruptedBy) {
      return;
    }
    interruptedBy = signal;
    abortController.abort(new Error(`Mantis interrupted by ${signal}`));
  };
  const onSigint = () => interrupt("SIGINT");
  const onSigterm = () => interrupt("SIGTERM");

  // Mantis commands own detached POSIX process groups, so retain repeated
  // signal ownership until AbortSignal cleanup finishes.
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  try {
    await run(abortController.signal);
  } catch (error) {
    if (!interruptedBy) {
      throw error;
    }
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    if (interruptedBy) {
      process.exitCode = INTERRUPT_EXIT_CODES[interruptedBy];
    }
  }
}
