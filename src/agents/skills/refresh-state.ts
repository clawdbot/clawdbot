export type SkillsChangeEvent = {
  workspaceDir?: string;
  reason: "watch" | "manual" | "remote-node" | "config-change";
  changedPath?: string;
};

const listeners = new Set<(event: SkillsChangeEvent) => void>();
const workspaceVersions = new Map<string, number>();
let globalVersion = 0;
let listenerErrorHandler: ((err: unknown) => void) | undefined;

function bumpVersion(current: number): number {
  const now = Date.now();
  return now <= current ? current + 1 : now;
}

function emit(event: SkillsChangeEvent) {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (err) {
      listenerErrorHandler?.(err);
    }
  }
}

export function setSkillsChangeListenerErrorHandler(handler?: (err: unknown) => void): void {
  listenerErrorHandler = handler;
}

export function registerSkillsChangeListener(listener: (event: SkillsChangeEvent) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function bumpSkillsSnapshotVersion(params?: {
  workspaceDir?: string;
  reason?: SkillsChangeEvent["reason"];
  changedPath?: string;
}): number {
  const reason = params?.reason ?? "manual";
  const changedPath = params?.changedPath;
  if (params?.workspaceDir) {
    const current = workspaceVersions.get(params.workspaceDir) ?? 0;
    const next = bumpVersion(current);
    workspaceVersions.set(params.workspaceDir, next);
    emit({ workspaceDir: params.workspaceDir, reason, changedPath });
    return next;
  }
  globalVersion = bumpVersion(globalVersion);
  emit({ reason, changedPath });
  return globalVersion;
}

export function getSkillsSnapshotVersion(workspaceDir?: string): number {
  if (!workspaceDir) {
    return globalVersion;
  }
  const local = workspaceVersions.get(workspaceDir) ?? 0;
  return Math.max(globalVersion, local);
}

export function shouldRefreshSnapshotForVersion(
  cachedVersion?: number,
  nextVersion?: number,
): boolean {
  const cached = typeof cachedVersion === "number" ? cachedVersion : 0;
  const next = typeof nextVersion === "number" ? nextVersion : 0;
  return next === 0 ? cached > 0 : cached < next;
}

export function resetSkillsRefreshStateForTest(): void {
  listeners.clear();
  workspaceVersions.clear();
  globalVersion = 0;
  listenerErrorHandler = undefined;
}
