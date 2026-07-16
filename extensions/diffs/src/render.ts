import type { FileContents, FileDiffMetadata, SupportedLanguages } from "@pierre/diffs";
import { parsePatchFiles } from "@pierre/diffs";
import { preloadFileDiff, preloadMultiFileDiff } from "@pierre/diffs/ssr";
import {
  collectDiffPayloadLanguageHints,
  normalizeDiffViewerPayloadLanguages,
  normalizeSupportedLanguageHint,
} from "./language-hints.js";
import { ensurePierreThemesRegistered } from "./pierre-themes.js";
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

function escapeCssString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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

function buildDiffOptions(options: DiffRenderOptions): DiffViewerOptions {
  const fontFamily = escapeCssString(options.presentation.fontFamily);
  const fontSize = Math.max(10, Math.floor(options.presentation.fontSize));
  const lineHeight = Math.max(20, Math.round(fontSize * options.presentation.lineSpacing));
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
      fontSize: Math.max(16, options.presentation.fontSize),
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

function renderDiffCard(payload: DiffViewerPayload): string {
  return `<section class="oc-diff-card">
    <diffs-container class="oc-diff-host" data-openclaw-diff-host>
      <template shadowrootmode="open">${payload.prerenderedHTML}</template>
    </diffs-container>
    <script type="application/json" data-openclaw-diff-payload>${escapeJsonScript(payload)}</script>
  </section>`;
}

function buildHtmlDocument(params: {
  title: string;
  bodyHtml: string;
  theme: DiffRenderOptions["presentation"]["theme"];
  imageMaxWidth: number;
  runtimeMode: "viewer" | "image";
}): string {
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

      .oc-frame[data-render-mode="image"] .oc-diff-card {
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
    <script type="module" src="${VIEWER_LOADER_DOCUMENT_PATH}"></script>
  </body>
</html>`;
}

type RenderedSection = {
  viewer?: string;
  image?: string;
};

function buildRenderedSection(params: {
  viewerPayload?: DiffViewerPayload;
  imagePayload?: DiffViewerPayload;
}): RenderedSection {
  return {
    ...(params.viewerPayload ? { viewer: renderDiffCard(params.viewerPayload) } : {}),
    ...(params.imagePayload ? { image: renderDiffCard(params.imagePayload) } : {}),
  };
}

function buildRenderedBodies(sections: ReadonlyArray<RenderedSection>): {
  viewerBodyHtml?: string;
  imageBodyHtml?: string;
} {
  const viewerSections = sections.flatMap((section) => (section.viewer ? [section.viewer] : []));
  const imageSections = sections.flatMap((section) => (section.image ? [section.image] : []));
  return {
    ...(viewerSections.length > 0 ? { viewerBodyHtml: viewerSections.join("\n") } : {}),
    ...(imageSections.length > 0 ? { imageBodyHtml: imageSections.join("\n") } : {}),
  };
}

async function renderBeforeAfterDiff(
  input: Extract<DiffInput, { kind: "before_after" }>,
  options: DiffRenderOptions,
  target: DiffRenderTarget,
): Promise<{ viewerBodyHtml?: string; imageBodyHtml?: string; fileCount: number }> {
  ensurePierreThemesRegistered();

  const lang = await normalizeSupportedLanguageHint(input.lang);
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
  const [viewerResult, imageResult] = await Promise.all([
    viewerOptions
      ? preloadMultiFileDiffWithFallback({
          oldFile,
          newFile,
          options: viewerOptions,
        })
      : Promise.resolve(undefined),
    imageOptions
      ? preloadMultiFileDiffWithFallback({
          oldFile,
          newFile,
          options: imageOptions,
        })
      : Promise.resolve(undefined),
  ]);
  const [viewerPayload, imagePayload] = await Promise.all([
    viewerResult && viewerOptions
      ? normalizeDiffViewerPayloadLanguages({
          prerenderedHTML: viewerResult.prerenderedHTML,
          oldFile: viewerResult.oldFile,
          newFile: viewerResult.newFile,
          options: viewerOptions,
          langs: collectDiffPayloadLanguageHints({
            oldFile: viewerResult.oldFile,
            newFile: viewerResult.newFile,
          }),
        })
      : Promise.resolve(undefined),
    imageResult && imageOptions
      ? normalizeDiffViewerPayloadLanguages({
          prerenderedHTML: imageResult.prerenderedHTML,
          oldFile: imageResult.oldFile,
          newFile: imageResult.newFile,
          options: imageOptions,
          langs: collectDiffPayloadLanguageHints({
            oldFile: imageResult.oldFile,
            newFile: imageResult.newFile,
          }),
        })
      : Promise.resolve(undefined),
  ]);
  const section = buildRenderedSection({
    ...(viewerPayload ? { viewerPayload } : {}),
    ...(imagePayload ? { imagePayload } : {}),
  });

  return {
    ...buildRenderedBodies([section]),
    fileCount: 1,
  };
}

async function renderPatchDiff(
  input: Extract<DiffInput, { kind: "patch" }>,
  options: DiffRenderOptions,
  target: DiffRenderTarget,
): Promise<{ viewerBodyHtml?: string; imageBodyHtml?: string; fileCount: number }> {
  ensurePierreThemesRegistered();

  const files = parsePatchFiles(input.patch).flatMap((entry) => entry.files ?? []);
  if (files.length === 0) {
    throw new Error("Patch input did not contain any file diffs.");
  }
  if (files.length > MAX_PATCH_FILE_COUNT) {
    throw new Error(`Patch input contains too many files (max ${MAX_PATCH_FILE_COUNT}).`);
  }
  const totalLines = files.reduce((sum, fileDiff) => {
    const splitLines = Number.isFinite(fileDiff.splitLineCount) ? fileDiff.splitLineCount : 0;
    const unifiedLines = Number.isFinite(fileDiff.unifiedLineCount) ? fileDiff.unifiedLineCount : 0;
    return sum + Math.max(splitLines, unifiedLines, 0);
  }, 0);
  if (totalLines > MAX_PATCH_TOTAL_LINES) {
    throw new Error(`Patch input is too large to render (max ${MAX_PATCH_TOTAL_LINES} lines).`);
  }

  const { viewerOptions, imageOptions } = buildRenderVariants({ options, target });
  const sections = await Promise.all(
    files.map(async (fileDiff) => {
      const [viewerResult, imageResult] = await Promise.all([
        viewerOptions
          ? preloadFileDiffWithFallback({
              fileDiff,
              options: viewerOptions,
            })
          : Promise.resolve(undefined),
        imageOptions
          ? preloadFileDiffWithFallback({
              fileDiff,
              options: imageOptions,
            })
          : Promise.resolve(undefined),
      ]);

      const [viewerPayload, imagePayload] = await Promise.all([
        viewerResult && viewerOptions
          ? normalizeDiffViewerPayloadLanguages({
              prerenderedHTML: viewerResult.prerenderedHTML,
              fileDiff: viewerResult.fileDiff,
              options: viewerOptions,
              langs: collectDiffPayloadLanguageHints({ fileDiff: viewerResult.fileDiff }),
            })
          : Promise.resolve(undefined),
        imageResult && imageOptions
          ? normalizeDiffViewerPayloadLanguages({
              prerenderedHTML: imageResult.prerenderedHTML,
              fileDiff: imageResult.fileDiff,
              options: imageOptions,
              langs: collectDiffPayloadLanguageHints({ fileDiff: imageResult.fileDiff }),
            })
          : Promise.resolve(undefined),
      ]);

      return buildRenderedSection({
        ...(viewerPayload ? { viewerPayload } : {}),
        ...(imagePayload ? { imagePayload } : {}),
      });
    }),
  );

  return {
    ...buildRenderedBodies(sections),
    fileCount: files.length,
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

  return {
    ...(rendered.viewerBodyHtml
      ? {
          html: buildHtmlDocument({
            title,
            bodyHtml: rendered.viewerBodyHtml,
            theme: options.presentation.theme,
            imageMaxWidth: options.image.maxWidth,
            runtimeMode: "viewer",
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
            runtimeMode: "image",
          }),
        }
      : {}),
    title,
    fileCount: rendered.fileCount,
    inputKind: input.kind,
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
