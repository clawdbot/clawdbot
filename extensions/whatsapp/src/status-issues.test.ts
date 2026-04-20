import { describe, expect, it } from "vitest";
import { collectWhatsAppStatusIssues } from "./status-issues.js";

describe("collectWhatsAppStatusIssues", () => {
  it("reports unlinked enabled accounts", () => {
    const issues = collectWhatsAppStatusIssues([
      {
        accountId: "default",
        enabled: true,
        linked: false,
      },
    ]);

    expect(issues).toEqual([
      expect.objectContaining({
        channel: "whatsapp",
        accountId: "default",
        kind: "auth",
      }),
    ]);
  });

  it("reports auth reads that are still stabilizing", () => {
    const issues = collectWhatsAppStatusIssues([
      {
        accountId: "default",
        enabled: true,
        statusState: "unstable",
      },
    ]);

    expect(issues).toEqual([
      expect.objectContaining({
        channel: "whatsapp",
        accountId: "default",
        kind: "auth",
        message: "Auth state is still stabilizing.",
      }),
    ]);
  });

  it("reports linked but disconnected runtime state", () => {
    const issues = collectWhatsAppStatusIssues([
      {
        accountId: "work",
        enabled: true,
        linked: true,
        running: true,
        connected: false,
        reconnectAttempts: 2,
        lastError: "socket closed",
      },
    ]);

    expect(issues).toEqual([
      expect.objectContaining({
        channel: "whatsapp",
        accountId: "work",
        kind: "runtime",
        message: "Linked but disconnected (reconnectAttempts=2): socket closed",
      }),
    ]);
  });

  it("reports linked but stale runtime state even while connected", () => {
    const issues = collectWhatsAppStatusIssues([
      {
        accountId: "default",
        enabled: true,
        linked: true,
        running: true,
        connected: true,
        healthState: "stale",
        lastInboundAt: Date.now() - 2 * 60_000,
      },
    ]);

    expect(issues).toEqual([
      expect.objectContaining({
        channel: "whatsapp",
        accountId: "default",
        kind: "runtime",
        message: expect.stringContaining("Linked but stale"),
      }),
    ]);
  });
});
