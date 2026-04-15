import { describe, expect, it } from "vitest";
import { compileSlackInteractiveReplies } from "./interactive-replies.js";

describe("compileSlackInteractiveReplies", () => {
  it("compiles inline Slack button directives into shared interactive blocks", () => {
    const result = compileSlackInteractiveReplies({
      text: "[bot] hello [[slack_buttons: Retry:retry, Ignore:ignore]]",
    });

    expect(result.text).toBe("[bot] hello");
    expect(result.interactive).toEqual({
      blocks: [
        {
          type: "text",
          text: "[bot] hello",
        },
        {
          type: "buttons",
          buttons: [
            {
              label: "Retry",
              value: "retry",
            },
            {
              label: "Ignore",
              value: "ignore",
            },
          ],
        },
      ],
    });
  });

  it("compiles simple trailing Options lines into Slack buttons", () => {
    const result = compileSlackInteractiveReplies({
      text: "Current verbose level: off.\nOptions: on, full, off.",
    });

    expect(result.text).toBe("Current verbose level: off.");
    expect(result.interactive).toEqual({
      blocks: [
        {
          type: "text",
          text: "Current verbose level: off.",
        },
        {
          type: "buttons",
          buttons: [
            { label: "on", value: "on" },
            { label: "full", value: "full" },
            { label: "off", value: "off" },
          ],
        },
      ],
    });
  });

  it("uses a Slack select when Options lines exceed button capacity", () => {
    const result = compileSlackInteractiveReplies({
      text: "Choose a reasoning level.\nOptions: off, minimal, low, medium, high, adaptive.",
    });

    expect(result.text).toBe("Choose a reasoning level.");
    expect(result.interactive).toEqual({
      blocks: [
        {
          type: "text",
          text: "Choose a reasoning level.",
        },
        {
          type: "select",
          placeholder: "Choose an option",
          options: [
            { label: "off", value: "off" },
            { label: "minimal", value: "minimal" },
            { label: "low", value: "low" },
            { label: "medium", value: "medium" },
            { label: "high", value: "high" },
            { label: "adaptive", value: "adaptive" },
          ],
        },
      ],
    });
  });

  it("leaves complex Options lines as plain text", () => {
    const result = compileSlackInteractiveReplies({
      text: "ACP runtime choices.\nOptions: host=auto|sandbox|gateway|node, security=deny|allowlist|full.",
    });

    expect(result.text).toBe(
      "ACP runtime choices.\nOptions: host=auto|sandbox|gateway|node, security=deny|allowlist|full.",
    );
    expect(result.interactive).toBeUndefined();
  });
});
