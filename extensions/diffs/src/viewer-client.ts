import { FileDiff, preloadHighlighter } from "@pierre/diffs";
import type {
  FileContents,
  FileDiffMetadata,
  FileDiffOptions,
  SupportedLanguages,
} from "@pierre/diffs";
import { normalizeDiffViewerPayloadLanguages } from "./language-hints.js";
import type { DiffViewerPayload, DiffLayout, DiffTheme } from "./types.js";
import { parseViewerPayloadJson } from "./viewer-payload.js";

type ViewerState = {
  theme: DiffTheme;
  layout: DiffLayout;
  backgroundEnabled: boolean;
  wrapEnabled: boolean;
};

type DiffController = {
  payload: DiffViewerPayload;
  diff: FileDiff;
};

const controllers: DiffController[] = [];

const viewerState: ViewerState = {
  theme: "dark",
  layout: "unified",
  backgroundEnabled: true,
  wrapEnabled: true,
};

function parsePayload(element: HTMLScriptElement): DiffViewerPayload {
  const raw = element.textContent?.trim();
  if (!raw) {
    throw new Error("Diff payload was empty.");
  }
  return parseViewerPayloadJson(raw);
}

function getCards(): Array<{ host: HTMLElement; payload: DiffViewerPayload }> {
  const cards: Array<{ host: HTMLElement; payload: DiffViewerPayload }> = [];
  for (const card of document.querySelectorAll<HTMLElement>(".oc-diff-card")) {
    const host = card.querySelector<HTMLElement>("[data-openclaw-diff-host]");
    const payloadNode = card.querySelector<HTMLScriptElement>("[data-openclaw-diff-payload]");
    if (!host || !payloadNode) {
      continue;
    }

    try {
      cards.push({ host, payload: parsePayload(payloadNode) });
    } catch (error) {
      console.warn("Skipping invalid diff payload", error);
    }
  }
  return cards;
}

function ensureShadowRoot(host: HTMLElement): void {
  if (host.shadowRoot) {
    return;
  }
  const template = host.querySelector<HTMLTemplateElement>(
    ":scope > template[shadowrootmode='open']",
  );
  if (!template) {
    return;
  }
  const shadowRoot = host.attachShadow({ mode: "open" });
  shadowRoot.append(template.content.cloneNode(true));
  template.remove();
}

function getHydrateProps(payload: DiffViewerPayload): {
  fileDiff?: FileDiffMetadata;
  oldFile?: FileContents;
  newFile?: FileContents;
} {
  if (payload.fileDiff) {
    return { fileDiff: payload.fileDiff };
  }
  return {
    oldFile: payload.oldFile,
    newFile: payload.newFile,
  };
}

function createToolbarButton(params: {
  title: string;
  active: boolean;
  iconMarkup: string;
  onClick: () => void;
}): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "oc-diff-toolbar-button";
  button.dataset.active = String(params.active);
  button.title = params.title;
  button.setAttribute("aria-label", params.title);
  button.innerHTML = params.iconMarkup;
  applyToolbarButtonStyles(button, params.active);
  button.addEventListener("click", (event) => {
    event.preventDefault();
    params.onClick();
  });
  return button;
}

function applyToolbarStyles(toolbar: HTMLElement): void {
  toolbar.style.display = "inline-flex";
  toolbar.style.alignItems = "center";
  toolbar.style.gap = "6px";
  toolbar.style.marginInlineStart = "6px";
  toolbar.style.flex = "0 0 auto";
}

