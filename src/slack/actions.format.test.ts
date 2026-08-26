import { describe, expect, it } from "vitest";
import { createSlackEditTestClient, installSlackBlockTestMocks } from "./blocks.test-helpers.js";

installSlackBlockTestMocks();
const { editSlackMessage } = await import("./actions.js");

describe("editSlackMessage markdown formatting", () => {
  it("converts edited Markdown content to Slack mrkdwn", async () => {
    const client = createSlackEditTestClient();

    await editSlackMessage("C123", "171234.567", "## Deploy\n\n**green**", {
      token: "xoxb-test",
      client,
    });

    expect(client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "*Deploy*\n\n*green*",
      }),
    );
  });

  it("leaves plain edited text unchanged", async () => {
    const client = createSlackEditTestClient();

    await editSlackMessage("C123", "171234.567", "plain status update", {
      token: "xoxb-test",
      client,
    });

    expect(client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "plain status update",
      }),
    );
  });
});
