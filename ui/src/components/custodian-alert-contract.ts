import type { NavigationRouteId } from "../app-navigation.ts";

export type CustodianAlertAction =
  | { kind: "update" }
  | { kind: "navigate"; routeId: NavigationRouteId };

export type CustodianTurnAdmission = {
  isCurrent: () => boolean;
  admit: () => boolean;
};

export type CustodianAlert = {
  /** Stable per incident; automatic callers also supply an admission owner. */
  id: string;
  title: string;
  /** Raw facts, rendered before any model output. Never empty. */
  facts: readonly string[];
  /** Prompt sent to the system agent. */
  question: string;
  action?: { label: string; target: CustodianAlertAction };
};
