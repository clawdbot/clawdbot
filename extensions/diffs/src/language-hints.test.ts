import type { FileDiffMetadata } from "@pierre/diffs";
import { describe, expect, it } from "vitest";
import {
  filterSupportedLanguageHints,
  normalizeDiffViewerPayloadLanguages,
} from "./language-hints.js";

describe("filterSupportedLanguageHints", () => {
  it("keeps supported languages", async () => {
    await expect(filterSupportedLanguageHints(["typescript", "text"])).resolves.toEqual([
      "typescript",
      "text",
    ]);
  });

  it("drops invalid languages and falls back to text", async () => {
    await expect(filterSupportedLanguageHints(["not-a-real-language"])).resolves.toEqual(["text"]);
  });

  it("keeps valid languages when invalid hints are mixed in", async () => {
    await expect(
      filterSupportedLanguageHints(["typescript", "not-a-real-language"]),
    ).resolves.toEqual(["typescript"]);
  });
});

describe("normalizeDiffViewerPayloadLanguages", () => {
  it("rewrites stale patch payload language overrides to plain text", async () => {
    const result = await normalizeDiffViewerPayloadLanguages({
      prerenderedHTML: "<div>diff</div>",
      options: {
        theme: {
          light: "pierre-light",
          dark: "pierre-dark",
        },
        diffStyle: "unified",
        diffIndicators: "bars",
        disableLineNumbers: false,
        expandUnchanged: false,
        themeType: "dark",
        backgroundEnabled: true,
        overflow: "wrap",
        unsafeCSS: "",
      },
      langs: ["not-a-real-language" as never],
      fileDiff: {
        name: "foo.txt",
        lang: "not-a-real-language" as never,
      } as unknown as FileDiffMetadata,
    });

    expect(result.langs).toEqual(["text"]);
    expect(result.fileDiff?.lang).toBe("text");
  });

  it("keeps valid hydrated languages and only downgrades invalid sides", async () => {
    const result = await normalizeDiffViewerPayloadLanguages({
      prerenderedHTML: "<div>diff</div>",
      options: {
        theme: {
          light: "pierre-light",
          dark: "pierre-dark",
        },
        diffStyle: "split",
        diffIndicators: "classic",
        disableLineNumbers: true,
        expandUnchanged: true,
        themeType: "light",
        backgroundEnabled: false,
        overflow: "scroll",
        unsafeCSS: "",
      },
      langs: ["typescript", "not-a-real-language" as never],
      oldFile: {
        name: "before.unknown",
        contents: "before",
        lang: "not-a-real-language" as never,
      },
      newFile: {
        name: "after.ts",
        contents: "after",
        lang: "typescript",
      },
    });

    expect(result.langs).toEqual(["typescript", "text"]);
    expect(result.oldFile?.lang).toBe("text");
    expect(result.newFile?.lang).toBe("typescript");
  });

  it("rewrites blank explicit language overrides to plain text", async () => {
    const result = await normalizeDiffViewerPayloadLanguages({
      prerenderedHTML: "<div>diff</div>",
      options: {
        theme: {
          light: "pierre-light",
          dark: "pierre-dark",
        },
        diffStyle: "unified",
        diffIndicators: "bars",
        disableLineNumbers: false,
        expandUnchanged: false,
        themeType: "dark",
        backgroundEnabled: true,
        overflow: "wrap",
        unsafeCSS: "",
      },
      langs: ["   " as never],
      oldFile: {
        name: "before.unknown",
        contents: "before",
        lang: "   " as never,
      },
      newFile: {
        name: "after.txt",
        contents: "after",
      },
    });

    expect(result.langs).toEqual(["text"]);
    expect(result.oldFile?.lang).toBe("text");
  });

  it("does not inject text when a valid file language is the only supported hint", async () => {
    const result = await normalizeDiffViewerPayloadLanguages({
      prerenderedHTML: "<div>diff</div>",
      options: {
        theme: {
          light: "pierre-light",
          dark: "pierre-dark",
        },
        diffStyle: "unified",
        diffIndicators: "bars",
        disableLineNumbers: false,
        expandUnchanged: false,
        themeType: "dark",
        backgroundEnabled: true,
        overflow: "wrap",
        unsafeCSS: "",
      },
      langs: [],
      oldFile: {
        name: "before.ts",
        contents: "before",
        lang: "typescript",
      },
      newFile: {
        name: "after.ts",
        contents: "after",
        lang: "typescript",
      },
    });

    expect(result.langs).toEqual(["typescript"]);
  });
});
