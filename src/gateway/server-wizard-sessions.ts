// Gateway wizard session tracker.
// Tracks active setup/onboarding wizard sessions and purges completed ones.
import { randomUUID } from "node:crypto";
import type { WizardSession } from "../wizard/session.js";

const UNCOLLECTED_TERMINAL_RETENTION_MS = 5 * 60 * 1000;

/** Creates the in-memory tracker used for active Gateway wizard sessions. */
export function createWizardSessionTracker(options?: { now?: () => number }) {
  const wizardSessions = new Map<
    string,
    { session: WizardSession; ownerConnId: string | undefined }
  >();
  const terminalSince = new Map<string, number>();
  const now = options?.now ?? Date.now;

  const trackWizardSession = (
    session: WizardSession,
    ownerConnId: string | undefined,
    requestedSessionId?: string,
  ): string | null => {
    const sessionId = requestedSessionId ?? randomUUID();
    if (wizardSessions.has(sessionId)) {
      return null;
    }
    wizardSessions.set(sessionId, { session, ownerConnId });
    return sessionId;
  };

  const findOwnedWizardSession = (
    sessionId: string,
    requesterConnId: string | undefined,
  ): WizardSession | undefined => {
    const tracked = wizardSessions.get(sessionId);
    // The session id is correlation only; wizard authority stays on the exact starting socket.
    return tracked && tracked.ownerConnId === requesterConnId ? tracked.session : undefined;
  };

  const findRunningWizard = (): string | null => {
    for (const [id, { session }] of wizardSessions) {
      if (!session.isSettled()) {
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
    const tracked = wizardSessions.get(id);
    if (!tracked) {
      return;
    }
    if (!tracked.session.isSettled()) {
      return;
    }
    wizardSessions.delete(id);
    terminalSince.delete(id);
  };

  const handleWizardDisconnect = (connId: string): void => {
    // Socket closure ends authority synchronously; settlement keeps admission cleanup ordered.
    for (const [sessionId, tracked] of wizardSessions) {
      if (tracked.ownerConnId !== connId) {
        continue;
      }
      tracked.session.cancel();
      const purge = () => purgeWizardSession(sessionId);
      void tracked.session.whenSettled().then(purge, purge);
    }
  };

  return {
    wizardSessions,
    trackWizardSession,
    findOwnedWizardSession,
    findRunningWizard,
    purgeWizardSession,
    handleWizardDisconnect,
  };
}

export type GatewayWizardSessionTracker = ReturnType<typeof createWizardSessionTracker>;
