/* @vitest-environment jsdom */

import { readFileSync } from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const disableAutoStartKey = Symbol.for("openclaw.diffs.disableAutoStart");
(globalThis as typeof globalThis & Record<symbol, unknown>)[disableAutoStartKey] = true;

const VIEWER_CLIENT_SRC = readFileSync(
  path.join(process.cwd(), "extensions/diffs/src/viewer-client.ts"),
  "utf8",
);

const XSS_PATTERNS = ["onerror", "<script", "onclick", "javascript:", "onload"];

const {
  fileDiffHydrateMock,
  fileDiffRerenderMock,
  fileDiffSetOptionsMock,
  preloadHighlighterMock,
} = vi.hoisted(() => ({
  fileDiffHydrateMock: vi.fn(),
  fileDiffRerenderMock: vi.fn(),
  fileDiffSetOptionsMock: vi.fn(),
  preloadHighlighterMock: vi.fn(async () => undefined),
}));

vi.mock("@pierre/diffs", () => ({
  FileDiff: class {
    hydrate(params: unknown) {
      return fileDiffHydrateMock(params);
    }
    rerender() {
      return fileDiffRerenderMock();
    }
    setOptions(params: unknown) {
      return fileDiffSetOptionsMock(params);
    }
  },
  preloadHighlighter: preloadHighlighterMock,
}));

const viewerPayload = JSON.stringify({
  prerenderedHTML: "<div>diff</div>",
  options: {
    theme: { light: "pierre-light", dark: "pierre-dark" },
    diffStyle: "unified",
    diffIndicators: "bars",
    disableLineNumbers: false,
    expandUnchanged: false,
    themeType: "dark",
    backgroundEnabled: true,
    overflow: "wrap",
    unsafeCSS: "",
  },
  langs: ["text"],
  oldFile: { name: "a.ts", lang: "text", contents: "old" },
  newFile: { name: "a.ts", lang: "text", contents: "new" },
});

function renderCard(payloadOverride?: string): void {
  const payload = payloadOverride ?? viewerPayload;
  document.body.insertAdjacentHTML(
    "beforeend",
    `<section class="oc-diff-card">
      <div data-openclaw-diff-host></div>
      <script type="application/json" data-openclaw-diff-payload>${payload}</script>
    </section>`,
  );
}

describe("createToolbarButton icon safety", () => {
  it("toolbarIconSvg map exists and has exactly 8 icon names", () => {
    const requiredNames = [
      "split",
      "unified",
      "wrap-on",
      "wrap-off",
      "background-on",
      "background-off",
      "theme-dark",
      "theme-light",
    ] as const;
    for (const name of requiredNames) {
      expect(
        VIEWER_CLIENT_SRC.includes(name + ":") || VIEWER_CLIENT_SRC.includes(`"${name}"`),
        `icon "${name}" should exist in toolbarIconSvg`,
      ).toBe(true);
    }
  });

  it("no iconMarkup: string parameter exists", () => {
    expect(VIEWER_CLIENT_SRC.includes("iconMarkup: string")).toBe(false);
  });

  it("innerHTML reads only from toolbarIconSvg lookup", () => {
    expect(VIEWER_CLIENT_SRC.includes("button.innerHTML = toolbarIconSvg[params.icon]")).toBe(true);
  });

  it("SVG strings in toolbarIconSvg contain no XSS patterns", () => {
    for (const pattern of XSS_PATTERNS) {
      expect(VIEWER_CLIENT_SRC.includes(pattern), `source must not contain "${pattern}"`).toBe(
        false,
      );
    }
  });

  it("old icon functions are removed", () => {
    const removedFunctions = [
      "function splitIcon(",
      "function unifiedIcon(",
      "function wrapIcon(",
      "function backgroundIcon(",
      "function themeIcon(",
    ];
    for (const fn of removedFunctions) {
      expect(VIEWER_CLIENT_SRC.includes(fn), `"${fn}" should be removed`).toBe(false);
    }
  });
});

