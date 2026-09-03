import { describe, expect, it } from "vitest";
import { readQaScenarioPack } from "./scenario-catalog.js";

describe("no-meta QA catalog", () => {
  it("keeps context visibility proof on one primary scenario", () => {
    const primaryOwnerIds = readQaScenarioPack()
      .scenarios.filter((scenario) =>
        scenario.coverage?.primary.includes("session-memory.context-visibility-no-meta-leak"),
      )
      .map((scenario) => scenario.id);

    expect(primaryOwnerIds).toStrictEqual(["instruction-profile-artifact-followthrough-live"]);
  });
});
