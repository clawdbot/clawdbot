// Control UI tests cover how recognized workspace file links present in chat.
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
const describeFileLinkPresentation = canRunPlaywrightChromium(chromiumExecutablePath)
  ? describe
  : describe.skip;

// The declarations the inline-code chip paints. A file link must match its
// plain-text sibling on every one of them, whichever syntax produced it.
const CHIP_PROPERTIES = [
  "backgroundColor",
  "borderTopWidth",
  "borderTopStyle",
  "borderTopColor",
  "borderTopLeftRadius",
  "paddingTop",
  "paddingLeft",
  "fontFamily",
  "fontSize",
  "color",
] as const;

// sidebar-markdown.css must load after chat/text.css, matching the import order
// in styles/chat.css — the file-link rules are written to win at that order.
function readChatCss(): string {
  return [
    "ui/src/styles/base.css",
    "ui/src/styles/chat/text.css",
    "ui/src/styles/sidebar-markdown.css",
  ]
    .map((file) => readStyleSheet(file))
    .join("\n");
}

// Both file links carry the same kind so any difference is the authoring
// syntax, not the glyph. The trailing code span is the control: it is not a
// file link and must keep the chip.
function fixtureDocument(themeMode: "dark" | "light"): string {
  const themeAttributes =
    themeMode === "light" ? `data-theme="light" data-theme-mode="light"` : `data-theme="dark"`;
  return `<!doctype html><html ${themeAttributes}><head><style>${readChatCss()}</style></head><body>
    <div class="chat-text">
      <p>
        <a id="from-text" class="markdown-file-link" data-file-kind="code"
          data-file-path="src/app.ts">app.ts</a>
        <a id="from-code" class="markdown-file-link" data-file-kind="code"
          data-file-path="ui/app.ts"><code>app.ts</code></a>
        <code id="plain-code">npm run dev</code>
      </p>
    </div>
    <article class="sidebar-markdown">
      <p>
        <a id="panel-from-text" class="markdown-file-link" data-file-kind="code"
          data-file-path="src/app.ts">app.ts</a>
        <a id="panel-from-code" class="markdown-file-link" data-file-kind="code"
          data-file-path="ui/app.ts"><code>app.ts</code></a>
        <code id="panel-plain-code">npm run dev</code>
      </p>
    </article>
  </body></html>`;
}

type StyleSnapshot = Record<(typeof CHIP_PROPERTIES)[number], string>;
type PresentationProbe = {
  readonly chatGlyph: { readonly maskImage: string };
  readonly fromCode: StyleSnapshot;
  readonly fromText: StyleSnapshot;
  readonly panelFromCode: StyleSnapshot;
  readonly panelFromText: StyleSnapshot;
  readonly panelGlyph: { readonly maskImage: string };
  readonly plainCode: StyleSnapshot;
};

let browser: Browser;
let fixtureDirectory: string;

beforeAll(async () => {
  if (!canRunPlaywrightChromium(chromiumExecutablePath)) {
    return;
  }
  // Resolve the temp root: macOS hands back a /var symlink and the file:// URL
  // must be the canonical path.
  fixtureDirectory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "chat-file-link-presentation-")),
  );
  browser = await chromium.launch({ executablePath: chromiumExecutablePath, headless: true });
});

afterAll(async () => {
  await browser?.close();
  if (fixtureDirectory) {
    fs.rmSync(fixtureDirectory, { force: true, recursive: true });
  }
});

async function probe(themeMode: "dark" | "light"): Promise<PresentationProbe> {
  const fixtureFile = path.join(fixtureDirectory, `${themeMode}.html`);
  fs.writeFileSync(fixtureFile, fixtureDocument(themeMode), "utf8");
  const page = await browser.newPage();
  try {
    await page.goto(`file://${fixtureFile}`);
    // The probe builds its snapshots from CHIP_PROPERTIES at runtime, so the
    // shape is asserted here rather than inferred from Object.fromEntries.
    const probed = await page.evaluate((properties: readonly string[]) => {
      const resolve = (selector: string) => {
        const element = document.querySelector(selector);
        if (!element) {
          throw new Error(`Missing presentation fixture element for ${selector}`);
        }
        return element;
      };
      const read = (selector: string) => {
        const computed = getComputedStyle(resolve(selector));
        return Object.fromEntries(
          properties.map((property) => [property, computed[property as never] as string]),
        );
      };
      const glyphMask = (selector: string) =>
        getComputedStyle(resolve(selector), "::before").maskImage;
      return {
        chatGlyph: { maskImage: glyphMask("#from-text") },
        fromCode: read("#from-code > code"),
        fromText: read("#from-text"),
        panelFromCode: read("#panel-from-code > code"),
        panelFromText: read("#panel-from-text"),
        panelGlyph: { maskImage: glyphMask("#panel-from-text") },
        plainCode: read("#plain-code"),
      };
    }, CHIP_PROPERTIES);
    return probed as PresentationProbe;
  } finally {
    await page.close();
  }
}

describeFileLinkPresentation("chat file link presentation", () => {
  it.each(["light", "dark"] as const)(
    "renders code-authored and text-authored file links identically in %s",
    async (themeMode) => {
      const { fromCode, fromText } = await probe(themeMode);
      expect(fromCode).toEqual(fromText);
    },
  );

  it.each(["light", "dark"] as const)(
    "leaves the chip on code spans that are not file links in %s",
    async (themeMode) => {
      const { fromText, plainCode } = await probe(themeMode);
      // Guards the reset from widening into every code span: the control keeps a
      // painted background and a real border, and the file link has neither.
      expect(plainCode.backgroundColor).not.toBe(fromText.backgroundColor);
      expect(plainCode.borderTopWidth).not.toBe("0px");
      expect(fromText.borderTopWidth).toBe("0px");
      expect(fromText.backgroundColor).toBe("rgba(0, 0, 0, 0)");
    },
  );

  it.each(["light", "dark"] as const)(
    "gives the Chat Detail Panel the same file-link treatment in %s",
    async (themeMode) => {
      const probed = await probe(themeMode);
      // The panel renders the same parser output, so it must not drift from the
      // message bubble: same chip reset, both authoring origins, and the glyph.
      expect(probed.panelFromText).toEqual(probed.fromText);
      expect(probed.panelFromCode).toEqual(probed.fromCode);
      expect(probed.panelGlyph).toEqual(probed.chatGlyph);
      expect(probed.panelGlyph.maskImage).toContain("svg");
    },
  );
});