function applyToolbarButtonStyles(button: HTMLButtonElement, active: boolean): void {
  button.style.display = "inline-flex";
  button.style.alignItems = "center";
  button.style.justifyContent = "center";
  button.style.width = "24px";
  button.style.height = "24px";
  button.style.padding = "0";
  button.style.margin = "0";
  button.style.border = "0";
  button.style.borderRadius = "0";
  button.style.background = "transparent";
  button.style.boxShadow = "none";
  button.style.lineHeight = "0";
  button.style.cursor = "pointer";
  button.style.overflow = "visible";
  button.style.flex = "0 0 auto";
  button.style.opacity = active ? "0.92" : "0.6";
  button.style.color =
    viewerState.theme === "dark" ? "rgba(226, 232, 240, 0.74)" : "rgba(15, 23, 42, 0.52)";
  button.dataset.active = String(active);
  const icon = button.querySelector("svg");
  if (!icon) {
    return;
  }
  icon.style.display = "block";
  icon.style.width = "16px";
  icon.style.height = "16px";
  icon.style.minWidth = "16px";
  icon.style.minHeight = "16px";
  icon.style.overflow = "visible";
  icon.style.flex = "0 0 auto";
  icon.style.color = "inherit";
  icon.style.fill = "currentColor";
  icon.style.pointerEvents = "none";
}

function splitIcon(): string {
  return `<svg viewBox="0 0 16 16" aria-hidden="true">
    <path fill="currentColor" d="M14 0H8.5v16H14a2 2 0 0 0 2-2V2a2 2 0 0 0-2-2m-1.5 6.5v1h1a.5.5 0 0 1 0 1h-1v1a.5.5 0 0 1-1 0v-1h-1a.5.5 0 0 1 0-1h1v-1a.5.5 0 0 1 1 0"></path>
    <path fill="currentColor" opacity="0.5" d="M2 0a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5.5V0zm.5 7.5h3a.5.5 0 0 1 0 1h-3a.5.5 0 0 1 0-1"></path>
  </svg>`;
}

function unifiedIcon(): string {
  return `<svg viewBox="0 0 16 16" aria-hidden="true">
    <path fill="currentColor" fill-rule="evenodd" d="M16 14a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V8.5h16zm-8-4a.5.5 0 0 0-.5.5v1h-1a.5.5 0 0 0 0 1h1v1a.5.5 0 0 0 1 0v-1h1a.5.5 0 0 0 0-1h-1v-1A.5.5 0 0 0 8 10" clip-rule="evenodd"></path>
    <path fill="currentColor" fill-rule="evenodd" opacity="0.5" d="M14 0a2 2 0 0 1 2 2v5.5H0V2a2 2 0 0 1 2-2zM6.5 3.5a.5.5 0 0 0 0 1h3a.5.5 0 0 0 0-1z" clip-rule="evenodd"></path>
  </svg>`;
}

