import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelegramMiniAppLaunchTickets } from "./launch-ticket.js";

describe("Telegram Mini App launch tickets", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("binds one use to the issuing account and owner", () => {
    const tickets = createTelegramMiniAppLaunchTickets();
    const ticket = tickets.issue({ accountId: "ops", userId: "123" });

    expect(tickets.consume({ ticket, accountId: "default", userId: "123" })).toBe(false);
    expect(tickets.consume({ ticket, accountId: "ops", userId: "999" })).toBe(false);
    expect(tickets.consume({ ticket, accountId: "ops", userId: "123" })).toBe(true);
    expect(tickets.consume({ ticket, accountId: "ops", userId: "123" })).toBe(false);
  });

  it("expires after five minutes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T12:00:00Z"));
    const tickets = createTelegramMiniAppLaunchTickets();
    const ticket = tickets.issue({ accountId: "default", userId: "123" });

    vi.advanceTimersByTime(5 * 60_000);

    expect(tickets.consume({ ticket, accountId: "default", userId: "123" })).toBe(false);
  });

  it("evicts the oldest ticket at the capacity limit", () => {
    const tickets = createTelegramMiniAppLaunchTickets();
    const oldest = tickets.issue({ accountId: "default", userId: "123" });
    for (let index = 0; index < 1000; index += 1) {
      tickets.issue({ accountId: "default", userId: "123" });
    }

    expect(tickets.consume({ ticket: oldest, accountId: "default", userId: "123" })).toBe(false);
  });

  it("invalidates tickets when the plugin lifecycle restarts", () => {
    const firstLifecycle = createTelegramMiniAppLaunchTickets();
    const ticket = firstLifecycle.issue({ accountId: "default", userId: "123" });
    const nextLifecycle = createTelegramMiniAppLaunchTickets();

    expect(nextLifecycle.consume({ ticket, accountId: "default", userId: "123" })).toBe(false);
  });
});
