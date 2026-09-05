import { vi } from "vitest";

export function createTrackedRouteLease() {
  let active = true;
  const cleanups = new Set<() => void>();
  const lease = {
    isActive: () => active,
    retain: vi.fn((cleanup: () => void) => {
      const release = () => {
        if (cleanups.delete(release)) {
          cleanup();
        }
      };
      cleanups.add(release);
      return release;
    }),
  };
  return {
    lease,
    cleanups,
    revoke: () => {
      active = false;
      for (const cleanup of cleanups) {
        cleanup();
      }
    },
  };
}