function wrapIcon(active: boolean): string {
  return `<svg viewBox="0 0 16 16" aria-hidden="true">
    <path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" opacity="${active ? "1" : "0.85"}" d="M3.868 3.449a1.21 1.21 0 0 0-.473-.329c-.274-.111-.623-.15-1.055-.076a3.5 3.5 0 0 0-.71.208c-.082.035-.16.077-.235.125l-.043.03v1.056l.168-.139c.15-.124.326-.225.527-.303.196-.074.4-.113.604-.113.188 0 .33.051.431.157.087.095.137.248.147.456l-.962.144c-.219.03-.41.086-.57.166a1.245 1.245 0 0 0-.398.311c-.103.125-.181.27-.229.426-.097.33-.093.68.011 1.008a1.096 1.096 0 0 0 .638.67c.155.063.328.093.528.093a1.25 1.25 0 0 0 .978-.441v.345h1.007V4.65c0-.255-.03-.484-.089-.681a1.423 1.423 0 0 0-.275-.52zm-.636 1.896v.236c0 .119-.018.231-.055.341a.745.745 0 0 1-.377.447.694.694 0 0 1-.512.027.454.454 0 0 1-.156-.094.389.389 0 0 1-.094-.139.474.474 0 0 1-.035-.186c0-.077.01-.147.024-.212a.33.33 0 0 1 .078-.141.436.436 0 0 1 .161-.109 1.3 1.3 0 0 1 .305-.073l.661-.097zm5.051-1.067a2.253 2.253 0 0 0-.244-.656 1.354 1.354 0 0 0-.436-.459 1.165 1.165 0 0 0-.642-.173 1.136 1.136 0 0 0-.69.223 1.33 1.33 0 0 0-.264.266V1H5.09v6.224h.918v-.281c.123.152.287.266.472.328.098.032.208.047.33.047.255 0 .483-.06.677-.177.192-.115.355-.278.486-.486a2.29 2.29 0 0 0 .293-.718 3.87 3.87 0 0 0 .096-.886 3.714 3.714 0 0 0-.078-.773zm-.86.758c0 .232-.02.439-.06.613-.036.172-.09.315-.159.424a.639.639 0 0 1-.233.237.582.582 0 0 1-.565.014.683.683 0 0 1-.21-.183.925.925 0 0 1-.142-.283A1.187 1.187 0 0 1 6 5.5v-.517c0-.164.02-.314.06-.447.036-.132.087-.242.156-.336a.668.668 0 0 1 .228-.208.584.584 0 0 1 .29-.071.554.554 0 0 1 .496.279c.063.099.108.214.143.354.031.143.05.306.05.482zM2.407 9.9a.913.913 0 0 1 .316-.239c.218-.1.547-.105.766-.018.104.042.204.1.32.184l.33.26V8.945l-.097-.062a1.932 1.932 0 0 0-.905-.215c-.308 0-.593.057-.846.168-.25.11-.467.27-.647.475-.18.21-.318.453-.403.717-.09.272-.137.57-.137.895 0 .289.043.561.13.808.086.249.211.471.373.652.161.185.361.333.597.441.232.104.493.155.778.155.233 0 .434-.028.613-.084.165-.05.322-.123.466-.217l.078-.061v-.889l-.2.095a.4.4 0 0 1-.076.026c-.05.017-.099.035-.128.049-.036.023-.227.09-.227.09-.06.024-.14.043-.218.059a.977.977 0 0 1-.599-.057.827.827 0 0 1-.306-.225 1.088 1.088 0 0 1-.205-.376 1.728 1.728 0 0 1-.076-.529c0-.21.028-.399.083-.56.054-.158.13-.294.22-.4zM14 6h-4V5h4.5l.5.5v6l-.5.5H7.879l2.07 2.071-.706.707-2.89-2.889v-.707l2.89-2.89L9.95 9l-2 2H14V6z"></path>
  </svg>`;
}

function backgroundIcon(active: boolean): string {
  if (active) {
    return `<svg viewBox="0 0 16 16" aria-hidden="true">
      <path fill="currentColor" opacity="0.5" d="M0 2.25a.75.75 0 0 1 .75-.75h10.5a.75.75 0 0 1 0 1.5H.75A.75.75 0 0 1 0 2.25"></path>
      <path fill="currentColor" fill-rule="evenodd" d="M15 5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H1a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM2.5 9a.5.5 0 0 0 0 1h8a.5.5 0 0 0 0-1zm0-2a.5.5 0 0 0 0 1h11a.5.5 0 0 0 0-1z" clip-rule="evenodd"></path>
      <path fill="currentColor" opacity="0.5" d="M0 14.75A.75.75 0 0 1 .75 14h5.5a.75.75 0 0 1 0 1.5H.75a.75.75 0 0 1-.75-.75"></path>
    </svg>`;
  }
  return `<svg viewBox="0 0 16 16" aria-hidden="true">
    <path fill="currentColor" opacity="0.34" d="M0 2.25a.75.75 0 0 1 .75-.75h10.5a.75.75 0 0 1 0 1.5H.75A.75.75 0 0 1 0 2.25"></path>
    <path fill="currentColor" opacity="0.34" fill-rule="evenodd" d="M15 5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H1a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM2.5 9a.5.5 0 0 0 0 1h8a.5.5 0 0 0 0-1zm0-2a.5.5 0 0 0 0 1h11a.5.5 0 0 0 0-1z" clip-rule="evenodd"></path>
    <path fill="currentColor" opacity="0.34" d="M0 14.75A.75.75 0 0 1 .75 14h5.5a.75.75 0 0 1 0 1.5H.75a.75.75 0 0 1-.75-.75"></path>
    <path d="M2.5 13.5 13.5 2.5" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"></path>
  </svg>`;
}

