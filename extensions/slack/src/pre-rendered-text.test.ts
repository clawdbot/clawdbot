import { describe, expect, it } from "vitest";
import { escapeSlackReservedKeepingLinks, slackPreRenderedText } from "./pre-rendered-text.js";

describe("slack pre-rendered text", () => {
  it("escapes Slack's reserved characters outside the writer's own links and mentions", () => {
    const authored = [
      "*job* failed: exit 1",
      "do: <https://github.com/x/y/actions/runs/1|run> then <#C123|ops>",
      'cause: File "<stdin>", in <module> a & b, already &gt;1m and &amp; kept, <@U123> asked',
    ].join("\n");
    expect(escapeSlackReservedKeepingLinks(authored)).toBe(
      [
        "*job* failed: exit 1",
        "do: <https://github.com/x/y/actions/runs/1|run> then <#C123|ops>",
        'cause: File "&lt;stdin&gt;", in &lt;module&gt; a &amp; b, already &gt;1m and &amp; kept, <@U123> asked',
      ].join("\n"),
    );
  });

  it("leaves text alone without the hint and escapes it with the hint", () => {
    expect(slackPreRenderedText("in <module>")).toBe("in <module>");
    expect(slackPreRenderedText("in <module>", { preRendered: "other" })).toBe("in <module>");
    expect(slackPreRenderedText("in <module>", { preRendered: "slack-mrkdwn" })).toBe(
      "in &lt;module&gt;",
    );
  });
});
