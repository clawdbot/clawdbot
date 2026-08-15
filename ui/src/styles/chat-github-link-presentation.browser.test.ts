// Control UI tests cover how GitHub links present in chat when a line wraps.
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
const describeGitHubLinkPresentation = canRunPlaywrightChromium(chromiumExecutablePath)
  ? describe
  : describe.skip;

function readChatCss(): string {
  return ["ui/src/styles/base.css", "ui/src/styles/chat/text.css"]
    .map((file) => readStyleSheet(file))
    .join("\n");
}

// The three shapes the parser can produce, all carrying the same mark:
// a bare item URL whose label it rewrites to owner/repo#number, a bare URL to
// any other GitHub path, and an authored label. Only the first two carry
// markdown-bare-url, so the sweep covers both wrap regimes.
const LINK_FORMS = [
  {
    className: "markdown-bare-url markdown-github-link",
    id: "human-ref",
    label: "openclaw/openclaw#123309",
    lead: "then follow-up tracked in ",
  },
  {
    className: "markdown-bare-url markdown-github-link",
    id: "bare-url",
    label: "https://github.com/openclaw/openclaw/blob/main/ui/src/styles/chat/text.css#L254",
    lead: "then the owning rule lives at ",
  },
  {
    className: "markdown-github-link",
    id: "authored",
    label: "the sibling chip rule",
    lead: "then see ",
  },
] as const;

function fixtureDocument(themeMode: "dark" | "light"): string {
  const themeAttributes =
    themeMode === "light" ? `data-theme="light" data-theme-mode="light"` : `data-theme="dark"`;
  const columns = LINK_FORMS.map(
    ({ className, id, label, lead }) => `
      <div class="chat-text" id="column-${id}">Reproduce the failing run and read the notes
        first, ${lead}<a id="${id}" class="${className}" href="https://github.com/openclaw/openclaw"
        >${label}</a> before landing the fix.</div>`,
  ).join("");
  return `<!doctype html><html ${themeAttributes}><head><style>${readChatCss()}</style></head>
    <body>${columns}</body></html>`;
}

type WrapSample = {
  readonly columnWidth: number;
  readonly fragments: number;
  readonly labelStartsMarkLine: boolean;
  readonly markLineTop: number;
};

// Sweeping the column instead of picking one width: the mark has to stay with
// its label at every position the reference can land in, and a single tuned
// width stops exercising the wrap boundary as soon as prose or font metrics move.
async function probeWrap(
  themeMode: "dark" | "light",
): Promise<Record<string, readonly WrapSample[]>> {
  const fixtureFile = path.join(fixtureDirectory, `${themeMode}.html`);
  fs.writeFileSync(fixtureFile, fixtureDocument(themeMode), "utf8");
  const page = await browser.newPage();
  try {
    await page.goto(`file://${fixtureFile}`);
    return await page.evaluate(
      (ids: readonly string[]) => {
        const resolve = (selector: string) => {
          const element = document.querySelector(selector);
          if (!(element instanceof HTMLElement)) {
            throw new Error(`Missing GitHub link fixture element for ${selector}`);
          }
          return element;
        };
        const samples: Record<string, WrapSample[]> = {};
        for (const id of ids) {
          const column = resolve(`#column-${id}`);
          const link = resolve(`#${id}`);
          const collected: WrapSample[] = [];
          for (let columnWidth = 200; columnWidth <= 900; columnWidth += 4) {
            column.style.width = `${columnWidth}px`;
            // The mark is painted at the start of the link box, so the link box
            // and the first label character sharing a line is exactly the
            // invariant: the mark is never left behind on the previous line.
            const linkStart = link.getClientRects()[0];
            const labelRange = document.createRange();
            const labelText = link.firstChild;
            if (!labelText || !linkStart) {
              throw new Error(`Missing label geometry for ${id}`);
            }
            labelRange.setStart(labelText, 0);
            labelRange.setEnd(labelText, 1);
            const labelStart = labelRange.getBoundingClientRect();
            collected.push({
              columnWidth,
              fragments: link.getClientRects().length,
              labelStartsMarkLine: Math.abs(labelStart.top - linkStart.top) < 2,
              markLineTop: Math.round(linkStart.top),
            });
          }
          samples[id] = collected;
        }
        return samples;
      },
      LINK_FORMS.map((form) => form.id),
    );
  } finally {
    await page.close();
  }
}

let browser: Browser;
let fixtureDirectory: string;

beforeAll(async () => {
  if (!canRunPlaywrightChromium(chromiumExecutablePath)) {
    return;
  }
  // Resolve the temp root: macOS hands back a /var symlink and the file:// URL
  // must be the canonical path.
  fixtureDirectory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "chat-github-link-presentation-")),
  );
  browser = await chromium.launch({ executablePath: chromiumExecutablePath, headless: true });
});

afterAll(async () => {
  await browser?.close();
  if (fixtureDirectory) {
    fs.rmSync(fixtureDirectory, { force: true, recursive: true });
  }
});

describeGitHubLinkPresentation("chat GitHub link presentation", () => {
  it.each(["light", "dark"] as const)(
    "keeps the GitHub mark on its label's line at every column width in %s",
    async (themeMode) => {
      const samples = await probeWrap(themeMode);
      for (const { id } of LINK_FORMS) {
        const collected = samples[id] ?? [];
        // Vacuity guard: the reference must actually move between lines across
        // the sweep, or the assertion below passes on prose that never wraps.
        expect(new Set(collected.map((sample) => sample.markLineTop)).size).toBeGreaterThan(1);
        const stranded = collected.filter((sample) => !sample.labelStartsMarkLine);
        expect({ id, stranded }).toEqual({ id, stranded: [] });
      }
    },
  );

  it("keeps GitHub links breaking across lines instead of moving whole", async () => {
    const samples = await probeWrap("dark");
    // The file-link chip answers the same invariant by making the whole anchor
    // atomic. That is the wrong answer here: an atomic anchor never fragments,
    // so a long URL would move to the next line rather than break inside it and
    // leave the line it should have filled ragged. Both forms must still split.
    for (const id of ["bare-url", "authored"]) {
      const collected = samples[id] ?? [];
      expect({ id, splits: collected.some((sample) => sample.fragments > 1) }).toEqual({
        id,
        splits: true,
      });
    }
  });
});
