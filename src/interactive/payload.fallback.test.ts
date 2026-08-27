import { describe, expect, it } from "vitest";
import { normalizeMessagePresentation, renderMessagePresentationFallbackText } from "./payload.js";

describe("presentation payload controls", () => {
  it("keeps typed select commands actionable without exposing callback values", () => {
    expect(
      renderMessagePresentationFallbackText({
        presentation: {
          blocks: [
            {
              type: "select",
              placeholder: "Environment",
              options: [
                { label: "Canary", action: { type: "command", command: "/deploy canary" } },
                {
                  label: "Production",
                  action: { type: "command", command: "/deploy production" },
                },
                { label: "Opaque", action: { type: "callback", value: "private-callback-token" } },
              ],
            },
          ],
        },
      }),
    ).toBe(
      "Environment:\n- Canary: `/deploy canary`\n- Production: `/deploy production`\n- Opaque",
    );
  });

  it("normalizes only the known custom-input question intent", () => {
    const action = {
      type: "question" as const,
      questionId: "ask_0123456789abcdef0123456789abcdef",
    };
    const presentation = (intent: string) => ({
      blocks: [
        { type: "buttons" as const, buttons: [{ label: "Other…", action: { ...action, intent } }] },
      ],
    });

    expect(normalizeMessagePresentation(presentation("custom-input"))).toEqual(
      presentation("custom-input"),
    );
    expect(normalizeMessagePresentation(presentation("unknown"))).toBeUndefined();
  });
});
