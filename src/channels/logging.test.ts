import { describe, expect, it, vi } from "vitest";
import { logInboundDrop } from "./logging.js";

describe("logInboundDrop", () => {
  it("deduplicates scoped drops without suppressing other accounts, chats, reasons, or channels", () => {
    const log = vi.fn();
    const drop = {
      log,
      channel: "test",
      reason: "no mention",
      target: "room",
      onceKey: '["a","room"]',
      hint: "Mention the agent.",
    };
    logInboundDrop(drop);
    logInboundDrop(drop);
    expect(log).toHaveBeenCalledExactlyOnceWith(
      "test: drop no mention target=room. Mention the agent.",
    );
    logInboundDrop({ ...drop, onceKey: '["b","room"]' });
    logInboundDrop({ ...drop, onceKey: '["a","other-room"]' });
    logInboundDrop({ ...drop, reason: "not allowed" });
    logInboundDrop({ ...drop, channel: "other" });
    expect(log).toHaveBeenCalledTimes(5);
  });

  it("preserves per-message logging unless deduplication is requested", () => {
    const log = vi.fn();
    const drop = { log, channel: "test", reason: "no mention" };
    logInboundDrop(drop);
    logInboundDrop(drop);
    expect(log.mock.calls).toEqual([["test: drop no mention"], ["test: drop no mention"]]);
  });

  it("bounds warning memory while retaining recently used scopes", () => {
    const log = vi.fn();
    const drop = (onceKey: string) =>
      logInboundDrop({ log, channel: "bounded", reason: "no mention", onceKey });
    for (let i = 0; i < 512; i++) {
      drop(String(i));
    }
    drop("0");
    drop("512");
    drop("0");
    drop("1");
    expect(log).toHaveBeenCalledTimes(514);
  });
});
