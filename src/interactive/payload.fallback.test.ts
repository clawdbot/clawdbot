import { describe, expect, it } from "vitest";
import { renderMessagePresentationFallbackText } from "./payload.js";

describe("presentation fallback controls", () => {
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
});
