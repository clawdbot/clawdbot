// Diffs plugin module implements render behavior.
import type { FileContents, FileDiffMetadata, SupportedLanguages } from "@pierre/diffs";
import { parsePatchFiles } from "@pierre/diffs";
import { preloadFileDiff, preloadMultiFileDiff } from "@pierre/diffs/ssr";
import { escapeHtml } from "openclaw/plugin-sdk/text-utility-runtime";
import { normalizeDiffFontSize, normalizeDiffLineSpacing } from "./config.js";
import {
  collectDiffPayloadLanguageHints,
  isBaseDiffViewerLanguage,
  normalizeDiffViewerPayloadLanguages,
  normalizeSupportedLanguageHint,
} from "./language-hints.js";
import type {
  DiffInput,
  DiffRenderOptions,
  DiffRenderTarget,
  DiffViewerOptions,
  DiffViewerPayload,
  RenderedDiffDocument,
} from "./types.js";

const DEFAULT_FILE_NAME = "diff.txt";
const MAX_PATCH_FILE_COUNT = 128;
const MAX_PATCH_TOTAL_LINES = 120_000;
const VIEWER_LOADER_DOCUMENT_PATH = "../../assets/viewer.js";
const LANGUAGE_PACK_VIEWER_LOADER_DOCUMENT_PATH = "../../../diffs-language-pack/assets/viewer.js";

export class DiffRenderInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiffRenderInputError";
  }
}

