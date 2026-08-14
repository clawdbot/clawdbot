import { describe, expect, it } from "vitest";
import { projectToolResultDetails } from "./chat-display-projection.canvas.js";

describe("projectToolResultDetails UI artifacts", () => {
  it("preserves only bounded canonical artifacts in sanitized history", () => {
    const valid = {
      version: 1,
      id: "artifact-calendar",
      revision: 2,
      structuredContent: { title: "Calendar" },
      views: [
        {
          id: "calendar",
          templateUri: "clawpilot://widgets/calendar",
          dataVersion: 1,
          availability: "inline",
          data: { events: [] },
          module: "https://attacker.invalid/component.js",
        },
      ],
      state: "ready",
      source: { sessionKey: "agent:main:one", toolCallId: "tool-1" },
      registerComponent: "calendar",
    };
    expect(
      projectToolResultDetails(
        {
          uiArtifacts: [
            valid,
            { ...valid, id: "malformed", structuredContent: { value: undefined } },
          ],
          secret: "drop",
        },
        1_000,
      ),
    ).toEqual({
      truncated: false,
      details: {
        uiArtifacts: [
          {
            version: 1,
            id: "artifact-calendar",
            revision: 2,
            structuredContent: { title: "Calendar" },
            views: [
              {
                id: "calendar",
                templateUri: "clawpilot://widgets/calendar",
                dataVersion: 1,
                availability: "inline",
                data: { events: [] },
              },
            ],
            state: "ready",
            source: { sessionKey: "agent:main:one", toolCallId: "tool-1" },
          },
          {
            version: 1,
            id: "malformed",
            revision: 2,
            views: [],
            state: "failed",
            source: { sessionKey: "agent:main:one", toolCallId: "tool-1" },
            error: {
              code: "ARTIFACT_MALFORMED",
              message: "UI artifact structured content is malformed",
            },
          },
        ],
      },
    });
  });
});
