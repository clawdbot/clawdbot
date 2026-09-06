import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import "../../styles/base.css";
import "../../styles/settings.css";
import "../../styles/cron.css";

const hasBrowserLayout = !navigator.userAgent.toLowerCase().includes("jsdom");
const alignmentTolerancePx = 2;

afterEach(() => {
  document.body.replaceChildren();
});

function centerY(bounds: DOMRect) {
  return bounds.top + bounds.height / 2;
}

async function nextFrame() {
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

describe.skipIf(!hasBrowserLayout)("cron editor browser layout", () => {
  it("vertically centers the configured trigger status with the Advanced heading", async () => {
    const details = document.createElement("details");
    details.className = "cron-advanced";
    details.open = true;
    details.innerHTML = `
      <summary class="settings-section__heading cron-advanced__summary">Advanced</summary>
    `;
    document.body.append(details);

    const summary = expectDefined(
      details.querySelector<HTMLElement>(".cron-advanced__summary"),
      "Advanced summary",
    );
    const heading = document.createRange();
    heading.selectNode(expectDefined(summary.firstChild, "Advanced heading text"));

    summary.insertAdjacentHTML(
      "beforeend",
      `
        <span class="cron-trigger-summary">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 3v12"></path>
            <path d="M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"></path>
          </svg>
          Trigger configured
        </span>
      `,
    );
    await nextFrame();

    const status = expectDefined(
      details.querySelector<HTMLElement>(".cron-trigger-summary"),
      "configured trigger status",
    );
    const headingCenter = centerY(heading.getBoundingClientRect());
    const statusCenter = centerY(status.getBoundingClientRect());

    expect(Math.abs(statusCenter - headingCenter)).toBeLessThanOrEqual(alignmentTolerancePx);
  });
});
