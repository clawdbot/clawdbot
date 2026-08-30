/** Inputs used to format native dependency install/rebuild guidance. */
type NativeDependencyHintParams = {
  packageName: string;
  manager?: "pnpm" | "npm" | "yarn";
  rebuildCommand?: string;
  approveBuildsCommand?: string;
  downloadCommand?: string;
};

/** Formats concise guidance for installing and rebuilding a native dependency. */
export function formatNativeDependencyHint(params: NativeDependencyHintParams): string {
  const manager = params.manager ?? "pnpm";
  const rebuildCommand =
    params.rebuildCommand ??
    (manager === "npm"
      ? `npm rebuild ${params.packageName}`
      : manager === "yarn"
        ? `yarn rebuild ${params.packageName}`
        : `pnpm rebuild ${params.packageName}`);
  const approveBuildsCommand =
    params.approveBuildsCommand ??
    (manager === "pnpm" ? `pnpm approve-builds (select ${params.packageName})` : undefined);
  const steps = [approveBuildsCommand, rebuildCommand, params.downloadCommand].filter(
    (step): step is string => Boolean(step),
  );
  if (steps.length === 0) {
    return `Install ${params.packageName} and rebuild its native module.`;
  }
  return `Install ${params.packageName} and rebuild its native module (${steps.join("; ")}).`;
}
