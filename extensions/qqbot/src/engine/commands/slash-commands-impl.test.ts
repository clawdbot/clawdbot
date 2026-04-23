import { describe, expect, it } from "vitest";
import { getFrameworkCommands } from "./slash-commands-impl.js";

describe("QQBot framework slash commands", () => {
  it("routes bot-approve through the auth-gated framework registry", () => {
    expect(getFrameworkCommands().map((command) => command.name)).toContain("bot-approve");
  });
});
