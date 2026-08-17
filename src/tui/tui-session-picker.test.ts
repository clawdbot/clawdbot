import { describe, expect, it } from "vitest";
import { buildSessionChoices } from "./tui-session-picker.js";

describe("buildSessionChoices", () => {
  it("renders the Gateway display projection without reinterpreting quoted directives", () => {
    const [choice] = buildSessionChoices([
      {
        key: "agent:main:quoted-directive",
        kind: "direct",
        lastMessagePreview: "Use `[[reply_to_current]]` literally.",
      },
    ]);

    expect(choice?.description).toBe("Use `[[reply_to_current]]` literally.");
  });
});
