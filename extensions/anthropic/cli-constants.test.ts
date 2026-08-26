import { CLAUDE_CLI_PROFILE_ID as SDK_CLAUDE_CLI_PROFILE_ID } from "openclaw/plugin-sdk/provider-auth";
import { describe, expect, it } from "vitest";
import { CLAUDE_CLI_PROFILE_ID } from "./cli-constants.js";

describe("claude cli constants", () => {
  it("keeps the local retired profile id aligned with the plugin-sdk constant", () => {
    // The provider-policy artifact must stay light, so this plugin carries the
    // retired profile id locally instead of importing the provider-auth barrel
    // (#129052 regressed dist-less CI checkouts into 120s jiti compiles).
    expect(CLAUDE_CLI_PROFILE_ID).toBe(SDK_CLAUDE_CLI_PROFILE_ID);
  });
});
