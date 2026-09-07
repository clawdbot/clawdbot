/**
 * Shared writable-target resolution for sandbox fs bridge rename operations.
 */
/** Resolves both rename endpoints and verifies write access before command execution. */
export function resolveWritableRenameTargets<T extends { containerPath: string }>(params: {
  from: string;
  to: string;
  cwd?: string;
  action?: string;
  resolveTarget: (params: { filePath: string; cwd?: string }) => T;
  ensureWritable: (target: T, action: string) => void;
}): { from: T; to: T } {
  const action = params.action ?? "rename files";
  const from = params.resolveTarget({ filePath: params.from, cwd: params.cwd });
  const to = params.resolveTarget({ filePath: params.to, cwd: params.cwd });
  params.ensureWritable(from, action);
  params.ensureWritable(to, action);
  return { from, to };
}

/** Adapter used by bridge implementations that pass resolver callbacks separately. */
export function resolveWritableRenameTargetsForBridge<T extends { containerPath: string }>(
  params: {
    from: string;
    to: string;
    cwd?: string;
    action?: string;
  },
  resolveTarget: (params: { filePath: string; cwd?: string }) => T,
  ensureWritable: (target: T, action: string) => void,
): { from: T; to: T } {
  return resolveWritableRenameTargets({
    ...params,
    resolveTarget,
    ensureWritable,
  });
}

/** Creates a reusable resolver bound to a bridge's target and permission helpers. */
export function createWritableRenameTargetResolver<T extends { containerPath: string }>(
  resolveTarget: (params: { filePath: string; cwd?: string }) => T,
  ensureWritable: (target: T, action: string) => void,
): (params: { from: string; to: string; cwd?: string }) => { from: T; to: T } {
  return (params) => resolveWritableRenameTargetsForBridge(params, resolveTarget, ensureWritable);
}
