// Diffs tests cover language hints plugin behavior.
import type { FileDiffMetadata } from "@pierre/diffs";
import { describe, expect, it } from "vitest";
import {
  normalizeDiffViewerPayloadLanguages,
  normalizeSupportedLanguageHint,
} from "./language-hints.js";

async function normalizeHints(values: readonly string[], options = {}) {
  return await Promise.all(values.map((value) => normalizeSupportedLanguageHint(value, options)));
}

describe("normalizeSupportedLanguageHint", () => {
  it("keeps supported languages", async () => {
    await expect(normalizeHints(["typescript", "cpp", "text"])).resolves.toEqual([
      "typescript",
      "cpp",
      "text",
    ]);
  });

  it("normalizes language hint casing", async () => {
    await expect(normalizeHints(["Python", "TypeScript"])).resolves.toEqual([
      "python",
      "typescript",
    ]);
    await expect(
      normalizeSupportedLanguageHint("AbAp", { languagePackAvailable: true }),
    ).resolves.toBe("abap");
  });

  it("normalizes common aliases to base viewer languages", async () => {
    await expect(
      normalizeHints(["ts", "c++", "c#", "bash", "dockerfile", "rb", "kt", "ps1"]),
    ).resolves.toEqual([
      "typescript",
      "cpp",
      "csharp",
      "sh",
      "docker",
      "ruby",
      "kotlin",
      "powershell",
    ]);
  });

  it("keeps mainstream languages in the base viewer without the language pack", async () => {
    await expect(
      normalizeHints(["ruby", "swift", "kotlin", "r", "dart", "lua", "powershell", "xml", "toml"]),
    ).resolves.toEqual([
      "ruby",
      "swift",
      "kotlin",
      "r",
      "dart",
      "lua",
      "powershell",
      "xml",
      "toml",
    ]);
  });

  it("drops uncommon languages without the language pack", async () => {
    await expect(normalizeSupportedLanguageHint("abap")).resolves.toBeUndefined();
  });

  it("keeps uncommon languages when the language pack is available", async () => {
    await expect(
      normalizeSupportedLanguageHint("abap", { languagePackAvailable: true }),
    ).resolves.toBe("abap");
  });

  it("drops invalid languages", async () => {
    await expect(normalizeSupportedLanguageHint("not-a-real-language")).resolves.toBeUndefined();
  });

  it("keeps valid languages when invalid hints are mixed in", async () => {
    await expect(normalizeHints(["typescript", "not-a-real-language"])).resolves.toEqual([
      "typescript",
      undefined,
    ]);
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

  it("keeps uncommon hydrated languages when the language pack is available", async () => {
    const result = await normalizeDiffViewerPayloadLanguages(
      {
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
        langs: ["abap" as never],
        fileDiff: {
          name: "demo.abap",
          lang: "abap" as never,
        } as unknown as FileDiffMetadata,
      },
      { languagePackAvailable: true },
    );

    expect(result.langs).toEqual(["abap"]);
    expect(result.fileDiff?.lang).toBe("abap");
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
