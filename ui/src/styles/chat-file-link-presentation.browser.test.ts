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

// The declarations the inline-code chip paints. File-link labels match across
// authoring syntax except for glyph spacing owned by the outer anchor.
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
// in styles/chat.ts — the file-link rules are written to win at that order.
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

// The reported scenario: a numbered list whose prose puts a parenthesized file
// reference near the line edge. The second chip carries a label the parser could
// not shorten to a basename, which is the case that has to stay inside the column.
const LONG_CHIP_PATH = "packages/gateway-protocol/src/session-transport-envelope.ts";

// Cases for the glyph-attachment probe below. `unbroken` has no `/`, `-`, or `_`
// to break on, so only the inherited `overflow-wrap: anywhere` can wrap it —
// the condition that starves the glyph's own line of a break opportunity.
const SEPARATION_CASES = [
  { filePath: "src/app.ts", id: "sep-short", label: "app.ts", line: undefined },
  {
    filePath: "superlongfilenamewithoutanyslashesordashesorspacesatalljustonebigword.ts",
    id: "sep-unbroken",
    label: "superlongfilenamewithoutanyslashesordashesorspacesatalljustonebigword.ts",
    line: undefined,
  },
  { filePath: LONG_CHIP_PATH, id: "sep-path-with-line", label: LONG_CHIP_PATH, line: 182 },
  // Far wider than any column below, so the label must wrap several times: the
  // first cut has to land inside the label, never between glyph and first char.
  {
    filePath: `${"abcdefghij".repeat(24)}.ts`,
    id: "sep-enormous",
    label: `${"abcdefghij".repeat(24)}.ts`,
    line: 7,
  },
  // Non-ASCII labels reach the chip through host-local hrefs, so the glyph has
  // to stay attached to a first character the shortener never produced.
  {
    filePath: "~/repo/docs/spec.md",
    id: "sep-cjk",
    label: "文档/会话传输封装规范化适配器/协议架构第十七版/规范化器.ts",
    line: 88,
  },
] as const;

// Both renderers paint the same parser output, so every wrap invariant has to
// hold in each. The Detail Panel is the one that proves the chip owns its wrap
// policy: .chat-text would hand it one by inheritance, .sidebar-markdown never
// does, and the panel body hides horizontal overflow.
const WRAP_CONTAINERS = ["chat-text", "sidebar-markdown"] as const;
type WrapContainer = (typeof WRAP_CONTAINERS)[number];

const WRAP_CASES = (["light", "dark"] as const).flatMap((themeMode) =>
  WRAP_CONTAINERS.map((container) => ({ container, themeMode })),
);

function wrapFixtureDocument(themeMode: "dark" | "light", container: WrapContainer): string {
  const themeAttributes =
    themeMode === "light" ? `data-theme="light" data-theme-mode="light"` : `data-theme="dark"`;
  const separationLinks = SEPARATION_CASES.map(({ filePath, id, label, line }) => {
    const lineAttribute = line === undefined ? "" : ` data-file-line="${line}"`;
    const linkLabel = line === undefined ? label : `${label}:${line}`;
    return `<p><a id="${id}" class="markdown-file-link" data-file-kind="code"
        data-file-path="${filePath}"${lineAttribute}>${linkLabel}</a></p>`;
  }).join("\n");
  return `<!doctype html><html ${themeAttributes}><head><style>${readChatCss()}</style></head><body>
    <div class="${container}" id="column">
      <ol><li>Reproduce the failing run, then read the harness entry point
        (<a id="wrap-chip" class="markdown-file-link" data-file-kind="code"
          data-file-path="test/harness.ts" data-file-line="182">harness.ts:182</a>)
        before landing the fix.</li></ol>
      <p><a id="long-chip" class="markdown-file-link" data-file-kind="code"
        data-file-path="${LONG_CHIP_PATH}">${LONG_CHIP_PATH}</a></p>
      ${separationLinks}
    </div>
  </body></html>`;
}

type SeparationSample = {
  readonly caseId: (typeof SEPARATION_CASES)[number]["id"];
  readonly columnWidth: number;
  // A full line-height means the glyph is stranded above a label that wrapped
  // away from it; on the same line it is only font-ascent noise.
  readonly glyphToLabelGapPx: number;
  readonly lineHeightPx: number;
  // How far the painted label runs past the column's content edge. max-width
  // caps the chip's box, not the text inside it, so the box measures clean while
  // an unwrappable label still paints into the clipped region.
  readonly labelOverflowPx: number;
  readonly wrapped: boolean;
};