describe("hydrateViewer", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    delete document.documentElement.dataset.openclawDiffsError;
    delete document.documentElement.dataset.openclawDiffsReady;
    vi.clearAllMocks();
  });

  it("continues hydrating later cards when one card throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    renderCard();
    renderCard();
    fileDiffHydrateMock.mockImplementationOnce(() => {
      throw new Error("broken card");
    });
    const { hydrateViewer } = await import("./viewer-client.js");

    await hydrateViewer();

    expect(fileDiffHydrateMock).toHaveBeenCalledTimes(2);
    expect(fileDiffRerenderMock).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "Skipping diff card that failed to hydrate",
      expect.any(Error),
    );
    expect(document.documentElement.dataset.openclawDiffsError).toBeUndefined();
    warn.mockRestore();
  });

  it("does not retain controllers when initial state application throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    renderCard();
    renderCard();
    fileDiffSetOptionsMock.mockImplementationOnce(() => {
      throw new Error("broken options");
    });
    const { hydrateViewer } = await import("./viewer-client.js");

    await hydrateViewer();

    expect(fileDiffHydrateMock).toHaveBeenCalledTimes(2);
    expect(fileDiffSetOptionsMock).toHaveBeenCalledTimes(2);
    expect(fileDiffRerenderMock).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "Skipping diff card that failed to hydrate",
      expect.any(Error),
    );
    expect(document.documentElement.dataset.openclawDiffsError).toBeUndefined();
    warn.mockRestore();
  });

  it("replaces stale controllers when hydrating the current cards again", async () => {
    renderCard();
    const { hydrateViewer } = await import("./viewer-client.js");

    await hydrateViewer();

    document.body.innerHTML = "";
    renderCard();
    await hydrateViewer();

    expect(fileDiffHydrateMock).toHaveBeenCalledTimes(2);
    const currentOptions = fileDiffSetOptionsMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    const renderHeaderMetadata = currentOptions.renderHeaderMetadata as () => HTMLElement;
    fileDiffRerenderMock.mockClear();

    renderHeaderMetadata().querySelector<HTMLButtonElement>("button")?.click();

    expect(fileDiffRerenderMock).toHaveBeenCalledTimes(1);
  });
});

describe("viewerState initialization", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    delete document.documentElement.dataset.openclawDiffsError;
    delete document.documentElement.dataset.openclawDiffsReady;
    delete document.body.dataset.theme;
    vi.clearAllMocks();
  });

  it("seeds viewerState from firstPayload options and syncs document theme", async () => {
    const customPayload = JSON.stringify({
      prerenderedHTML: "<div>diff</div>",
      options: {
        theme: { light: "pierre-light", dark: "pierre-dark" },
        diffStyle: "split",
        diffIndicators: "bars",
        disableLineNumbers: false,
        expandUnchanged: false,
        themeType: "light",
        backgroundEnabled: false,
        overflow: "scroll",
        unsafeCSS: "",
      },
      langs: ["text"],
      oldFile: { name: "a.ts", lang: "text", contents: "old" },
      newFile: { name: "a.ts", lang: "text", contents: "new" },
    });
    renderCard(customPayload);
    const { hydrateViewer } = await import("./viewer-client.js");

    await hydrateViewer();

    expect(document.body.dataset.theme).toBe("light");

    const opts = fileDiffSetOptionsMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(opts.diffStyle).toBe("split");
    expect(opts.themeType).toBe("light");
    expect(opts.overflow).toBe("scroll");
    expect(opts.disableBackground).toBe(true);
  });

  it("defaults viewerState to dark/unified/wrap/background when firstPayload uses defaults", async () => {
    renderCard();
    const { hydrateViewer } = await import("./viewer-client.js");

    await hydrateViewer();

    expect(document.body.dataset.theme).toBe("dark");

    const opts = fileDiffSetOptionsMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(opts.diffStyle).toBe("unified");
    expect(opts.themeType).toBe("dark");
    expect(opts.overflow).toBe("wrap");
    expect(opts.disableBackground).toBe(false);
  });

  it("preloadHighlighter receives merged language set from all cards", async () => {
    const payload1 = JSON.stringify({
      prerenderedHTML: "<div>diff1</div>",
      options: {
        theme: { light: "pierre-light", dark: "pierre-dark" },
        diffStyle: "unified",
        diffIndicators: "bars",
        disableLineNumbers: false,
        expandUnchanged: false,
        themeType: "dark",
        backgroundEnabled: true,
        overflow: "wrap",
        unsafeCSS: "",
      },
      langs: ["typescript"],
      oldFile: { name: "a.ts", lang: "typescript", contents: "old" },
      newFile: { name: "a.ts", lang: "typescript", contents: "new" },
    });
    const payload2 = JSON.stringify({
      prerenderedHTML: "<div>diff2</div>",
      options: {
        theme: { light: "pierre-light", dark: "pierre-dark" },
        diffStyle: "unified",
        diffIndicators: "bars",
        disableLineNumbers: false,
        expandUnchanged: false,
        themeType: "dark",
        backgroundEnabled: true,
        overflow: "wrap",
        unsafeCSS: "",
      },
      langs: ["python"],
      oldFile: { name: "b.py", lang: "python", contents: "old" },
      newFile: { name: "b.py", lang: "python", contents: "new" },
    });
    renderCard(payload1);
    renderCard(payload2);
    const { hydrateViewer } = await import("./viewer-client.js");

    await hydrateViewer();

    const preloadArg = (preloadHighlighterMock.mock.calls as unknown[][])[0]?.[0] as
      | { langs: string[]; themes: string[] }
      | undefined;
    expect(preloadArg).toBeDefined();
    expect(preloadArg!.langs).toContain("typescript");
    expect(preloadArg!.langs).toContain("python");
    expect(preloadArg!.themes).toEqual(["pierre-light", "pierre-dark"]);
  });
});

