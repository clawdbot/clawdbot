import { describe, expect, it } from "vitest";
import { createFixtureSkillEntry } from "../test-support/test-helpers.js";
import { resolveSkillCommandUsagePaths } from "./command-identity.js";

describe("resolveSkillCommandUsagePaths", () => {
  it("keeps exact identities for user-invocable skills hidden from the model prompt", () => {
    const hidden = createFixtureSkillEntry("hidden-command", {
      invocation: { userInvocable: true, disableModelInvocation: true },
    });
    const unavailable = createFixtureSkillEntry("not-invocable", {
      invocation: { userInvocable: false, disableModelInvocation: false },
    });

    expect(resolveSkillCommandUsagePaths([hidden, unavailable])).toEqual([
      {
        readPath: hidden.skill.filePath,
        skillFile: hidden.skill.filePath,
        skillName: "hidden-command",
        skillSource: "workspace",
      },
    ]);
  });
});
