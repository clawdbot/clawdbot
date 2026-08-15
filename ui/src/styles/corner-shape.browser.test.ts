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
    circular: "20px",
    markup: '<div class="option-card">Option</div>',
    selector: ".option-card",
    superelliptical: "25px",
  },
  {
    circular: "14px",
    markup: '<div class="exec-approval-card">Approval</div>',
    selector: ".exec-approval-card",
    superelliptical: "17.5px",
  },
  {
    circular: "10px",
    markup: '<div class="agent-chat__input">Composer</div>',
    selector: ".agent-chat__input",
    superelliptical: "12.5px",
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
      (selectors: readonly string[]) => {
        return Object.fromEntries(
          selectors.map((selector) => {
            const element = document.querySelector(selector);
            if (!element) {
              throw new Error(`Missing corner fixture element for ${selector}`);
            }
            const style = getComputedStyle(element);
            return [
              selector,
              { radius: style.borderTopLeftRadius, shape: style.getPropertyValue("corner-shape") },
            ];
          }),
        );
      },
      ALL_CASES.map((corner) => corner.selector),
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
  expect(css.split(SUPPORTS_CONDITION)).toHaveLength(2);
  fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "corner-shape-"));
  superellipticalFixture = path.join(fixtureDirectory, "superelliptical.html");
  circularFixture = path.join(fixtureDirectory, "circular.html");
  fs.writeFileSync(superellipticalFixture, fixtureDocument(css), "utf8");
  fs.writeFileSync(
    circularFixture,
    fixtureDocument(css.replace(SUPPORTS_CONDITION, UNSUPPORTED_CONDITION)),
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