describe("toolbar button toggles", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    delete document.body.dataset.theme;
    vi.clearAllMocks();
  });

  it("layout toggle switches between unified and split", async () => {
    renderCard();
    const { hydrateViewer } = await import("./viewer-client.js");
    await hydrateViewer();

    const opts1 = fileDiffSetOptionsMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(opts1.diffStyle).toBe("unified");

    const renderHeaderMetadata = opts1.renderHeaderMetadata as () => HTMLElement;
    const toolbar = renderHeaderMetadata();
    const buttons = toolbar.querySelectorAll("button");

    expectDefined(buttons[0], "diff-style toggle").click();

    expect(fileDiffRerenderMock).toHaveBeenCalled();

    const opts2 = fileDiffSetOptionsMock.mock.calls[
      fileDiffSetOptionsMock.mock.calls.length - 1
    ]?.[0] as Record<string, unknown>;
    expect(opts2.diffStyle).toBe("split");
  });

  it("theme toggle switches between dark and light", async () => {
    renderCard();
    const { hydrateViewer } = await import("./viewer-client.js");
    await hydrateViewer();

    const opts1 = fileDiffSetOptionsMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(opts1.themeType).toBe("dark");

    const renderHeaderMetadata = opts1.renderHeaderMetadata as () => HTMLElement;
    const toolbar = renderHeaderMetadata();
    const buttons = toolbar.querySelectorAll("button");

    expectDefined(buttons[3], "theme toggle").click();

    const lastOpts = fileDiffSetOptionsMock.mock.calls[
      fileDiffSetOptionsMock.mock.calls.length - 1
    ]?.[0] as Record<string, unknown>;
    expect(lastOpts.themeType).toBe("light");
    expect(document.body.dataset.theme).toBe("light");
  });

  it("wrap toggle switches between wrap and scroll", async () => {
    renderCard();
    const { hydrateViewer } = await import("./viewer-client.js");
    await hydrateViewer();

    const opts1 = fileDiffSetOptionsMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(opts1.overflow).toBe("wrap");

    const renderHeaderMetadata = opts1.renderHeaderMetadata as () => HTMLElement;
    const toolbar = renderHeaderMetadata();
    const buttons = toolbar.querySelectorAll("button");

    expectDefined(buttons[1], "wrap toggle").click();

    const lastOpts = fileDiffSetOptionsMock.mock.calls[
      fileDiffSetOptionsMock.mock.calls.length - 1
    ]?.[0] as Record<string, unknown>;
    expect(lastOpts.overflow).toBe("scroll");
  });

  it("background toggle inverts disableBackground", async () => {
    renderCard();
    const { hydrateViewer } = await import("./viewer-client.js");
    await hydrateViewer();

    const opts1 = fileDiffSetOptionsMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(opts1.disableBackground).toBe(false);

    const renderHeaderMetadata = opts1.renderHeaderMetadata as () => HTMLElement;
    const toolbar = renderHeaderMetadata();
    const buttons = toolbar.querySelectorAll("button");

    expectDefined(buttons[2], "background toggle").click();

    const lastOpts = fileDiffSetOptionsMock.mock.calls[
      fileDiffSetOptionsMock.mock.calls.length - 1
    ]?.[0] as Record<string, unknown>;
    expect(lastOpts.disableBackground).toBe(true);
  });
});