function escapeCssString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function escapeJsonScript(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function buildDiffTitle(input: DiffInput): string {
  if (input.title?.trim()) {
    return input.title.trim();
  }
  if (input.kind === "before_after") {
    return input.path?.trim() || "Text diff";
  }
  return "Patch diff";
}

function resolveBeforeAfterFileName(params: {
  input: Extract<DiffInput, { kind: "before_after" }>;
  lang?: SupportedLanguages;
}): string {
  const { input, lang } = params;
  if (input.path?.trim()) {
    return input.path.trim();
  }
  if (lang && lang !== "text") {
    return `diff.${lang.replace(/^\.+/, "")}`;
  }
  return DEFAULT_FILE_NAME;
}

function resolveDiffTypography(presentation: DiffRenderOptions["presentation"]): {
  fontSize: number;
  lineHeight: number;
} {
  const fontSize = normalizeDiffFontSize(presentation.fontSize);
  const lineSpacing = normalizeDiffLineSpacing(presentation.lineSpacing);
  const lineHeight = Math.max(20, Math.round(fontSize * lineSpacing));
  return { fontSize, lineHeight };
}

function buildDiffOptions(options: DiffRenderOptions): DiffViewerOptions {
  const fontFamily = escapeCssString(options.presentation.fontFamily);
  const { fontSize, lineHeight } = resolveDiffTypography(options.presentation);
  return {
    theme: {
      light: "pierre-light",
      dark: "pierre-dark",
    },
    diffStyle: options.presentation.layout,
    diffIndicators: options.presentation.diffIndicators,
    disableLineNumbers: !options.presentation.showLineNumbers,
    expandUnchanged: options.expandUnchanged,
    themeType: options.presentation.theme,
    backgroundEnabled: options.presentation.background,
    overflow: options.presentation.wordWrap ? "wrap" : "scroll",
    unsafeCSS: `
      :host {
        --diffs-font-family: "${fontFamily}", "SF Mono", Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
        --diffs-header-font-family: "${fontFamily}", "SF Mono", Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
        --diffs-font-size: ${fontSize}px;
        --diffs-line-height: ${lineHeight}px;
      }

      [data-diffs-header] {
        min-height: 64px;
        padding-inline: 18px 14px;
      }

      [data-header-content] {
        gap: 10px;
      }

      [data-metadata] {
        gap: 10px;
      }

      .oc-diff-toolbar {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        margin-inline-start: 6px;
        flex: 0 0 auto;
      }

      .oc-diff-toolbar-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        padding: 0;
        margin: 0;
        border: 0;
        border-radius: 0;
        background: transparent;
        color: inherit;
        cursor: pointer;
        opacity: 0.6;
        line-height: 0;
        overflow: visible;
        transition: opacity 120ms ease;
        flex: 0 0 auto;
      }

      .oc-diff-toolbar-button:hover {
        opacity: 1;
      }

      .oc-diff-toolbar-button[data-active="true"] {
        opacity: 0.92;
      }

      .oc-diff-toolbar-button svg {
        display: block;
        width: 16px;
        height: 16px;
        min-width: 16px;
        min-height: 16px;
        overflow: visible;
        flex: 0 0 auto;
        color: inherit;
        fill: currentColor;
        pointer-events: none;
      }
    `,
  };
}

function buildImageRenderOptions(options: DiffRenderOptions): DiffRenderOptions {
  return {
    ...options,
    presentation: {
      ...options.presentation,
      fontSize: Math.max(16, normalizeDiffFontSize(options.presentation.fontSize)),
    },
  };
}

function shouldRenderViewer(target: DiffRenderTarget): boolean {
  return target === "viewer" || target === "both";
}

function shouldRenderImage(target: DiffRenderTarget): boolean {
  return target === "image" || target === "both";
}

function buildRenderVariants(params: { options: DiffRenderOptions; target: DiffRenderTarget }): {
  viewerOptions?: DiffViewerOptions;
  imageOptions?: DiffViewerOptions;
} {
  return {
    ...(shouldRenderViewer(params.target)
      ? { viewerOptions: buildDiffOptions(params.options) }
      : {}),
    ...(shouldRenderImage(params.target)
      ? { imageOptions: buildDiffOptions(buildImageRenderOptions(params.options)) }
      : {}),
  };
}

function renderDiffCard(payload: DiffViewerPayload, anchorId?: string): string {
  return `<section class="oc-diff-card"${anchorId ? ` id="${anchorId}"` : ""}>
    <diffs-container class="oc-diff-host" data-openclaw-diff-host>
      <template shadowrootmode="open">${payload.prerenderedHTML}</template>
    </diffs-container>
    <script type="application/json" data-openclaw-diff-payload>${escapeJsonScript(payload)}</script>
  </section>`;
}

type FileDiffStats = {
  additions: number;
  deletions: number;
};

type FileNavEntry = {
  anchorId: string;
  fileDiff: FileDiffMetadata;
  stats: FileDiffStats;
};

// Hunk.additionLines/deletionLines count only +/- lines (not context), so the
// sums match the built-in per-file header counts rendered by @pierre/diffs.
function computeFileDiffStats(fileDiff: FileDiffMetadata): FileDiffStats {
  let additions = 0;
  let deletions = 0;
  for (const hunk of fileDiff.hunks) {
    additions += hunk.additionLines;
    deletions += hunk.deletionLines;
  }
  return { additions, deletions };
}

function renderNavChangeBadge(changeType: FileDiffMetadata["type"]): string {
  const label =
    changeType === "new"
      ? "added"
      : changeType === "deleted"
        ? "deleted"
        : changeType === "rename-pure" || changeType === "rename-changed"
          ? "renamed"
          : undefined;
  return label ? `<span class="oc-diff-nav-badge" data-change="${label}">${label}</span>` : "";
}

function renderNavStats(stats: FileDiffStats): string {
  return `<span class="oc-diff-nav-stats"><span class="oc-diff-nav-additions">+${stats.additions}</span><span class="oc-diff-nav-deletions">-${stats.deletions}</span></span>`;
}

function renderNavEntryName(fileDiff: FileDiffMetadata): string {
  const renamed = fileDiff.prevName && fileDiff.prevName !== fileDiff.name;
  return renamed
    ? `${escapeHtml(fileDiff.prevName ?? "")} &rarr; ${escapeHtml(fileDiff.name)}`
    : escapeHtml(fileDiff.name);
}

// Multi-file patches render as stacked cards; this summary card gives per-file
// stats plus anchor links so long diffs stay navigable without extra JS.
function renderFileSummaryNav(entries: ReadonlyArray<FileNavEntry>): string {
  const totals = entries.reduce<FileDiffStats>(
    (sum, entry) => ({
      additions: sum.additions + entry.stats.additions,
      deletions: sum.deletions + entry.stats.deletions,
    }),
    { additions: 0, deletions: 0 },
  );
  const items = entries
    .map(
      (entry) =>
        `<li><a href="#${entry.anchorId}"><code>${renderNavEntryName(entry.fileDiff)}</code></a>${renderNavChangeBadge(entry.fileDiff.type)}${renderNavStats(entry.stats)}</li>`,
    )
    .join("\n      ");
  return `<nav class="oc-diff-card oc-diff-nav" aria-label="Changed files">
    <p class="oc-diff-nav-summary">${entries.length} changed files${renderNavStats(totals)}</p>
    <ol class="oc-diff-nav-list">
      ${items}
    </ol>
  </nav>`;
}

function buildHtmlDocument(params: {
  title: string;
  bodyHtml: string;
  theme: DiffRenderOptions["presentation"]["theme"];
  imageMaxWidth: number;
  imageTypography: {
    fontSize: number;
    lineHeight: number;
  };
  runtimeMode: "viewer" | "image";
  viewerRuntime: "base" | "language-pack";
}): string {
  const viewerLoaderPath =
    params.viewerRuntime === "language-pack"
      ? LANGUAGE_PACK_VIEWER_LOADER_DOCUMENT_PATH
      : VIEWER_LOADER_DOCUMENT_PATH;
  const imageTypographyCss =
    params.runtimeMode === "image"
      ? `
      .oc-frame[data-render-mode="image"] .oc-diff-host {
        --diffs-font-size: ${params.imageTypography.fontSize}px;
        --diffs-line-height: ${params.imageTypography.lineHeight}px;
      }
`
      : "";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="dark light" />
    <title>${escapeHtml(params.title)}</title>
    <style>
      * {
        box-sizing: border-box;
      }

      html,
      body {
        min-height: 100%;
      }

      html {
        background: #05070b;
        scroll-behavior: smooth;
      }

      @media (prefers-reduced-motion: reduce) {
        html {
          scroll-behavior: auto;
        }
      }

      body {
        margin: 0;
        min-height: 100vh;
        padding: 22px;
        font-family:
          "Fira Code",
          "SF Mono",
          Monaco,
          Consolas,
          monospace;
        background: #05070b;
        color: #f8fafc;
      }

      body[data-theme="light"] {
        background: #f3f5f8;
        color: #0f172a;
      }

      .oc-frame {
        max-width: 1560px;
        margin: 0 auto;
      }

      .oc-frame[data-render-mode="image"] {
        max-width: ${Math.max(640, Math.round(params.imageMaxWidth))}px;
      }
${imageTypographyCss}

      [data-openclaw-diff-root] {
        display: grid;
        gap: 18px;
      }

      .oc-diff-card {
        overflow: hidden;
        border-radius: 18px;
        border: 1px solid rgba(148, 163, 184, 0.16);
        background: rgba(15, 23, 42, 0.14);
        box-shadow: 0 18px 48px rgba(2, 6, 23, 0.22);
      }

      body[data-theme="light"] .oc-diff-card {
        border-color: rgba(148, 163, 184, 0.22);
        background: rgba(255, 255, 255, 0.92);
        box-shadow: 0 14px 32px rgba(15, 23, 42, 0.08);
      }

      .oc-diff-host {
        display: block;
      }

      .oc-diff-nav {
        padding: 14px 18px;
        font-size: 13px;
        line-height: 1.5;
      }

      .oc-diff-nav-summary {
        display: flex;
        align-items: center;
        margin: 0 0 10px;
        font-weight: 600;
      }

      .oc-diff-nav-list {
        display: grid;
        gap: 4px;
        margin: 0;
        padding: 0;
        list-style: none;
      }

      .oc-diff-nav-list li {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
      }

      .oc-diff-nav-list code {
        overflow-wrap: anywhere;
      }

      .oc-diff-nav-list a {
        color: inherit;
        text-decoration: none;
        min-width: 0;
      }

      .oc-diff-nav-list a:hover {
        text-decoration: underline;
      }

      .oc-diff-nav-stats {
        display: inline-flex;
        gap: 8px;
        margin-inline-start: auto;
        padding-inline-start: 12px;
        font-variant-numeric: tabular-nums;
        font-weight: 600;
        white-space: nowrap;
      }

      .oc-diff-nav-summary .oc-diff-nav-stats {
        margin-inline-start: 10px;
        padding-inline-start: 0;
      }

      .oc-diff-nav-additions {
        color: #4ade80;
      }

      .oc-diff-nav-deletions {
        color: #f87171;
      }

      .oc-diff-nav-badge {
        flex: 0 0 auto;
        padding: 1px 7px;
        border-radius: 999px;
        border: 1px solid rgba(148, 163, 184, 0.32);
        font-size: 11px;
        opacity: 0.85;
      }

      body[data-theme="light"] .oc-diff-nav-additions {
        color: #15803d;
      }

      body[data-theme="light"] .oc-diff-nav-deletions {
        color: #b91c1c;
      }

      /* Nav summary cards are short; the diff-card floor would pad them with
         empty space in static PNG/PDF captures. */
      .oc-frame[data-render-mode="image"] .oc-diff-card:not(.oc-diff-nav) {
        min-height: 240px;
      }

      @media (max-width: 720px) {
        body {
          padding: 12px;
        }

        [data-openclaw-diff-root] {
          gap: 12px;
        }
      }
    </style>
  </head>
  <body data-theme="${params.theme}">
    <main class="oc-frame" data-render-mode="${params.runtimeMode}">
      <div data-openclaw-diff-root>
        ${params.bodyHtml}
      </div>
    </main>
    <script type="module" src="${viewerLoaderPath}"></script>
  </body>
</html>`;
}

type RenderedSection = {
  viewer?: string;
  image?: string;
  usesLanguagePack?: boolean;
};

function payloadUsesLanguagePack(payload: DiffViewerPayload | undefined): boolean {
  return payload?.langs.some((lang) => !isBaseDiffViewerLanguage(lang)) ?? false;
}

function buildRenderedSection(params: {
  viewerPayload?: DiffViewerPayload;
  imagePayload?: DiffViewerPayload;
  anchorId?: string;
}): RenderedSection {
  return {
    ...(params.viewerPayload
      ? { viewer: renderDiffCard(params.viewerPayload, params.anchorId) }
      : {}),
    ...(params.imagePayload ? { image: renderDiffCard(params.imagePayload, params.anchorId) } : {}),
    usesLanguagePack:
      payloadUsesLanguagePack(params.viewerPayload) || payloadUsesLanguagePack(params.imagePayload),
  };
}

function buildRenderedBodies(
  sections: ReadonlyArray<RenderedSection>,
  leadingHtml?: string,
): {
  viewerBodyHtml?: string;
  imageBodyHtml?: string;
} {
  const lead = leadingHtml ? [leadingHtml] : [];
  const viewerSections = sections.flatMap((section) => (section.viewer ? [section.viewer] : []));
  const imageSections = sections.flatMap((section) => (section.image ? [section.image] : []));
  return {
    ...(viewerSections.length > 0
      ? { viewerBodyHtml: [...lead, ...viewerSections].join("\n") }
      : {}),
    ...(imageSections.length > 0 ? { imageBodyHtml: [...lead, ...imageSections].join("\n") } : {}),
  };
}

async function renderBeforeAfterDiff(
  input: Extract<DiffInput, { kind: "before_after" }>,
  options: DiffRenderOptions,
  target: DiffRenderTarget,
): Promise<{
  viewerBodyHtml?: string;
  imageBodyHtml?: string;
  fileCount: number;
  usesLanguagePack: boolean;
}> {
  const languagePackAvailable = options.languagePackAvailable === true;
  const lang = await normalizeSupportedLanguageHint(input.lang, { languagePackAvailable });
  const fileName = resolveBeforeAfterFileName({ input, lang });
  const oldFile: FileContents = {
    name: fileName,
    contents: input.before,
    ...(lang ? { lang } : {}),
  };
  const newFile: FileContents = {
    name: fileName,
    contents: input.after,
    ...(lang ? { lang } : {}),
  };
  const { viewerOptions, imageOptions } = buildRenderVariants({ options, target });
  const preloadOptions = viewerOptions ?? imageOptions;
  if (!preloadOptions) {
    throw new Error(`Unsupported diff render target: ${target}`);
  }
  const preloadResult = await preloadMultiFileDiffWithFallback({
    oldFile,
    newFile,
    options: preloadOptions,
  });
  const normalizedPayload = await normalizeDiffViewerPayloadLanguages(
    {
      prerenderedHTML: preloadResult.prerenderedHTML,
      oldFile: preloadResult.oldFile,
      newFile: preloadResult.newFile,
      options: preloadOptions,
      langs: collectDiffPayloadLanguageHints({
        oldFile: preloadResult.oldFile,
        newFile: preloadResult.newFile,
      }),
    },
    { languagePackAvailable },
  );
  const viewerPayload = viewerOptions
    ? { ...normalizedPayload, options: viewerOptions }
    : undefined;
  const imagePayload = imageOptions ? { ...normalizedPayload, options: imageOptions } : undefined;
  const section = buildRenderedSection({
    ...(viewerPayload ? { viewerPayload } : {}),
    ...(imagePayload ? { imagePayload } : {}),
  });

  return {
    ...buildRenderedBodies([section]),
    fileCount: 1,
    usesLanguagePack: section.usesLanguagePack === true,
  };
}

async function renderPatchDiff(
  input: Extract<DiffInput, { kind: "patch" }>,
  options: DiffRenderOptions,
  target: DiffRenderTarget,
): Promise<{
  viewerBodyHtml?: string;
  imageBodyHtml?: string;
  fileCount: number;
  usesLanguagePack: boolean;
}> {
  const languagePackAvailable = options.languagePackAvailable === true;
  const files = await Promise.all(
    parsePatchFiles(input.patch)
      .flatMap((entry) => entry.files ?? [])
      .map((fileDiff) => normalizePatchFileLanguage(fileDiff, { languagePackAvailable })),
  );
  if (files.length === 0) {
    throw new DiffRenderInputError("Patch input did not contain any file diffs.");
  }
  if (files.length > MAX_PATCH_FILE_COUNT) {
    throw new DiffRenderInputError(
      `Patch input contains too many files (max ${MAX_PATCH_FILE_COUNT}).`,
    );
  }
  const totalLines = files.reduce((sum, fileDiff) => {
    const splitLines = Number.isFinite(fileDiff.splitLineCount) ? fileDiff.splitLineCount : 0;
    const unifiedLines = Number.isFinite(fileDiff.unifiedLineCount) ? fileDiff.unifiedLineCount : 0;
    return sum + Math.max(splitLines, unifiedLines, 0);
  }, 0);
  if (totalLines > MAX_PATCH_TOTAL_LINES) {
    throw new DiffRenderInputError(
      `Patch input is too large to render (max ${MAX_PATCH_TOTAL_LINES} lines).`,
    );
  }

  const { viewerOptions, imageOptions } = buildRenderVariants({ options, target });
  const preloadOptions = viewerOptions ?? imageOptions;
  if (!preloadOptions) {
    throw new Error(`Unsupported diff render target: ${target}`);
  }
  const navEntries: FileNavEntry[] = files.map((fileDiff, index) => ({
    anchorId: `oc-diff-file-${index + 1}`,
    fileDiff,
    stats: computeFileDiffStats(fileDiff),
  }));
  const sections = await Promise.all(
    files.map(async (fileDiff, index) => {
      const preloadResult = await preloadFileDiffWithFallback({
        fileDiff,
        options: preloadOptions,
      });
      const normalizedPayload = await normalizeDiffViewerPayloadLanguages(
        {
          prerenderedHTML: preloadResult.prerenderedHTML,
          fileDiff: preloadResult.fileDiff,
          options: preloadOptions,
          langs: collectDiffPayloadLanguageHints({ fileDiff: preloadResult.fileDiff }),
        },
        { languagePackAvailable },
      );
      const viewerPayload = viewerOptions
        ? { ...normalizedPayload, options: viewerOptions }
        : undefined;
      const imagePayload = imageOptions
        ? { ...normalizedPayload, options: imageOptions }
        : undefined;

      return buildRenderedSection({
        ...(viewerPayload ? { viewerPayload } : {}),
        ...(imagePayload ? { imagePayload } : {}),
        anchorId: navEntries[index]?.anchorId,
      });
    }),
  );
  // Single-file patches skip the summary card; one file needs no navigation.
  const navHtml = files.length > 1 ? renderFileSummaryNav(navEntries) : undefined;

  return {
    ...buildRenderedBodies(sections, navHtml),
    fileCount: files.length,
    usesLanguagePack: sections.some((section) => section.usesLanguagePack === true),
  };
}

async function normalizePatchFileLanguage(
  fileDiff: FileDiffMetadata,
  options: { languagePackAvailable: boolean },
): Promise<FileDiffMetadata> {
  const lang = await normalizeSupportedLanguageHint(fileDiff.lang, options);
  if (lang === fileDiff.lang) {
    return fileDiff;
  }
  return {
    ...fileDiff,
    ...(lang ? { lang } : { lang: "text" }),
  };
}

export async function renderDiffDocument(
  input: DiffInput,
  options: DiffRenderOptions,
  target: DiffRenderTarget = "both",
): Promise<RenderedDiffDocument> {
  const title = buildDiffTitle(input);
  const rendered =
    input.kind === "before_after"
      ? await renderBeforeAfterDiff(input, options, target)
      : await renderPatchDiff(input, options, target);
  const viewerRuntime = rendered.usesLanguagePack ? "language-pack" : "base";
  const imageTypography = resolveDiffTypography(buildImageRenderOptions(options).presentation);

  return {
    ...(rendered.viewerBodyHtml
      ? {
          html: buildHtmlDocument({
            title,
            bodyHtml: rendered.viewerBodyHtml,
            theme: options.presentation.theme,
            imageMaxWidth: options.image.maxWidth,
            imageTypography,
            runtimeMode: "viewer",
            viewerRuntime,
          }),
        }
      : {}),
    ...(rendered.imageBodyHtml
      ? {
          imageHtml: buildHtmlDocument({
            title,
            bodyHtml: rendered.imageBodyHtml,
            theme: options.presentation.theme,
            imageMaxWidth: options.image.maxWidth,
            imageTypography,
            runtimeMode: "image",
            viewerRuntime,
          }),
        }
      : {}),
    title,
    fileCount: rendered.fileCount,
    inputKind: input.kind,
    viewerRuntime,
  };
}

type PreloadedFileDiffResult = Awaited<ReturnType<typeof preloadFileDiff>>;
type PreloadedMultiFileDiffResult = Awaited<ReturnType<typeof preloadMultiFileDiff>>;

function shouldFallbackToClientHydration(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    error.message.includes('needs an import attribute of "type: json"')
  );
}

async function preloadFileDiffWithFallback(params: {
  fileDiff: FileDiffMetadata;
  options: DiffViewerOptions;
}): Promise<PreloadedFileDiffResult> {
  try {
    return await preloadFileDiff(params);
  } catch (error) {
    if (!shouldFallbackToClientHydration(error)) {
      throw error;
    }
    return {
      fileDiff: params.fileDiff,
      prerenderedHTML: "",
    };
  }
}

async function preloadMultiFileDiffWithFallback(params: {
  oldFile: FileContents;
  newFile: FileContents;
  options: DiffViewerOptions;
}): Promise<PreloadedMultiFileDiffResult> {
  try {
    return await preloadMultiFileDiff(params);
  } catch (error) {
    if (!shouldFallbackToClientHydration(error)) {
      throw error;
    }
    return {
      oldFile: params.oldFile,
      newFile: params.newFile,
      prerenderedHTML: "",
    };
  }
}
