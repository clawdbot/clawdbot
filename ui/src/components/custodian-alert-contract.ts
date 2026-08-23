import type { NavigationRouteId } from "../app-navigation.ts";

export type CustodianAlertAction =
  | { kind: "update" }
  | { kind: "navigate"; routeId: NavigationRouteId };

export type CustodianAlert = {
  /** Stable per incident; the store asks the agent at most once per id. */
  id: string;
  title: string;
  /** Raw facts, rendered before any model output. Never empty. */
  facts: readonly string[];
  /** Prompt sent to the system agent. */
  question: string;
  action?: { label: string; target: CustodianAlertAction };
};
