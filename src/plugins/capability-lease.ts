export function createPluginRuntimeCapabilityLease(owner: string) {
  let active = true;
  const cleanups = new Set<() => void>();
  const assertActive = (capability: string) => {
    if (!active) {
      throw new Error(`${owner} ${capability} is no longer active`);
    }
  };
  const retain = (cleanup: () => void): (() => void) => {
    if (!active) {
      cleanup();
      assertActive("capability lease");
    }
    const release = () => {
      if (cleanups.delete(release)) {
        cleanup();
      }
    };
    cleanups.add(release);
    return release;
  };
  return {
    isActive: () => active,
    assertActive,
    retain,
    revoke: () => {
      if (!active) {
        return;
      }
      active = false;
      for (const cleanup of cleanups) {
        cleanup();
      }
    },
  };
}

export type PluginRuntimeCapabilityLease = ReturnType<typeof createPluginRuntimeCapabilityLease>;
