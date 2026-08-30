import { describe, expect, it } from "vitest";
import { assertMatrixQaExpectedBootstrapFailure } from "./scenario-runtime-e2ee-room.js";
import { createMatrixQaBootstrapFailure } from "./scenario-runtime-e2ee.test-helpers.js";

describe("Matrix E2EE bootstrap fault evidence", () => {
  it.each([{ methods: [] }, { methods: ["GET"] }])(
    "rejects a history without creation: %j",
    ({ methods }) => {
      expect(() =>
        assertMatrixQaExpectedBootstrapFailure({
          faultHits: methods.map((method) => ({
            method,
            path: "/room_keys/version",
            ruleId: "backup",
          })),
          result: createMatrixQaBootstrapFailure(),
        }),
      ).toThrow("did not attempt faulted room-key backup creation");
    },
  );

  it("requires both creation evidence and the expected failure", () => {
    const faultHits = [{ method: "POST", path: "/room_keys/version", ruleId: "backup" }];
    const result = createMatrixQaBootstrapFailure();
    expect(assertMatrixQaExpectedBootstrapFailure({ faultHits, result })).toBe(result.error);
    expect(() =>
      assertMatrixQaExpectedBootstrapFailure({
        faultHits,
        result: { ...result, success: true },
      }),
    ).toThrow("unexpectedly succeeded");
    expect(() =>
      assertMatrixQaExpectedBootstrapFailure({
        faultHits,
        result: { ...result, error: "unrelated failure" },
      }),
    ).toThrow("unexpected reason");
  });
});
