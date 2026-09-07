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

// Item chips stay atomic; other GitHub links keep normal label wrapping.
const LINK_FORMS = [
  {
    className: "markdown-bare-url markdown-github-link markdown-github-item",
    kind: "issue",
    id: "issue",
    label: "#123309",
    lead: "then follow-up tracked in ",
  },
  {
    className: "markdown-bare-url markdown-github-link markdown-github-item",
    kind: "pull",
    id: "pull",
    label: "#3434",
    lead: "then the fix is in ",
  },
  {
    className: "markdown-code-url markdown-bare-url markdown-github-link markdown-github-item",
    kind: "pull",
    id: "inline-pull",
    label: "<code>#3434</code>",
    lead: "then the fix is in ",
  },
  {
    className: "markdown-github-link markdown-github-item",
    kind: "pull",
    id: "repository-ref",
    label: "openclaw/openclaw#3434",
    lead: "then see ",
  },
  {
    className: "markdown-bare-url markdown-github-link",
    kind: "",
    id: "bare-url",
    label: "text.css",
    lead: "then the owning rule lives at ",
  },
  {
    className: "markdown-code-url markdown-bare-url markdown-github-link",
    kind: "",
    id: "inline-bare-url",
    label: "<code>text.css</code>",
    lead: "then the owning rule lives at ",
  },
  {
    className: "markdown-github-link",
    kind: "",
    id: "authored",
    label: "the sibling chip rule",
    lead: "then see ",
  },
] as const;

function fixtureDocument(themeMode: "dark" | "light"): string {
  const themeAttributes =
    themeMode === "light" ? `data-theme="light" data-theme-mode="light"` : `data-theme="dark"`;
  const columns = LINK_FORMS.map(
    ({ className, kind, id, label, lead }) => `
      <div class="chat-text" id="column-${id}">Reproduce the failing run and read the notes
        first, ${lead}<a id="${id}" class="${className}" ${kind ? `data-github-kind="${kind}"` : ""} href="https://github.com/openclaw/openclaw"
        >${label}</a> before landing the fix.</div>`,
  ).join("");
  return `<!doctype html><html ${themeAttributes}><head><style>${readChatCss()}</style></head>
    <body>${columns}</body></html>`;
}

type WrapSample = {
  readonly columnWidth: number;
  readonly fragments: number;
  readonly labelFragments: number;
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
            const labelText = (link.querySelector("code") ?? link).firstChild;
            if (!labelText || !linkStart) {
              throw new Error(`Missing label geometry for ${id}`);
            }
            labelRange.setStart(labelText, 0);
            labelRange.setEnd(labelText, 1);
            const labelStart = labelRange.getBoundingClientRect();
            labelRange.selectNodeContents(labelText);
            collected.push({
              columnWidth,
              fragments: link.getClientRects().length,
              labelFragments: labelRange.getClientRects().length,
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
    "keeps GitHub icons with their labels and item chips atomic at every column width in %s",
    async (themeMode) => {
      const samples = await probeWrap(themeMode);
      for (const { id, kind } of LINK_FORMS) {
        const collected = samples[id] ?? [];
        // Vacuity guard: the reference must actually move between lines across
        // the sweep, or the assertion below passes on prose that never wraps.
        expect(new Set(collected.map((sample) => sample.markLineTop)).size).toBeGreaterThan(1);
        const stranded = collected.filter((sample) => !sample.labelStartsMarkLine);
        expect({ id, stranded }).toEqual({ id, stranded: [] });
        if (kind) {
          expect(
            collected.filter((sample) => sample.fragments !== 1 || sample.labelFragments !== 1),
          ).toEqual([]);
        }
      }
    },
  );

  it("keeps GitHub links breaking across lines instead of moving whole", async () => {
    const samples = await probeWrap("dark");
    // Non-item links still fill the line they start on rather than moving whole.
    for (const id of ["bare-url", "inline-bare-url", "authored"]) {
      const collected = samples[id] ?? [];
      expect({ id, splits: collected.some((sample) => sample.fragments > 1) }).toEqual({
        id,
        splits: true,
      });
    }
  });

  it.each(["light", "dark"] as const)(
    "paints distinct kind icons and visible hover and keyboard focus states in %s",
    async (themeMode) => {
      const fixtureFile = path.join(fixtureDirectory, `${themeMode}-interaction.html`);
      fs.writeFileSync(fixtureFile, fixtureDocument(themeMode), "utf8");
      const page = await browser.newPage();
      try {
        await page.goto(`file://${fixtureFile}`);
        const masks: string[] = [];
        for (const id of ["issue", "pull", "inline-pull"]) {
          const chip = page.locator(`#${id}`);
          const idle = await chip.evaluate((element) => {
            const style = getComputedStyle(element);
            const icon = getComputedStyle(element, "::before");
            return {
              background: style.backgroundColor,
              decoration: style.textDecorationLine,
              iconColor: icon.backgroundColor,
              color: style.color,
              mask: icon.maskImage,
            };
          });
          expect(idle.decoration).toBe("none");
          expect(idle.iconColor).toBe(idle.color);
          expect(idle.mask).toContain("data:image/svg+xml");
          masks.push(idle.mask);
          await chip.hover();
          const hover = await chip.evaluate((element) => ({
            background: getComputedStyle(element).backgroundColor,
            decoration: getComputedStyle(element).textDecorationLine,
          }));
          expect(hover.background).not.toBe(idle.background);
          expect(hover.decoration).toBe("underline");
          await page.mouse.move(0, 0);
          await page.keyboard.press("Tab");
          await chip.focus();
          expect(await chip.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
          expect(
            await chip.evaluate((element) => ({
              background: getComputedStyle(element).backgroundColor,
              decoration: getComputedStyle(element).textDecorationLine,
            })),
          ).toEqual(hover);
          await chip.evaluate((element) => element.blur());
        }
        const genericMask = await page
          .locator("#authored")
          .evaluate((element) => getComputedStyle(element, "::before").maskImage);
        expect(new Set([...masks, genericMask]).size).toBe(3);
        for (const id of ["pull", "bare-url"]) {
          const presentation = await page.locator(`#inline-${id}`).evaluate((link, bareId) => {
            const code = link.querySelector("code");
            const bare = document.getElementById(bareId);
            if (!code || !bare) {
              throw new Error(`Missing inline code presentation fixture for ${bareId}`);
            }
            const codeStyle = getComputedStyle(code);
            const linkStyle = getComputedStyle(link);
            const linkBox = link.getBoundingClientRect();
            const bareBox = bare.getBoundingClientRect();
            return {
              codeTypography: [codeStyle.fontFamily, codeStyle.fontSize, codeStyle.color],
              linkTypography: [linkStyle.fontFamily, linkStyle.fontSize, linkStyle.color],
              background: codeStyle.backgroundColor,
              border: codeStyle.borderWidth,
              padding: codeStyle.padding,
              linkSize: [linkBox.width, linkBox.height],
              bareSize: [bareBox.width, bareBox.height],
            };
          }, id);
          expect(presentation.codeTypography).toEqual(presentation.linkTypography);
          expect(presentation.background).toBe("rgba(0, 0, 0, 0)");
          expect(presentation.border).toBe("0px");
          expect(presentation.padding).toBe("0px");
          expect(presentation.linkSize).toEqual(presentation.bareSize);
        }
      } finally {
        await page.close();
      }
    },
  );
});
