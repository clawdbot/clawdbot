// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));

function readRuleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "u"));
  const body = match?.[1];
  if (!body) {
    throw new Error(`missing CSS rule for ${selector}`);
  }
  return body;
}

function readOpacity(ruleBody: string): number {
  const match = ruleBody.match(/opacity:\s*([0-9.]+)\s*;/u);
  const raw = match?.[1];
  return raw === undefined ? 1 : Number.parseFloat(raw);
}

describe("Control UI theme contrast", () => {
  const groupedCss = readFileSync(path.join(here, "chat", "grouped.css"), "utf8");
  const chatComposerCss = readFileSync(path.join(here, "chat", "composer.css"), "utf8");
  const layoutCss = readFileSync(path.join(here, "layout.css"), "utf8");

  it("keeps chat timestamps and slash-arg hints AA without opacity dimming", () => {
    const timestampRule = readRuleBody(groupedCss, ".chat-group-timestamp");
    const slashArgsRule = readRuleBody(chatComposerCss, ".slash-menu-args,\n.slash-menu-desc");

    expect(timestampRule).toMatch(/color:\s*var\(--muted\)/);
    expect(slashArgsRule).toMatch(/color:\s*var\(--muted\)/);

    expect(readOpacity(timestampRule)).toBe(1);
    expect(readOpacity(slashArgsRule)).toBe(1);
  });

  it("keeps sidebar metadata on the AA-tested muted token without opacity dimming", () => {
    const groupLabelRule = readRuleBody(layoutCss, ".settings-sidebar__group-label");
    const buildRule = readRuleBody(layoutCss, ".settings-sidebar__footer .sidebar-footer-build");
    const sessionLabelRule = readRuleBody(
      layoutCss,
      ".sidebar-recent-sessions__label-text,\n.sidebar-session-catalog-host__label",
    );

    expect(groupLabelRule).toMatch(/color:\s*var\(--muted\)/);
    expect(buildRule).toMatch(/color:\s*var\(--muted\)/);
    expect(sessionLabelRule).toMatch(/color:\s*var\(--muted\)/);
    expect(readOpacity(sessionLabelRule)).toBe(1);
  });
});
