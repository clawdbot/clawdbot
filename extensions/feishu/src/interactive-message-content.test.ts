import { describe, expect, it } from "vitest";
import { parseInteractiveCardContent } from "./interactive-message-content.js";

describe("parseInteractiveCardContent", () => {
  it("renders schema 2 titles and table rows", () => {
    expect(
      parseInteractiveCardContent({
        schema: "2.0",
        header: { title: { tag: "plain_text", content: "Review ${count}" } },
        body: {
          elements: [
            {
              tag: "table",
              columns: [
                { name: "status", display_name: "Status" },
                { name: "reviewers", display_name: "Reviewers" },
              ],
              rows: [
                {
                  status: [{ text: "Open" }, { text: { content: "Priority ${count}" } }],
                  reviewers: [{ name: "Alice" }, { user_name: "Bob" }],
                },
              ],
            },
          ],
        },
        template_variable: { count: 2 },
      }),
    ).toBe("Review 2\nStatus | Reviewers\nOpen, Priority 2 | Alice, Bob");
  });

  it("renders schema 1 fields and actions through the same parser", () => {
    expect(
      parseInteractiveCardContent({
        header: { title: { tag: "plain_text", content: "Approval" } },
        elements: [
          {
            tag: "div",
            text: { tag: "lark_md", content: "Request details" },
            fields: [{ text: { tag: "plain_text", content: "Owner: Alice" } }],
          },
          {
            tag: "action",
            actions: [
              { tag: "button", text: { tag: "plain_text", content: "Approve" } },
              { tag: "button", text: { tag: "plain_text", content: "Reject" } },
            ],
          },
        ],
      }),
    ).toBe("Approval\nRequest details\nOwner: Alice\nApprove\nReject");
  });
});
