// Control UI tests cover the continuous corner curvature contract.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readStyleSheet } from "../../../test/helpers/ui-style-fixtures.js";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const describeCornerShape = canRunPlaywrightChromium(chromiumExecutablePath)
  ? describe
  : describe.skip;

// The `@supports` condition base.css gates the whole refinement on. Rewriting
// its value to one no engine implements is how this file reproduces Firefox
// and Safari from the shipped stylesheet instead of a hand-copied fallback.
const SUPPORTS_CONDITION = "@supports (corner-shape: superellipse(1.5))";
const UNSUPPORTED_CONDITION = "@supports (corner-shape: openclaw-unsupported-shape)";

type CornerCase = {
  /** Corner radius an engine without `corner-shape` keeps drawing. */
  readonly circular: string;
  /** Which physical corner to probe; most fixtures round all four equally,
   * so "topLeft" (the default) stands in for the rest. Only a directional
   * shorthand like .agent-chat__search-bar's `0 0 var(...) var(...)` needs
   * "bottomLeft" — its top corners are permanently 0 either way. */
  readonly corner?: "bottomLeft" | "topLeft";
  readonly markup: string;
  readonly selector: string;
  /** Radius once the 1.25 corner scale applies. */
  readonly superelliptical: string;
};

// One row per surface family named in the base.css corner block, plus the
// fully-rounded chrome that must stay a true arc: a superellipse would flatten
// the ends of every pill, avatar and status dot in the app.
const CORNER_CASES: readonly CornerCase[] = [
  {
    circular: "10px",
    markup: '<button class="btn" type="button">Send</button>',
    selector: ".btn",
    superelliptical: "12.5px",
  },
  {
    circular: "14px",
    markup: '<div class="card">Card</div>',
    selector: ".card",
    superelliptical: "17.5px",
  },
  {
    // Real DOM shape from option-card.ts: .option-card__choice is a button
    // nested two levels inside .option-card, not a synthetic flat div. The
    // .option-card__choice case below reuses this same markup — an empty
    // markup string there, not a duplicate copy of it.
    circular: "20px",
    markup:
      '<section class="option-card" role="group"><div class="option-card__choices">' +
      '<button type="button" class="option-card__choice">Choice</button></div></section>',
    selector: ".option-card",
    superelliptical: "25px",
  },
  {
    circular: "14px",
    markup: "",
    selector: ".option-card__choice",
    superelliptical: "17.5px",
  },
  {
    circular: "14px",
    markup: '<div class="exec-approval-card">Approval</div>',
    selector: ".exec-approval-card",
    superelliptical: "17.5px",
  },
  {
    circular: "20px",
    markup: '<div class="agent-chat__input">Composer</div>',
    selector: ".agent-chat__input",
    superelliptical: "25px",
  },
  {
    circular: "10px",
    markup: '<div class="sidebar-recent-session">Session</div>',
    selector: ".sidebar-recent-session",
    superelliptical: "12.5px",
  },
  {
    circular: "10px",
    markup: '<a class="nav-item" href="#/chat">Chat</a>',
    selector: ".nav-item",
    superelliptical: "12.5px",
  },
  {
    circular: "14px",
    markup: '<div class="settings-group">Group</div>',
    selector: ".settings-group",
    superelliptical: "17.5px",
  },
  {
    // Real DOM shape from chat-composer-slash-menu.ts: .slash-menu-item is a
    // div two levels below .slash-menu (through .slash-menu__scroll and
    // .slash-menu-group), not a direct child. Item radius is panel radius
    // minus 4px (calc(10px * scale - 4px) in base.css), so it reads a
    // different number from the panel at both scales — a real assertion,
    // not a copy of the panel's own expected value.
    circular: "10px",
    markup:
      '<div class="slash-menu" role="listbox"><div class="slash-menu__scroll">' +
      '<div class="slash-menu-group"><div class="slash-menu-item" role="option">Item</div>' +
      "</div></div></div>",
    selector: ".slash-menu",
    superelliptical: "12.5px",
  },
  {
    circular: "20px",
    markup: '<div class="agent-chat__input"><div class="slash-menu">Menu</div></div>',
    selector: ".agent-chat__input .slash-menu",
    superelliptical: "25px",
  },
  {
    circular: "6px",
    markup: "",
    selector: ".slash-menu-item",
    superelliptical: "8.5px",
  },
  {
    // Real DOM shape from chat-thread-interactions.ts: the item is a plain
    // <button>, matched by the base.css descendant tag selector
    // `.chat-reply-context-menu button`, not a class carried on the item
    // itself the way .slash-menu-item is.
    circular: "10px",
    markup:
      '<div class="chat-reply-context-menu" role="menu">' +
      '<button type="button" role="menuitem">Reply</button></div>',
    selector: ".chat-reply-context-menu",
    superelliptical: "12.5px",
  },
  {
    circular: "6px",
    markup: "",
    selector: ".chat-reply-context-menu button",
    superelliptical: "8.5px",
  },
  {
    // Real DOM shape from chat-thread-interactions.ts. Found and fixed
    // alongside the two P2s above during a final invariant sweep of every
    // selector in the base.css corner block: this one already scaled its
    // (bottom-only) radius but never carried corner-shape, same "radius
    // grew, shape didn't follow" gap as the menu items. Its only non-zero
    // corners are the bottom two (`border-radius: 0 0 var(...) var(...)`),
    // so this is the one case that needs the bottom-left probe.
    circular: "14px",
    corner: "bottomLeft",
    markup: '<div class="agent-chat__search-bar"><input type="text" /></div>',
    selector: ".agent-chat__search-bar",
    superelliptical: "17.5px",
  },
];

