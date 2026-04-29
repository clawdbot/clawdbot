function formatImportSideEffectCall(args: readonly unknown[]): string {
  if (args.length === 0) {
    return "(no args)";
  }
  return args
    .map((arg) => {
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(", ");
}

export function assertNoImportTimeSideEffects(params: {
  moduleId: string;
  forbiddenSeam: string;
  calls: readonly (readonly unknown[])[];
  why: string;
  fixHint: string;
}) {
  if (params.calls.length === 0) {
    return;
  }
  const observedCalls = params.calls
    .slice(0, 3)
    .map((call, index) => `  ${index + 1}. ${formatImportSideEffectCall(call)}`)
    .join("\n");
  throw new Error(
    [
      `[runtime contract] ${params.moduleId} touched ${params.forbiddenSeam} during module import.`,
      `why this is banned: ${params.why}`,
      `expected fix: ${params.fixHint}`,
      `observed calls (${params.calls.length}):`,
      observedCalls,
    ].join("\n"),
  );
}
