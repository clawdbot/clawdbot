import "./audit.js";

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
  formatAuditRows(events: readonly AuditTestEvent[]): string[];
  parseAuditLimit(value: string | undefined): number;
  parseAuditTimestamp(value: string | undefined, flag: string): number | undefined;
};

function getTestApi(): AuditCommandTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.auditCommandTestApi")
  ] as AuditCommandTestApi;
}

export const testApi: AuditCommandTestApi = {
  formatAuditRows(events) {
    return getTestApi().formatAuditRows(events);
  },
  parseAuditLimit(value) {
    return getTestApi().parseAuditLimit(value);
  },
  parseAuditTimestamp(value, flag) {
    return getTestApi().parseAuditTimestamp(value, flag);
  },
};
