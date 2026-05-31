import { describe, expect, it } from "vitest";
import { createOscProgressController, supportsOscProgress } from "./osc-progress.js";

describe("OSC progress", () => {
  it("detects supported terminal environments", () => {
    expect(supportsOscProgress({ TERM_PROGRAM: "WezTerm" }, true)).toBe(true);
    expect(supportsOscProgress({ TERM_PROGRAM: "Apple_Terminal" }, true)).toBe(false);
    expect(supportsOscProgress({ WT_SESSION: "1" }, false)).toBe(false);
  });

  it("writes sanitized OSC 9;4 progress sequences", () => {
    const writes: string[] = [];
    const controller = createOscProgressController({
      env: { TERM_PROGRAM: "ghostty" },
      isTty: true,
      write: (chunk) => writes.push(chunk),
    });

    controller.setIndeterminate("Build\u001b]bad\u0007");
    controller.setPercent("Build", 42.6);
    controller.clear();

    expect(writes).toEqual([
      "\u001b]9;4;3;;Buildbad\u001b\\",
      "\u001b]9;4;1;43;Build\u001b\\",
      "\u001b]9;4;0;0;Build\u001b\\",
    ]);
  });
});
