// Pairing adapter tests cover channel plugin device/account pairing adapter behavior.
import { describe, expect, it, vi } from "vitest";
import {
  createLoggedPairingApprovalNotifier,
  createPairingPrefixStripper,
  createTextPairingAdapter,
} from "./pairing-adapters.js";

describe("pairing adapters", () => {
  it("strips prefixes and applies optional mapping", () => {
    const strip = createPairingPrefixStripper(/^(telegram|tg):/i);
    const lower = createPairingPrefixStripper(/^nextcloud:/i, (entry) => entry.toLowerCase());
    expect(strip("telegram:123")).toBe("123");
    expect(strip("tg:123")).toBe("123");
    expect(strip("  telegram:123  ")).toBe("123");
    expect(lower("nextcloud:USER")).toBe("user");
    expect(lower("  nextcloud:USER  ")).toBe("user");
  });

  it("builds text pairing adapters", async () => {
    const notify = vi.fn(async () => {});
    const pairing = createTextPairingAdapter({
      idLabel: "telegramUserId",
      message: "approved",
      normalizeAllowEntry: createPairingPrefixStripper(/^telegram:/i),
      notify,
    });
    expect(pairing.idLabel).toBe("telegramUserId");
    expect(pairing.normalizeAllowEntry?.("telegram:123")).toBe("123");
    await pairing.notifyApproval?.({ cfg: {}, id: "123" });
    expect(notify).toHaveBeenCalledWith({ cfg: {}, id: "123", message: "approved" });
  });

  it("builds logger-backed approval notifiers", async () => {
    const log = vi.fn();
    const notify = createLoggedPairingApprovalNotifier(({ id }) => `approved ${id}`, log);
    await notify({ cfg: {}, id: "u-1" });
    expect(log).toHaveBeenCalledWith("approved u-1");
  });
});
