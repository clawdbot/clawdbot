import { describe, expect, it } from "vitest";
import { resolveMatrixQaRoomObserverRole } from "./topology.js";

describe("Matrix QA topology", () => {
  it("prefers the driver when the driver belongs to the room", () => {
    expect(
      resolveMatrixQaRoomObserverRole({
        key: "main",
        memberRoles: ["driver", "observer", "sut"],
      }),
    ).toBe("driver");
  });

  it("uses the observer for rooms that exclude the driver", () => {
    expect(
      resolveMatrixQaRoomObserverRole({
        key: "bot-dm",
        memberRoles: ["observer", "sut"],
      }),
    ).toBe("observer");
  });

  it("rejects rooms that have no independent observer", () => {
    expect(() =>
      resolveMatrixQaRoomObserverRole({ key: "sut-only", memberRoles: ["sut"] }),
    ).toThrow('Matrix QA room "sut-only" has no independent observer member');
  });
});