function themeIcon(theme: DiffTheme): string {
  if (theme === "dark") {
    return `<svg viewBox="0 0 16 16" aria-hidden="true">
      <path fill="currentColor" d="M10.794 3.647a.217.217 0 0 1 .412 0l.387 1.162c.173.518.58.923 1.097 1.096l1.162.388a.217.217 0 0 1 0 .412l-1.162.386a1.73 1.73 0 0 0-1.097 1.097l-.387 1.162a.217.217 0 0 1-.412 0l-.387-1.162A1.74 1.74 0 0 0 9.31 7.092l-1.162-.386a.217.217 0 0 1 0-.412l1.162-.388a1.73 1.73 0 0 0 1.097-1.096zM13.863.598a.144.144 0 0 1 .221-.071.14.14 0 0 1 .053.07l.258.775c.115.345.386.616.732.731l.774.258a.145.145 0 0 1 0 .274l-.774.259a1.16 1.16 0 0 0-.732.732l-.258.773a.145.145 0 0 1-.274 0l-.258-.773a1.16 1.16 0 0 0-.732-.732l-.774-.259a.145.145 0 0 1 0-.273l.774-.259c.346-.115.617-.386.732-.732z"></path>
      <path fill="currentColor" d="M6.25 1.742a.67.67 0 0 1 .07.75 6.3 6.3 0 0 0-.768 3.028c0 2.746 1.746 5.084 4.193 5.979H1.774A7.2 7.2 0 0 1 1 8.245c0-3.013 1.85-5.598 4.484-6.694a.66.66 0 0 1 .766.19M.75 12.499a.75.75 0 0 0 0 1.5h14.5a.75.75 0 0 0 0-1.5z"></path>
    </svg>`;
  }
  return `<svg viewBox="0 0 16 16" aria-hidden="true">
    <path fill="currentColor" d="M8.21 2.109a.256.256 0 0 0-.42 0L6.534 3.893a.256.256 0 0 1-.316.085l-1.982-.917a.256.256 0 0 0-.362.21l-.196 2.174a.256.256 0 0 1-.232.232l-2.175.196a.256.256 0 0 0-.209.362l.917 1.982a.256.256 0 0 1-.085.316L.11 9.791a.256.256 0 0 0 0 .418L1.23 11H3.1a5 5 0 1 1 9.8 0h1.869l1.123-.79a.256.256 0 0 0 0-.42l-1.785-1.257a.256.256 0 0 1-.085-.316l.917-1.982a.256.256 0 0 0-.21-.362l-2.174-.196a.256.256 0 0 1-.232-.232l-.196-2.175a.256.256 0 0 0-.362-.209l-1.982.917a.256.256 0 0 1-.316-.085z"></path>
    <path fill="currentColor" d="M4 10q.001.519.126 1h7.748A4 4 0 1 0 4 10M.75 12a.75.75 0 0 0 0 1.5h14.5a.75.75 0 0 0 0-1.5z"></path>
  </svg>`;
}