const ROUND_CASES: readonly CornerCase[] = [
  {
    circular: "9999px",
    markup: '<span class="pill">Pill</span>',
    selector: ".pill",
    superelliptical: "9999px",
  },
  {
    circular: "9999px",
    markup: '<span class="chip">Chip</span>',
    selector: ".chip",
    superelliptical: "9999px",
  },
  {
    circular: "9999px",
    markup: '<span class="statusDot"></span>',
    selector: ".statusDot",
    superelliptical: "9999px",
  },
];

// Consumers of the shared --radius-* tokens that are NOT named in the base.css
// corner block. The 1.25 scale must stay scoped to the opted-in selectors
// (set as a direct border-radius, not an inheritable custom property) or
// these unrelated surfaces inflate their radius while staying `round` — a
// regressed look with no matching corner-shape. .run-inspector__panel is a
// sibling of every opted surface, standing in for any --radius-md consumer
// outside the opted list entirely. .settings-segmented is nested INSIDE the
// opted .settings-group instead: border-radius does not inherit, so even a
// non-opted descendant of an opted container must keep its canonical radius
// and initial `round` shape — a redeclared --radius-* custom property on the
// container would leak into it, which is exactly the regression this proves.
const EXCLUDED_CASES: readonly CornerCase[] = [
  {
    circular: "10px",
    markup: '<div class="run-inspector__panel">Panel</div>',
    selector: ".run-inspector__panel",
    superelliptical: "10px",
  },
  {
    circular: "10px",
    markup: '<div class="settings-group"><div class="settings-segmented">Segmented</div></div>',
    selector: ".settings-segmented",
    superelliptical: "10px",
  },
];

const ALL_CASES = [...CORNER_CASES, ...ROUND_CASES, ...EXCLUDED_CASES];

// The radius tokens themselves, read at :root exactly like
// collectMcpAppStyleVariables() in mcp-app-theme.ts reads them for embedded
// MCP apps. They must stay canonical/unscaled even under the superelliptical
// fixture: an MCP app is a separate origin that only ever sees this snapshot,
// so a :root-level scale would leak the corner refinement into a contract
// that never opted into it.
const ROOT_RADIUS_TOKENS = {
  "--radius": "10px",
  "--radius-lg": "14px",
  "--radius-sm": "6px",
  "--radius-xl": "20px",
} as const;

function readUiCss(): string {
  return [
    "ui/src/styles/base.css",
    "ui/src/styles/components.css",
    "ui/src/styles/layout.css",
    "ui/src/styles/option-card.css",
    "ui/src/styles/chat/layout.css",
    "ui/src/styles/settings-controls.css",
    "ui/src/styles/settings.css",
    "ui/src/pages/activity/run-inspector.css",
  ]
    .map((file) => readStyleSheet(file))
    .join("\n");
}