type WrapSample = {
  readonly chipLineCount: number;
  readonly chipTop: number;
  readonly columnWidth: number;
  readonly longChipLineCount: number;
  readonly longChipWidth: number;
};

// Sweeping the column instead of hand-picking one width: the chip has to be
// atomic at every position it can land in, and a single tuned width would stop
// exercising the boundary as soon as the prose or the font metrics move.
async function probeWrap(
  themeMode: "dark" | "light",
  container: WrapContainer,
): Promise<{
  readonly samples: readonly WrapSample[];
  readonly separation: readonly SeparationSample[];
}> {
  const fixtureFile = path.join(fixtureDirectory, `${themeMode}-${container}-wrap.html`);
  fs.writeFileSync(fixtureFile, wrapFixtureDocument(themeMode, container), "utf8");
  const page = await browser.newPage();
  try {
    await page.goto(`file://${fixtureFile}`);
    // No explicit type argument: a lone one binds `evaluate`'s `Arg` to `void`
    // and the case ids arrive untyped. Inference reads both from the call.
    return await page.evaluate(
      (caseIds) => {
        const resolve = (selector: string) => {
          const element = document.querySelector(selector);
          if (!(element instanceof HTMLElement)) {
            throw new Error(`Missing wrap fixture element for ${selector}`);
          }
          return element;
        };
        const column = resolve("#column");
        const chip = resolve("#wrap-chip");
        const longChip = resolve("#long-chip");
        const separationChips = caseIds.map((caseId) => ({
          caseId,
          element: resolve(`#${caseId}`),
        }));
        const samples: WrapSample[] = [];
        const separation: SeparationSample[] = [];
        for (let columnWidth = 220; columnWidth <= 900; columnWidth += 4) {
          column.style.width = `${columnWidth}px`;
          samples.push({
            // One client rect per line fragment: a chip split between its glyph and
            // its label reports two, an atomic chip always reports one.
            chipLineCount: chip.getClientRects().length,
            chipTop: chip.getBoundingClientRect().top,
            columnWidth,
            longChipLineCount: longChip.getClientRects().length,
            longChipWidth: longChip.getBoundingClientRect().width,
          });
        }
        // Its own narrower sweep: a short basename never wraps in a realistic
        // 220-900px column, so that range would leave the vacuity guard below
        // unsatisfiable. This failure is about the space beside the glyph.
        for (let columnWidth = 40; columnWidth <= 320; columnWidth += 4) {
          column.style.width = `${columnWidth}px`;
          const columnRight = column.getBoundingClientRect().right;
          for (const { caseId, element } of separationChips) {
            const elementTop = element.getBoundingClientRect().top;
            const labelTextNode = element.firstChild;
            if (!labelTextNode) {
              throw new Error(`Separation fixture ${caseId} has no label text node`);
            }
            const firstCharacterRange = document.createRange();
            firstCharacterRange.setStart(labelTextNode, 0);
            firstCharacterRange.setEnd(labelTextNode, 1);
            const firstCharacterTop = firstCharacterRange.getBoundingClientRect().top;
            const labelRange = document.createRange();
            labelRange.selectNodeContents(labelTextNode);
            const lineHeightPx = Number.parseFloat(getComputedStyle(element).lineHeight);
            separation.push({
              caseId,
              columnWidth,
              glyphToLabelGapPx: firstCharacterTop - elementTop,
              lineHeightPx,
              labelOverflowPx: labelRange.getBoundingClientRect().right - columnRight,
              wrapped: element.getBoundingClientRect().height > lineHeightPx * 1.3,
            });
          }
        }
        return { samples, separation };
      },
      SEPARATION_CASES.map((testCase) => testCase.id),
    );
  } finally {
    await page.close();
  }
}

