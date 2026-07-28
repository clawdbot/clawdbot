// Gateway wizard session tracker.
// Tracks active setup/onboarding wizard sessions and purges completed ones.
import type { WizardSession } from "../wizard/session.js";

const UNCOLLECTED_TERMINAL_RETENTION_MS = 5 * 60 * 1000;

/** Creates the in-memory tracker used for active Gateway wizard sessions. */
export function createWizardSessionTracker(options?: { now?: () => number }) {
  const wizardSessions = new Map<string, WizardSession>();
  const terminalSince = new Map<string, number>();
  const now = options?.now ?? Date.now;

  const findRunningWizard = (): string | null => {
    for (const [id, session] of wizardSessions) {
      if (session.getStatus() === "running") {
        terminalSince.delete(id);
        return id;
      }
      const observedAt = terminalSince.get(id);
      if (observedAt === undefined) {
        terminalSince.set(id, now());
      } else if (now() - observedAt >= UNCOLLECTED_TERMINAL_RETENTION_MS) {
        // Keep a terminal result long enough for its original client to collect
        // it; later starts may reap only an abandoned retained result.
        wizardSessions.delete(id);
        terminalSince.delete(id);
      }
    }
    return null;
  };

  const purgeWizardSession = (id: string) => {
    const session = wizardSessions.get(id);
    if (!session) {
      return;
    }
    if (session.getStatus() === "running") {
      return;
    }
    wizardSessions.delete(id);
    terminalSince.delete(id);
  };

  return { wizardSessions, findRunningWizard, purgeWizardSession };
}
