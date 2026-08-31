// Slack tests cover edit fallback text behavior.
import { describe, expect, it } from "vitest";
import { buildSlackEditTextPayload } from "./edit-text.js";

describe("buildSlackEditTextPayload", () => {
  it("preserves block fallback text when edited content has action blocks", () => {
    const payload = buildSlackEditTextPayload("Approve deployment?", [
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Approve" },
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Deny" },
          },
        ],
      },
    ]);

    expect(payload).toBe("Approve deployment?\n\nApprove\nDeny");
  });

  it("does not duplicate edited content already present in blocks", () => {
    const payload = buildSlackEditTextPayload("Approve deployment?", [
      {
        type: "section",
        text: { type: "mrkdwn", text: "Approve deployment?" },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Approve" },
          },
        ],
      },
    ]);

    expect(payload).toBe("Approve deployment?\n\nApprove");
  });

  it("does not append block fallback already present in edited content", () => {
    const tableFallback = "Pipeline report (table)\nAccount\tARR\nAcme\t$125k";
    const payload = buildSlackEditTextPayload(`Summary\n\n${tableFallback}`, [
      {
        type: "data_table",
        caption: "Pipeline report",
        rows: [
          [
            { type: "raw_text", text: "Account" },
            { type: "raw_text", text: "ARR" },
          ],
          [
            { type: "raw_text", text: "Acme" },
            { type: "raw_number", value: 125000, text: "$125k" },
          ],
        ],
      },
    ] as never);

    expect(payload).toBe(`Summary\n\n${tableFallback}`);
  });
});
