import { describe, expect, it } from "vitest";
import { resolveSessionStoreTargets } from "./targets.js";

describe("session store target selection", () => {
  it("rejects a blank agent instead of selecting the default store", () => {
    expect(() => resolveSessionStoreTargets({}, { agent: "" })).toThrow(
      "--agent must not be blank",
    );
  });
});
