/** Process-local admission for visible child starts awaiting registry insertion. */
const pendingVisibleChildren = new Map<string, number>();

type VisibleChildReservation =
  | { ok: false; activeChildren: number }
  | { ok: true; release: () => void };

export function reserveVisibleChildSlot(params: {
  controllerSessionKey: string;
  maxChildren: number;
  countActiveRuns: (sessionKey: string) => number;
}): VisibleChildReservation {
  const pending = pendingVisibleChildren.get(params.controllerSessionKey) ?? 0;
  const activeChildren = params.countActiveRuns(params.controllerSessionKey) + pending;
  if (activeChildren >= params.maxChildren) {
    return { ok: false, activeChildren };
  }
  pendingVisibleChildren.set(params.controllerSessionKey, pending + 1);
  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) {
        return;
      }
      released = true;
      const next = (pendingVisibleChildren.get(params.controllerSessionKey) ?? 1) - 1;
      if (next > 0) {
        pendingVisibleChildren.set(params.controllerSessionKey, next);
      } else {
        pendingVisibleChildren.delete(params.controllerSessionKey);
      }
    },
  };
}
