import { performance } from "node:perf_hooks";
import { areDiagnosticsEnabledForProcess } from "../../infra/diagnostic-events.js";
import { sessionLog } from "./sessions-shared.js";

const SLOW_SESSION_PATCH_MS = 1_000;
const PHASES = [
  "preflight",
  "archive",
  "lifecycleAdmission",
  "snapshot",
  "projection",
  "catalog",
  "worktree",
  "commit",
  "worktreeCleanup",
  "permissions",
  "lifecycleFinalize",
  "cleanup",
  "effects",
  "response",
] as const;
type SessionPatchPhase = (typeof PHASES)[number];
type PhaseScope = { mark: (phase?: SessionPatchPhase) => void; finish: () => void };

export type SessionPatchDiagnostics = NonNullable<ReturnType<typeof startSessionPatchDiagnostics>>;

/** Fixed, request-owned elapsed totals. Parallel and nested phases can overlap. */
export function startSessionPatchDiagnostics(method: "sessions.patch" | "sessions.patchMany") {
  if (!areDiagnosticsEnabledForProcess()) {
    return undefined;
  }
  const startedAt = performance.now();
  const totals = new Map<SessionPatchPhase, { elapsedMs: number; count: number }>();
  const scopes = new Set<PhaseScope>();
  let finished = false;
  return {
    scope(initialPhase: SessionPatchPhase): PhaseScope | undefined {
      if (finished) {
        return undefined;
      }
      let phase: SessionPatchPhase | undefined = initialPhase;
      let phaseStartedAt = performance.now();
      let closed = false;
      const scope: PhaseScope = {
        mark(nextPhase) {
          if (closed || finished) {
            return;
          }
          const now = performance.now();
          if (phase) {
            const total = totals.get(phase) ?? { elapsedMs: 0, count: 0 };
            total.elapsedMs += now - phaseStartedAt;
            total.count++;
            totals.set(phase, total);
          }
          phase = nextPhase;
          phaseStartedAt = now;
        },
        finish() {
          if (closed) {
            return;
          }
          scope.mark();
          closed = true;
          scopes.delete(scope);
        },
      };
      scopes.add(scope);
      return scope;
    },
    finish() {
      if (finished) {
        return;
      }
      // Exceptions close unfinished scopes; no timer or process-global request state survives.
      for (const scope of scopes) {
        scope.finish();
      }
      finished = true;
      if (!areDiagnosticsEnabledForProcess()) {
        return;
      }
      const elapsedMs = performance.now() - startedAt;
      if (elapsedMs < SLOW_SESSION_PATCH_MS) {
        return;
      }
      const entries = PHASES.flatMap((phase) => {
        const total = totals.get(phase);
        return total ? [[phase, total] as const] : [];
      });
      try {
        // The existing logger captures the caller's trace, never session keys or patch values.
        sessionLog.info("slow session patch", {
          method,
          elapsedMs: Math.round(elapsedMs),
          phaseDurationsMs: Object.fromEntries(
            entries.map(([phase, total]) => [phase, Math.round(total.elapsedMs)]),
          ),
          phaseCounts: Object.fromEntries(entries.map(([phase, total]) => [phase, total.count])),
        });
      } catch {
        // A diagnostic sink must not replace the mutation's result or original error.
      }
    },
  };
}
