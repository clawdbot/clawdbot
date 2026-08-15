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

const ALL_CASES = [...CORNER_CASES, ...ROUND_CASES];

function readUiCss(): string {
  return [
    "ui/src/styles/base.css",
    "ui/src/styles/components.css",
    "ui/src/styles/layout.css",
    "ui/src/styles/option-card.css",
    "ui/src/styles/chat/layout.css",
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
});
