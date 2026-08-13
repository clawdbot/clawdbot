import { describe, expect, it } from "vitest";
import { normalizeCompatibilityConfig } from "./doctor-contract.js";

describe("ClickClack doctor contract", () => {
  it("strips root and account timeout tuning", () => {
    const result = normalizeCompatibilityConfig({
      cfg: {
        channels: {
          clickclack: {
            timeoutSeconds: 1,
            reconnectMs: 2,
            accounts: { work: { timeoutSeconds: 3, reconnectMs: 4 } },
          },
        },
      } as never,
    });

    expect((result.config.channels as Record<string, unknown>).clickclack).toEqual({
      reconnectMs: 2,
      accounts: { work: { reconnectMs: 4 } },
    });
    expect(result.changes).toEqual(["Removed retired ClickClack timeout tuning knobs."]);
  });
});