describe("header metadata", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    delete document.body.dataset.theme;
    vi.clearAllMocks();
  });

  type HeaderMetadataCallback = () => HTMLElement | null;

  async function hydrateAndGetHeaderCallback(): Promise<HeaderMetadataCallback> {
    const { hydrateViewer } = await import("./viewer-client.js");
    await hydrateViewer();
    const opts = fileDiffSetOptionsMock.mock.calls[0]?.[0] as Record<string, unknown>;
    return opts.renderHeaderMetadata as HeaderMetadataCallback;
  }

  it("renders the toolbar in viewer render mode", async () => {
    document.body.insertAdjacentHTML(
      "beforeend",
      '<main class="oc-frame" data-render-mode="viewer"></main>',
    );
    renderCard();
    const renderHeaderMetadata = await hydrateAndGetHeaderCallback();

    const header = renderHeaderMetadata();

    expect(header).not.toBeNull();
    expect(header?.querySelectorAll("button")).toHaveLength(4);
  });

  it("drops the interactive toolbar in image render mode", async () => {
    document.body.insertAdjacentHTML(
      "beforeend",
      '<main class="oc-frame" data-render-mode="image"></main>',
    );
    renderCard();
    const renderHeaderMetadata = await hydrateAndGetHeaderCallback();

    expect(renderHeaderMetadata()).toBeNull();
  });

  it("skips summary nav cards during hydration", async () => {
    document.body.insertAdjacentHTML(
      "beforeend",
      '<nav class="oc-diff-card oc-diff-nav" aria-label="Changed files"><ol></ol></nav>',
    );
    renderCard();
    const { hydrateViewer } = await import("./viewer-client.js");

    await hydrateViewer();

    expect(fileDiffHydrateMock).toHaveBeenCalledTimes(1);
  });
});

describe("ensureShadowRoot", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("attaches shadow root from template and removes template element", async () => {
    renderCard();
    const host = document.querySelector<HTMLElement>("[data-openclaw-diff-host]")!;
    const template = document.createElement("template");
    template.setAttribute("shadowrootmode", "open");
    template.innerHTML = "<div>shadow content</div>";
    host.append(template);

    const { hydrateViewer } = await import("./viewer-client.js");
    await hydrateViewer();

    expect(host.shadowRoot).toBeDefined();
    expect(host.shadowRoot!.querySelector("div")?.textContent).toBe("shadow content");
    expect(host.querySelector("template")).toBeNull();
  });

  it("skips shadow root attachment when no template is present", async () => {
    renderCard();
    const host = document.querySelector<HTMLElement>("[data-openclaw-diff-host]")!;

    const { hydrateViewer } = await import("./viewer-client.js");
    await hydrateViewer();

    expect(host.shadowRoot).toBeNull();
    expect(fileDiffHydrateMock).toHaveBeenCalled();
  });

  it("skips shadow root when already attached", async () => {
    renderCard();
    const host = document.querySelector<HTMLElement>("[data-openclaw-diff-host]")!;
    host.attachShadow({ mode: "open" });
    host.shadowRoot!.innerHTML = "<span>existing</span>";

    const template = document.createElement("template");
    template.setAttribute("shadowrootmode", "open");
    template.innerHTML = "<div>new content</div>";
    host.append(template);

    const { hydrateViewer } = await import("./viewer-client.js");
    await hydrateViewer();

    expect(host.shadowRoot!.querySelector("span")?.textContent).toBe("existing");
    expect(host.querySelector("template")).not.toBeNull();
  });
});

describe("getHydrateProps branching", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("passes fileDiff directly when payload has fileDiff", async () => {
    const fileDiffPayload = JSON.stringify({
      prerenderedHTML: "<div>diff</div>",
      options: {
        theme: { light: "pierre-light", dark: "pierre-dark" },
        diffStyle: "unified",
        diffIndicators: "bars",
        disableLineNumbers: false,
        expandUnchanged: false,
        themeType: "dark",
        backgroundEnabled: true,
        overflow: "wrap",
        unsafeCSS: "",
      },
      langs: ["text"],
      fileDiff: { name: "patch.diff", lang: "text", hunks: [] },
    });
    renderCard(fileDiffPayload);
    const { hydrateViewer } = await import("./viewer-client.js");

    await hydrateViewer();

    const hydrateArg = fileDiffHydrateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(hydrateArg.fileDiff).toEqual({ name: "patch.diff", lang: "text", hunks: [] });
    expect(hydrateArg.oldFile).toBeUndefined();
    expect(hydrateArg.newFile).toBeUndefined();
  });

  it("passes oldFile and newFile when payload has them without fileDiff", async () => {
    renderCard();
    const { hydrateViewer } = await import("./viewer-client.js");

    await hydrateViewer();

    const hydrateArg = fileDiffHydrateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(hydrateArg.fileDiff).toBeUndefined();
    expect(hydrateArg.oldFile).toEqual({ name: "a.ts", lang: "text", contents: "old" });
    expect(hydrateArg.newFile).toEqual({ name: "a.ts", lang: "text", contents: "new" });
  });
});
