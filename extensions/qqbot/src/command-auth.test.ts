/**
 * Regression tests for QQBot command authorization alignment with the shared
 * command-auth model.
 *
 * Covers the regression identified in the code review:
 *
 *   allowFrom entries with the qqbot: prefix must normalize correctly so that
 *   "qqbot:<id>" in channel.allowFrom matches the inbound event.senderId "<id>".
 *   Verified against the normalization logic in the gateway.ts inbound path.
 *
 * Note: commands.allowFrom.qqbot precedence over channel allowFrom is enforced
 * by the framework's resolveCommandAuthorization(). QQBot routes requireAuth:true
 * commands through the framework (api.registerCommand), so that behavior is
 * covered by the framework's own tests rather than duplicated here.
 */

import { describe, expect, it } from "vitest";
import { qqbotPlugin } from "./channel.js";

// ---------------------------------------------------------------------------
// qqbot: prefix normalization for inbound commandAuthorized
//
// Uses qqbotPlugin.config.formatAllowFrom directly — the same function the
// fixed gateway.ts inbound path calls — so the test stays in sync with the
// actual implementation without duplicating the logic.
// ---------------------------------------------------------------------------

describe("qqbot: prefix normalization for inbound commandAuthorized", () => {
  const formatAllowFrom = qqbotPlugin.config.formatAllowFrom!;

  /** Mirrors the fixed gateway.ts inbound commandAuthorized computation. */
  function resolveInboundCommandAuthorized(rawAllowFrom: string[], senderId: string): boolean {
    const normalizedAllowFrom = formatAllowFrom({
      cfg: {} as never,
      accountId: null,
      allowFrom: rawAllowFrom,
    });
    const normalizedSenderId = senderId.replace(/^qqbot:/i, "").toUpperCase();
    const allowAll = normalizedAllowFrom.length === 0 || normalizedAllowFrom.some((e) => e === "*");
    return allowAll || normalizedAllowFrom.includes(normalizedSenderId);
  }

  it("authorizes when allowFrom uses qqbot: prefix and senderId is the bare id", () => {
    expect(resolveInboundCommandAuthorized(["qqbot:USER123"], "USER123")).toBe(true);
  });

  it("authorizes when qqbot: prefix is mixed case", () => {
    expect(resolveInboundCommandAuthorized(["QQBot:user123"], "USER123")).toBe(true);
  });

  it("denies a sender not in the qqbot:-prefixed allowFrom list", () => {
    expect(resolveInboundCommandAuthorized(["qqbot:USER123"], "OTHER")).toBe(false);
  });

  it("authorizes any sender when allowFrom is empty (open)", () => {
    expect(resolveInboundCommandAuthorized([], "ANYONE")).toBe(true);
  });

  it("authorizes any sender when allowFrom contains wildcard *", () => {
    expect(resolveInboundCommandAuthorized(["*"], "ANYONE")).toBe(true);
  });
});
