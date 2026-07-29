// Account action gate tests cover channel account action visibility and enablement checks.
import { describe, expect, it } from "vitest";
import { createAccountActionGate } from "./account-action-gate.js";

type TestActions = {
  send?: boolean;
  reactions?: boolean;
};

describe("createAccountActionGate", () => {
  it("prefers account action values over base values", () => {
    const gate = createAccountActionGate<TestActions>({
      baseActions: { send: false, reactions: true },
      accountActions: { send: true },
    });
    expect(gate("send")).toBe(true);
  });

  it("falls back to base actions when account actions are unset", () => {
    const gate = createAccountActionGate<TestActions>({
      baseActions: { reactions: false },
      accountActions: {},
    });
    expect(gate("reactions")).toBe(false);
  });

  it("uses default value when neither account nor base defines the key", () => {
    const gate = createAccountActionGate<TestActions>({
      baseActions: {},
      accountActions: {},
    });
    expect(gate("send", false)).toBe(false);
    expect(gate("send")).toBe(true);
  });
});
