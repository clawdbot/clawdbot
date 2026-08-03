import "./audit.js";
import type { AuditRunInspectResult } from "../../packages/gateway-protocol/src/index.js";

type AuditTestEvent = {
  occurredAt: number;
  kind: string;
  status: string;
  action: string;
  direction?: string;
  channel?: string;
  agentId?: string;
  runId?: string;
  toolName?: string;
};

type AuditCommandTestApi = {
  formatAuditRunInspection(result: AuditRunInspectResult): string[];
  formatAuditRows(events: readonly AuditTestEvent[]): string[];
  hasExplainIncompatibleFilters(options: Record<string, unknown>): boolean;
  parseAuditDecisionLimit(value: string | undefined): number;
  parseAuditExecutionLimit(value: string | undefined): number;
  parseAuditLimit(value: string | undefined): number;
  parseAuditTimestamp(value: string | undefined, flag: string): number | undefined;
};

function getTestApi(): AuditCommandTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.auditCommandTestApi")
  ] as AuditCommandTestApi;
}

export const testApi: AuditCommandTestApi = {
  formatAuditRunInspection(result) {
    return getTestApi().formatAuditRunInspection(result);
  },
  formatAuditRows(events) {
    return getTestApi().formatAuditRows(events);
  },
  hasExplainIncompatibleFilters(options) {
    return getTestApi().hasExplainIncompatibleFilters(options);
  },
  parseAuditDecisionLimit(value) {
    return getTestApi().parseAuditDecisionLimit(value);
  },
  parseAuditExecutionLimit(value) {
    return getTestApi().parseAuditExecutionLimit(value);
  },
  parseAuditLimit(value) {
    return getTestApi().parseAuditLimit(value);
  },
  parseAuditTimestamp(value, flag) {
    return getTestApi().parseAuditTimestamp(value, flag);
  },
};
