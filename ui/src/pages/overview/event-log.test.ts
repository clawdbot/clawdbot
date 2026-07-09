/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it } from "vitest";
import { formatEventPayload } from "../../lib/presenter.ts";
import { renderOverviewEventLog } from "./event-log.ts";

function createBoundaryPayload() {
  const emptyPayload = formatEventPayload({ message: "" });
  const valueStart = emptyPayload.indexOf('""') + 1;
  return { message: `${"a".repeat(119 - valueStart)}🙂tail` };
}

describe("renderOverviewEventLog", () => {
  it("keeps payload previews UTF-16 safe at the truncation boundary", () => {
    const payload = createBoundaryPayload();
    const formatted = formatEventPayload(payload);
    const oldPreview = formatted.slice(0, 120);
    expect(oldPreview.charCodeAt(oldPreview.length - 1)).toBe(0xd83d);

    const container = document.createElement("div");
    render(
      renderOverviewEventLog({
        events: [
          {
            ts: 1,
            event: "agent.message",
            payload,
          },
        ],
      }),
      container,
    );

    const preview = container.querySelector(".ov-event-log-payload")?.textContent ?? "";
    expect(preview).toBe(formatted.slice(0, 119));
    expect(preview.charCodeAt(preview.length - 1)).not.toBe(0xd83d);
  });
});
