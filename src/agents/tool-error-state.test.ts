import { describe, expect, it } from "vitest";
import { createToolErrorState } from "./tool-error-state.js";

describe("tool error state", () => {
  it("keeps only the latest failure", () => {
    const first = { toolName: "write", error: "write failed" };
    const latest = { toolName: "message", error: "send failed" };
    const state = createToolErrorState();

    state.recordFailure(first);

    expect(state.recordFailure(latest)).toEqual({ lastToolError: latest });
  });

  it("clears a failure after the same normalized tool succeeds", () => {
    const state = createToolErrorState();
    state.recordFailure({ toolName: " Write ", error: "write failed" });

    expect(state.recordSuccess("WRITE")).toEqual({});
  });

  it("keeps a failure after a different tool succeeds", () => {
    const failure = { toolName: "write", error: "write failed" };
    const state = createToolErrorState();
    state.recordFailure(failure);

    expect(state.recordSuccess("read")).toEqual({ lastToolError: failure });
  });
});
