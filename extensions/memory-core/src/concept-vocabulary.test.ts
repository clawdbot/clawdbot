// Memory Core tests cover concept vocabulary plugin behavior.
import { describe, expect, it } from "vitest";
import { deriveConceptTags, summarizeConceptTagScriptCoverage } from "./concept-vocabulary.js";

describe("concept vocabulary", () => {
  it("extracts Unicode-aware concept tags for common European languages", () => {
    const tags = deriveConceptTags({
      path: "memory/2026-04-04.md",
      snippet:
        "Configuración de gateway, configuration du routeur, Sicherung und Überwachung Glacier.",
    });

    expect(tags).toStrictEqual([
      "gateway",
      "glacier",
      "routeur",
      "sicherung",
      "überwachung",
      "configuración",
      "configuration",
    ]);
    expect(tags).not.toContain("de");
    expect(tags).not.toContain("du");
    expect(tags).not.toContain("und");
    expect(tags).not.toContain("2026-04-04.md");
  });

  it("preserves short protected-glossary terms past the latin minimum-length gate", () => {
    const tags = deriveConceptTags({
      path: "memory/2026-04-04.md",
      snippet: "Store the session in kv and back up to s3 nightly.",
    });

    // "kv" and "s3" are 2-char latin glossary entries that the generic min-length-3 gate would drop.
    expect(tags).toContain("kv");
    expect(tags).toContain("s3");
  });

  it("does not surface short glossary terms that only appear inside longer words", () => {
    const tags = deriveConceptTags({
      path: "memory/2026-04-04.md",
      snippet: "Played the mkv recording and tuned the css3 layout.",
    });

    // "kv"/"s3" are substrings of "mkv"/"css3"; whole-word matching must not emit them as tags.
    expect(tags).not.toContain("kv");
    expect(tags).not.toContain("s3");
    expect(tags).toContain("mkv");
    expect(tags).toContain("css3");
  });

  it("extracts protected and segmented CJK concept tags", () => {
    const tags = deriveConceptTags({
      path: "memory/2026-04-04.md",
      snippet:
        "障害対応ルーター設定とバックアップ確認。路由器备份与网关同步。라우터 백업 페일오버 점검.",
    });

    expect(tags).toStrictEqual([
      "バックアップ",
      "ルーター",
      "障害対応",
      "路由器",
      "备份",
      "网关",
      "라우터",
      "백업",
    ]);
    expect(tags).not.toContain("ルー");
    expect(tags).not.toContain("ター");
  });

  it("drops chat scaffolding stop words from derived concept tags", () => {
    const tags = deriveConceptTags({
      path: "memory/.dreams/session-corpus/2026-04-16.txt",
      snippet:
        "Assistant: the system should remind you about the Ollama provider setup in your workspace.",
    });

    expect(tags).toContain("ollama");
    expect(tags).toContain("provider");
    expect(tags).not.toContain("assistant");
    expect(tags).not.toContain("system");
    expect(tags).not.toContain("the");
    expect(tags).not.toContain("you");
    expect(tags).not.toContain("your");
  });

  it("summarizes entry coverage across latin, cjk, and mixed tags", () => {
    expect(
      summarizeConceptTagScriptCoverage([
        ["routeur", "sauvegarde"],
        ["路由器", "备份"],
        ["qmd", "路由器"],
        ["сервер"],
      ]),
    ).toEqual({
      latinEntryCount: 1,
      cjkEntryCount: 1,
      mixedEntryCount: 1,
      otherEntryCount: 1,
    });
  });
});
