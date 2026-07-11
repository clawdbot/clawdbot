import { describe, expect, it } from "vitest";
import { isAuditLedgerEnabled, resolveAuditMessageMode } from "./audit-config.js";

describe("isAuditLedgerEnabled", () => {
  it("defaults to enabled without config or audit section", () => {
    expect(isAuditLedgerEnabled(undefined)).toBe(true);
    expect(isAuditLedgerEnabled({})).toBe(true);
    expect(isAuditLedgerEnabled({ audit: {} })).toBe(true);
  });

  it("stays enabled on explicit true", () => {
    expect(isAuditLedgerEnabled({ audit: { enabled: true } })).toBe(true);
  });

  it("disables only on explicit false", () => {
    expect(isAuditLedgerEnabled({ audit: { enabled: false } })).toBe(false);
  });

  it("keeps message metadata off until explicitly enabled", () => {
    expect(resolveAuditMessageMode(undefined)).toBe("off");
    expect(resolveAuditMessageMode({ audit: {} })).toBe("off");
    expect(resolveAuditMessageMode({ audit: { messages: "direct" } })).toBe("direct");
    expect(resolveAuditMessageMode({ audit: { messages: "all" } })).toBe("all");
  });
});
