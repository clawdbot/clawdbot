/* @vitest-environment jsdom */

import { readFileSync } from "node:fs";
import path from "node:path";
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
  oldFile: { fileName: "a.ts", lang: "text", content: "old" },
  newFile: { fileName: "a.ts", lang: "text", content: "new" },
});

function renderCard(): void {
  document.body.insertAdjacentHTML(
    "beforeend",
    `<section class="oc-diff-card">
      <div data-openclaw-diff-host></div>
      <script type="application/json" data-openclaw-diff-payload>${viewerPayload}</script>
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
      expect(
        VIEWER_CLIENT_SRC.includes(pattern),
        `source must not contain "${pattern}"`,
      ).toBe(false);
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
    const { controllers, hydrateViewer } = await import("./viewer-client.js");
    controllers.splice(0);

    await hydrateViewer();

    expect(fileDiffHydrateMock).toHaveBeenCalledTimes(2);
    expect(controllers).toHaveLength(1);
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
    const { controllers, hydrateViewer } = await import("./viewer-client.js");
    controllers.splice(0);

    await hydrateViewer();

    expect(fileDiffHydrateMock).toHaveBeenCalledTimes(2);
    expect(fileDiffSetOptionsMock).toHaveBeenCalledTimes(2);
    expect(controllers).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      "Skipping diff card that failed to hydrate",
      expect.any(Error),
    );
    expect(document.documentElement.dataset.openclawDiffsError).toBeUndefined();
    warn.mockRestore();
  });
});
