// Delivery-boundary regression: the outbound message-action send boundary must
// preserve leading whitespace on the substantive body (e.g. Markdown indented
// code blocks) instead of trimming it away before delivery.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { MessageActionInput } from "./message-action-contracts.js";
import { buildMessagePayload } from "./message-action-send.js";

const cfg = {} as OpenClawConfig;
const baseInput = { cfg, action: "send", params: {} } as MessageActionInput;

describe("buildMessagePayload body whitespace preservation", () => {
  it("preserves leading whitespace on a delivered indented code block", async () => {
    const result = await buildMessagePayload({
      cfg,
      actionParams: { message: "    const value = 1;" },
      input: baseInput,
    });

    expect(result.message).toBe("    const value = 1;");
  });

  it("preserves leading whitespace through the reasoning-preamble alias path", async () => {
    // The `text` alias carries a formatted reasoning preamble; the helper strips
    // the preamble and the send boundary must keep the indented body intact.
    const result = await buildMessagePayload({
      cfg,
      actionParams: {
        text: ["Thinking...", "_brief summary_", "", "    const value = 1;"].join("\n"),
      },
      input: baseInput,
    });

    expect(result.message).toBe("    const value = 1;");
  });

  it("rejects a whitespace-only body (no spurious whitespace payload)", async () => {
    await expect(
      buildMessagePayload({
        cfg,
        actionParams: { message: "    " },
        input: baseInput,
      }),
    ).rejects.toThrow(/send requires text or media or location/);
  });
});
