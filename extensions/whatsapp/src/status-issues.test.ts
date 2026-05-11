import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectWhatsAppStatusIssues } from "./status-issues.js";

describe("collectWhatsAppStatusIssues", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_CONTAINER_HINT", "");
    vi.stubEnv("OPENCLAW_PROFILE", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reports unlinked enabled accounts", () => {
    const issues = collectWhatsAppStatusIssues([
      {
        accountId: "default",
        enabled: true,
        linked: false,
      },
    ]);

    expect(issues).toEqual([
      {
        channel: "whatsapp",
        accountId: "default",
        kind: "auth",
        message: "Not linked (no WhatsApp Web session).",
        fix: "Run: openclaw channels login (scan QR on the gateway host).",
      },
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
      {
        channel: "whatsapp",
        accountId: "default",
        kind: "auth",
        message: "Auth state is still stabilizing.",
        fix: "Wait a moment for queued credential writes to finish, then retry the command or rerun health.",
      },
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
      {
        channel: "whatsapp",
        accountId: "work",
        kind: "runtime",
        message: "Linked but disconnected (reconnectAttempts=2): socket closed",
        fix: "Run: openclaw doctor (or restart the gateway). If it persists, relink via channels login and check logs.",
      },
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
      {
        channel: "whatsapp",
        accountId: "default",
        kind: "runtime",
        message: "Linked but stale (last inbound 2m ago).",
        fix: "Run: openclaw doctor (or restart the gateway). If it persists, relink via channels login and check logs.",
      },
    ]);
  });

  it("reports recently reconnected accounts even when the socket is currently healthy", () => {
    const issues = collectWhatsAppStatusIssues([
      {
        accountId: "default",
        enabled: true,
        linked: true,
        running: true,
        connected: true,
        reconnectAttempts: 3,
        healthState: "healthy",
        lastDisconnect: {
          at: Date.now() - 2 * 60_000,
          status: 408,
          error: "status=408 Request Time-out Connection was lost",
        },
      },
    ]);

    expect(issues).toEqual([
      {
        channel: "whatsapp",
        accountId: "default",
        kind: "runtime",
        message:
          "Linked but recently reconnected (reconnectAttempts=3): status=408 Request Time-out Connection was lost",
        fix: "Watch: openclaw logs --follow and run openclaw channels status --probe if disconnects continue. If it keeps flapping, restart the gateway or relink via channels login.",
      },
    ]);
  });

  it("does not report old reconnect history after a stable healthy period", () => {
    const issues = collectWhatsAppStatusIssues([
      {
        accountId: "default",
        enabled: true,
        linked: true,
        running: true,
        connected: true,
        reconnectAttempts: 1,
        healthState: "healthy",
        lastDisconnect: {
          at: Date.now() - 60 * 60_000,
          status: 408,
          error: "old disconnect",
        },
      },
    ]);

    expect(issues).toStrictEqual([]);
  });
});
