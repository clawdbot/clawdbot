// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/*
 * Single-scroll-boundary guardrail for expanded tool-call activity.
 *
 * Nested max-height scrollers once stacked up to 3 deep inside one expanded
 * activity group (issue #138663): the group body, the per-tool message body,
 * and the innermost terminal/card/diff box each scrolled independently.
 * Descendant boxes must render at natural height so the group body stays the
 * only vertical scroll boundary. These selectors are read back out of the
 * stylesheet rather than restated, so the rule and the content boxes cannot
 * drift apart again.
 */

const stylesDir = path.dirname(fileURLToPath(import.meta.url));
const toolCardsCss = fs.readFileSync(path.join(stylesDir, "tool-cards.css"), "utf8");

const INNER_SCROLLERS = [
  ".chat-tool-msg-body",
  ".chat-tool-term__out",
  ".chat-tool-card__block-content",
  ".chat-diff",
];

function escapeRegExp(value: string): string {
  return value.replace(/[$()*+.?[\\\]^{|}]/g, "\\$&");
}

function findRuleBlock(selector: string): string | undefined {
  // Match only a rule whose full selector list starts exactly with the target;
  // a plain indexOf would land on nested selectors such as
  // ".chat-activity-group__body .chat-tool-row__chevron".
  const pattern = new RegExp(`^${escapeRegExp(selector)}(?=\\s*[,{])`, "mu");
  const match = pattern.exec(toolCardsCss);
  if (!match) {
    return undefined;
  }
  const open = toolCardsCss.indexOf("{", match.index);
  const close = toolCardsCss.indexOf("}", open);
  if (open === -1 || close === -1) {
    return undefined;
  }
  return toolCardsCss.slice(open + 1, close);
}

describe("tool activity single scroll boundary", () => {
  it("keeps exactly one vertical scroll boundary on the activity group", () => {
    const groupBlock = findRuleBlock(".chat-activity-group__body");
    expect(groupBlock).toBeDefined();
    expect(groupBlock).toMatch(/max-height\s*:/u);
    expect(groupBlock).toMatch(/overflow-y\s*:\s*auto/u);
  });

  it.each(INNER_SCROLLERS)("lifts the vertical cap on %s inside activity groups", (selector) => {
    const overrideSelector = `.chat-activity-group__body ${selector}`;
    const block = findRuleBlock(overrideSelector);
    expect(block, `missing override rule for ${overrideSelector}`).toBeDefined();
    expect(block).toMatch(/max-height\s*:\s*none/u);
  });
});
