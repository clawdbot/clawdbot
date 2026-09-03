// Stateful target builtin tests cover repeatable registration after registry drains.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  driver: {
    id: "acp",
    ensureReady: vi.fn(),
    ensureSession: vi.fn(),
  },
  register: vi.fn(),
}));

vi.mock("./acp-stateful-target-driver.js", () => ({
  acpStatefulBindingTargetDriver: mocks.driver,
}));

vi.mock("./stateful-target-drivers.js", () => ({
  registerStatefulBindingTargetDriver: mocks.register,
}));

import { ensureStatefulTargetBuiltinsRegistered } from "./stateful-target-builtins.js";

describe("stateful target builtin registration", () => {
  beforeEach(() => {
    mocks.register.mockClear();
  });

  it("re-registers an already-loaded builtin after its registry is drained", async () => {
    await ensureStatefulTargetBuiltinsRegistered();
    await ensureStatefulTargetBuiltinsRegistered();

    expect(mocks.register).toHaveBeenCalledTimes(2);
    expect(mocks.register).toHaveBeenNthCalledWith(1, mocks.driver);
    expect(mocks.register).toHaveBeenNthCalledWith(2, mocks.driver);
  });
});
