import { describe, expect, it } from "vitest";
import {
  isProviderStatusTerminal,
  mapProviderStatusToEndReason,
  normalizeProviderStatus,
} from "./call-status.js";

describe("provider call status mapping", () => {
  it("normalizes missing statuses to unknown", () => {
    expect(normalizeProviderStatus(undefined)).toBe("unknown");
    expect(normalizeProviderStatus("  ")).toBe("unknown");
  });

  it("maps terminal provider statuses to end reasons", () => {
    expect(mapProviderStatusToEndReason("completed")).toBe("completed");
    expect(mapProviderStatusToEndReason("CANCELED")).toBe("hangup-bot");
    expect(mapProviderStatusToEndReason("no-answer")).toBe("no-answer");
  });

  it("flags terminal provider statuses", () => {
    expect(isProviderStatusTerminal("busy")).toBe(true);
    expect(isProviderStatusTerminal("in-progress")).toBe(false);
  });
});
