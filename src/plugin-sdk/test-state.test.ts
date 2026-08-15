import { describe, expect, it } from "vitest";
import {
  createOpenClawTestState as createOpenClawTestStateDirect,
  withOpenClawTestState as withOpenClawTestStateDirect,
} from "../test-utils/openclaw-test-state.js";
import { createOpenClawTestState, withOpenClawTestState } from "./test-state.js";

describe("test-state SDK seam", () => {
  it("re-exports the canonical isolated state lifecycle", () => {
    expect(createOpenClawTestState).toBe(createOpenClawTestStateDirect);
    expect(withOpenClawTestState).toBe(withOpenClawTestStateDirect);
  });
});