type StyleSnapshot = Record<(typeof CHIP_PROPERTIES)[number], string>;
type GlyphSnapshot = {
  readonly fontSize: string;
  readonly height: string;
  readonly maskImage: string;
  readonly paddingInlineStart: string;
  readonly position: string;
  readonly width: string;
};
type PresentationProbe = {
  readonly chatGlyph: GlyphSnapshot;
  readonly fromCode: StyleSnapshot;
  readonly fromText: StyleSnapshot;
  readonly panelFromCode: StyleSnapshot;
  readonly panelFromText: StyleSnapshot;
  readonly panelGlyph: GlyphSnapshot;
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
      const glyph = (selector: string) => {
        const computed = getComputedStyle(resolve(selector), "::before");
        return {
          fontSize: computed.fontSize,
          height: computed.height,
          maskImage: computed.maskImage,
          paddingInlineStart: computed.paddingInlineStart,
          position: computed.position,
          width: computed.width,
        };
      };
      return {
        chatGlyph: glyph("#from-text"),
        fromCode: read("#from-code > code"),
        fromText: read("#from-text"),
        panelFromCode: read("#panel-from-code > code"),
        panelFromText: read("#panel-from-text"),
        panelGlyph: glyph("#panel-from-text"),
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
      // The anchor reserves glyph space; its nested code label must not reserve it again.
      expect(fromCode).toEqual({ ...fromText, paddingLeft: "0px" });
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

  it.each(["light", "dark"] as const)(
    "gives every masked file glyph a concrete font-sized paint box in %s",
    async (themeMode) => {
      const { chatGlyph, panelGlyph } = await probe(themeMode);
      for (const glyph of [chatGlyph, panelGlyph]) {
        expect(glyph.position).toBe("absolute");
        expect(glyph.width).toBe(glyph.fontSize);
        expect(glyph.height).toBe(glyph.fontSize);
        expect(glyph.paddingInlineStart).toBe("0px");
      }
    },
  );

  it.each(WRAP_CASES)(
    "wraps a file link as one unit at every column width in $container/$themeMode",
    async ({ container, themeMode }) => {
      const { samples } = await probeWrap(themeMode, container);
      // Vacuity guard: the chip must actually change lines across the sweep, or
      // the assertion below would pass on a fixture that never wraps at all.
      expect(new Set(samples.map((sample) => Math.round(sample.chipTop))).size).toBeGreaterThan(1);
      const split = samples.filter((sample) => sample.chipLineCount !== 1);
      expect(split).toEqual([]);
    },
  );

  it.each(WRAP_CASES)(
    "keeps an unshortened file label inside the column in $container/$themeMode",
    async ({ container, themeMode }) => {
      const { samples, separation } = await probeWrap(themeMode, container);
      // A label wider than the column wraps inside the chip rather than spilling
      // past it; both scroll containers set overflow-x: hidden, so an overflowing
      // chip would be clipped away instead of merely looking wide.
      const overflowing = samples.filter(
        (sample) => sample.longChipWidth > sample.columnWidth + 0.5,
      );
      expect(overflowing).toEqual([]);
      expect(samples.every((sample) => sample.longChipLineCount === 1)).toBe(true);
      // The separation cases carry the labels with no `/` or `-` to break on, so
      // only the chip's own wrap policy can keep them in the column. Inheriting
      // one from .chat-text is not enough: .sidebar-markdown declares none.
      const spilling = separation.filter((sample) => sample.labelOverflowPx > 0.5);
      expect(spilling).toEqual([]);
    },
  );

  // An inline-block chip reports one client rect from the outside even when the
  // glyph splits from its label inside its own box, so the two tests above
  // cannot see that split. This compares the chip's top — where the glyph
  // paints, being first in the box — against the label's first character: same
  // line is font-ascent noise, a stranded glyph is a full line-height.
  it.each(WRAP_CASES)(
    "keeps the glyph attached to the label's first character in $container/$themeMode",
    async ({ container, themeMode }) => {
      const { separation } = await probeWrap(themeMode, container);
      for (const testCase of SEPARATION_CASES) {
        const caseSamples = separation.filter((sample) => sample.caseId === testCase.id);
        expect(caseSamples.length).toBeGreaterThan(0);
        // Vacuity guard: each case must actually wrap somewhere in the sweep, or
        // the no-separation assertion below would pass on a chip that never
        // reflows at all.
        expect(caseSamples.some((sample) => sample.wrapped)).toBe(true);
        const separated = caseSamples.filter(
          (sample) => sample.glyphToLabelGapPx > sample.lineHeightPx / 2,
        );
        expect(separated).toEqual([]);
      }
    },
  );
});