function createToolbar(): HTMLElement {
  const toolbar = document.createElement("div");
  toolbar.className = "oc-diff-toolbar";
  applyToolbarStyles(toolbar);

  toolbar.append(
    createToolbarButton({
      title: viewerState.layout === "unified" ? "Switch to split diff" : "Switch to unified diff",
      active: viewerState.layout === "split",
      iconMarkup: viewerState.layout === "split" ? splitIcon() : unifiedIcon(),
      onClick: () => {
        viewerState.layout = viewerState.layout === "unified" ? "split" : "unified";
        syncAllControllers();
      },
    }),
  );

  toolbar.append(
    createToolbarButton({
      title: viewerState.wrapEnabled ? "Disable word wrap" : "Enable word wrap",
      active: viewerState.wrapEnabled,
      iconMarkup: wrapIcon(viewerState.wrapEnabled),
      onClick: () => {
        viewerState.wrapEnabled = !viewerState.wrapEnabled;
        syncAllControllers();
      },
    }),
  );

  toolbar.append(
    createToolbarButton({
      title: viewerState.backgroundEnabled
        ? "Hide background highlights"
        : "Show background highlights",
      active: viewerState.backgroundEnabled,
      iconMarkup: backgroundIcon(viewerState.backgroundEnabled),
      onClick: () => {
        viewerState.backgroundEnabled = !viewerState.backgroundEnabled;
        syncAllControllers();
      },
    }),
  );

  toolbar.append(
    createToolbarButton({
      title: viewerState.theme === "dark" ? "Switch to light theme" : "Switch to dark theme",
      active: viewerState.theme === "dark",
      iconMarkup: themeIcon(viewerState.theme),
      onClick: () => {
        viewerState.theme = viewerState.theme === "dark" ? "light" : "dark";
        syncAllControllers();
      },
    }),
  );

  return toolbar;
}

function createRenderOptions(payload: DiffViewerPayload): FileDiffOptions<undefined> {
  return {
    theme: payload.options.theme,
    themeType: viewerState.theme,
    diffStyle: viewerState.layout,
    diffIndicators: payload.options.diffIndicators,
    expandUnchanged: payload.options.expandUnchanged,
    overflow: viewerState.wrapEnabled ? "wrap" : "scroll",
    disableLineNumbers: payload.options.disableLineNumbers,
    disableBackground: !viewerState.backgroundEnabled,
    unsafeCSS: payload.options.unsafeCSS,
    renderHeaderMetadata: () => createToolbar(),
  };
}

function syncDocumentTheme(): void {
  document.body.dataset.theme = viewerState.theme;
}

function applyState(controller: DiffController): void {
  controller.diff.setOptions(createRenderOptions(controller.payload));
  controller.diff.rerender();
}

function syncAllControllers(): void {
  syncDocumentTheme();
  for (const controller of controllers) {
    applyState(controller);
  }
}

async function hydrateViewer(): Promise<void> {
  const cards = await Promise.all(
    getCards().map(async ({ host, payload }) => ({
      host,
      payload: await normalizeDiffViewerPayloadLanguages(payload),
    })),
  );
  const langs = new Set<SupportedLanguages>();
  const firstPayload = cards[0]?.payload;

  if (firstPayload) {
    viewerState.theme = firstPayload.options.themeType;
    viewerState.layout = firstPayload.options.diffStyle;
    viewerState.backgroundEnabled = firstPayload.options.backgroundEnabled;
    viewerState.wrapEnabled = firstPayload.options.overflow === "wrap";
  }

  for (const { payload } of cards) {
    for (const lang of payload.langs) {
      langs.add(lang);
    }
  }

  await preloadHighlighter({
    themes: ["pierre-light", "pierre-dark"],
    langs: [...langs],
  });

  syncDocumentTheme();

  for (const { host, payload } of cards) {
    ensureShadowRoot(host);
    const diff = new FileDiff(createRenderOptions(payload));
    diff.hydrate({
      fileContainer: host,
      prerenderedHTML: payload.prerenderedHTML,
      ...getHydrateProps(payload),
    });
    const controller = { payload, diff };
    controllers.push(controller);
    applyState(controller);
  }
}

async function main(): Promise<void> {
  try {
    await hydrateViewer();
    document.documentElement.dataset.openclawDiffsReady = "true";
  } catch (error) {
    document.documentElement.dataset.openclawDiffsError = "true";
    console.error("Failed to hydrate diff viewer", error);
  }
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      void main();
    });
  } else {
    void main();
  }
}
