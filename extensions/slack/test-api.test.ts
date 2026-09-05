// Slack test API tests enforce the narrow private-QA runtime surface.
import { describe, expect, it } from "vitest";
import * as slackQaRuntime from "./test-api.js";

describe("Slack test API", () => {
  it("exports exactly the Slack operations owned by private QA", () => {
    expect(Object.keys(slackQaRuntime).toSorted()).toEqual([
      "createSlackWebClient",
      "createSlackWriteClient",
      "listSlackReactions",
      "resolveSlackWebClientOptions",
      "sendSlackMessage",
    ]);
    for (const operation of Object.values(slackQaRuntime)) {
      expect(operation).toBeTypeOf("function");
    }
  });
});