function fixtureDocument(css: string): string {
  return `<!doctype html><html data-theme-mode="light"><head><style>${css}</style></head><body>
    <main>${ALL_CASES.map((corner) => corner.markup).join("")}</main>
  </body></html>`;
}

type CornerProbe = Record<string, { radius: string; shape: string }>;

async function probeCorners(browser: Browser, fixtureFile: string): Promise<CornerProbe> {
  const page = await browser.newPage();
  try {
    await page.goto(`file://${fixtureFile}`);
    return await page.evaluate(
      (probes: readonly { selector: string; corner: "bottomLeft" | "topLeft" }[]) => {
        return Object.fromEntries(
          probes.map(({ selector, corner }) => {
            const element = document.querySelector(selector);
            if (!element) {
              throw new Error(`Missing corner fixture element for ${selector}`);
            }
            const style = getComputedStyle(element);
            const radius =
              corner === "bottomLeft" ? style.borderBottomLeftRadius : style.borderTopLeftRadius;
            return [selector, { radius, shape: style.getPropertyValue("corner-shape") }];
          }),
        );
      },
      ALL_CASES.map((corner) => ({
        selector: corner.selector,
        corner: corner.corner ?? "topLeft",
      })),
    );
  } finally {
    await page.close().catch(() => {});
  }
}

async function probeRootRadiusTokens(
  browser: Browser,
  fixtureFile: string,
): Promise<Record<string, string>> {
  const page = await browser.newPage();
  try {
    await page.goto(`file://${fixtureFile}`);
    return await page.evaluate((tokens: readonly string[]) => {
      const style = getComputedStyle(document.documentElement);
      return Object.fromEntries(
        tokens.map((token) => [token, style.getPropertyValue(token).trim()]),
      );
    }, Object.keys(ROOT_RADIUS_TOKENS));
  } finally {
    await page.close().catch(() => {});
  }
}

let fixtureDirectory: string;
let superellipticalFixture: string;
let circularFixture: string;
let browser: Browser;

beforeAll(async () => {
  if (!canRunPlaywrightChromium(chromiumExecutablePath)) {
    return;
  }
  const css = readUiCss();
  expect(css).toContain(SUPPORTS_CONDITION);
  fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "corner-shape-"));
  superellipticalFixture = path.join(fixtureDirectory, "superelliptical.html");
  circularFixture = path.join(fixtureDirectory, "circular.html");
  fs.writeFileSync(superellipticalFixture, fixtureDocument(css), "utf8");
  fs.writeFileSync(
    circularFixture,
    fixtureDocument(css.replaceAll(SUPPORTS_CONDITION, UNSUPPORTED_CONDITION)),
    "utf8",
  );
  browser = await chromium.launch({ executablePath: chromiumExecutablePath, headless: true });
});

afterAll(async () => {
  await browser?.close().catch(() => {});
  if (fixtureDirectory) {
    fs.rmSync(fixtureDirectory, { force: true, recursive: true });
  }
});

describeCornerShape("Control UI corner curvature", () => {
  it("scales and reshapes the surfaces that carry the app silhouette", async () => {
    const probe = await probeCorners(browser, superellipticalFixture);

    expect(probe).toEqual(
      Object.fromEntries([
        ...CORNER_CASES.map((corner) => [
          corner.selector,
          { radius: corner.superelliptical, shape: "superellipse(1.5)" },
        ]),
        ...ROUND_CASES.map((corner) => [
          corner.selector,
          { radius: corner.superelliptical, shape: "round" },
        ]),
        ...EXCLUDED_CASES.map((corner) => [
          corner.selector,
          { radius: corner.superelliptical, shape: "round" },
        ]),
      ]),
    );
  });

  it("keeps today's corners on engines without corner-shape", async () => {
    const probe = await probeCorners(browser, circularFixture);

    expect(probe).toEqual(
      Object.fromEntries(
        ALL_CASES.map((corner) => [corner.selector, { radius: corner.circular, shape: "round" }]),
      ),
    );
  });

  it("keeps the :root radius tokens MCP apps read canonical under the scale", async () => {
    const probe = await probeRootRadiusTokens(browser, superellipticalFixture);

    expect(probe).toEqual(ROOT_RADIUS_TOKENS);
  });
});
