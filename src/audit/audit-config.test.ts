import { describe, expect, it } from "vitest";
import {
  isAuditLedgerEnabled,
  isExecutionIdentityCollectionEnabled,
  resolveAuditMessageMode,
} from "./audit-config.js";

describe("isAuditLedgerEnabled", () => {
  it("defaults to enabled without config or audit section", () => {
    expect(isAuditLedgerEnabled(undefined)).toBe(true);
    expect(isAuditLedgerEnabled({})).toBe(true);
    expect(isAuditLedgerEnabled({ logging: { audit: {} } })).toBe(true);
  });

  it("stays enabled on explicit true", () => {
    expect(isAuditLedgerEnabled({ logging: { audit: { enabled: true } } })).toBe(true);
  });

  it("disables only on explicit false", () => {
    expect(isAuditLedgerEnabled({ logging: { audit: { enabled: false } } })).toBe(false);
  });

  it("keeps message metadata off until explicitly enabled", () => {
    expect(resolveAuditMessageMode(undefined)).toBe("off");
    expect(resolveAuditMessageMode({ logging: { audit: {} } })).toBe("off");
    expect(resolveAuditMessageMode({ logging: { audit: { messages: "direct" } } })).toBe("direct");
    expect(resolveAuditMessageMode({ logging: { audit: { messages: "all" } } })).toBe("all");
  });

  it("keeps execution identity off until both switches are explicitly enabled", () => {
    expect(isExecutionIdentityCollectionEnabled(undefined)).toBe(false);
    expect(isExecutionIdentityCollectionEnabled({ logging: { audit: {} } })).toBe(false);
    expect(
      isExecutionIdentityCollectionEnabled({
        logging: { audit: { enabled: true, executionIdentity: true } },
      }),
    ).toBe(true);
    expect(
      isExecutionIdentityCollectionEnabled({
        logging: { audit: { enabled: false, executionIdentity: true } },
      }),
    ).toBe(false);
  });
});
