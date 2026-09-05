const reloadGuards = new Set<{ canReload: () => boolean; onBlocked: () => void }>();

// Memory-only work can outlive an update or document probe. Its lifecycle owner
// must approve automatic reloads; manual attempts also explain the blocked action.
export function registerControlUiReloadGuard(
  canReload: () => boolean,
  onBlocked: () => void,
): () => void {
  const guard = { canReload, onBlocked };
  reloadGuards.add(guard);
  return () => void reloadGuards.delete(guard);
}

export function canReloadControlUiDocument(reportBlock = false): boolean {
  const blocked = [...reloadGuards].find((guard) => !guard.canReload());
  if (blocked && reportBlock) {
    blocked.onBlocked();
  }
  return !blocked;
}
