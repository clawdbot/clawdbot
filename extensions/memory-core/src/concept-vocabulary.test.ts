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

  it.each([
    ["Store the session in kv and back up to s3 nightly.", ["kv", "s3"], []],
    ["Played the mkv recording and tuned the css3 layout.", ["mkv", "css3"], ["kv", "s3"]],
    ["kv𐐀 𐐀kv s3𐐀 𐐀s3", ["kv𐐨", "𐐨kv", "s3𐐨", "𐐨s3"], ["kv", "s3"]],
  ])("preserves short glossary terms only as whole words: %s", (snippet, present, absent) => {
    const tags = deriveConceptTags({ path: "memory/2026-04-04.md", snippet });
    expect(tags).toEqual(expect.arrayContaining(present));
    for (const tag of absent) {
      expect(tags).not.toContain(tag);
    }
  });

  it.each(["42", "1.00", "51-54", "１.００", "５１-５４", "2026-04-04", "2026-04-04.md"])(
    "rejects numeric and date noise without losing technical tags: %s",
    (noise) => {
      const tags = deriveConceptTags({
        path: "memory/2026-04-04.md",
        snippet: `${noise} kv s3 router`,
      });
      expect(tags).toStrictEqual(["kv", "router", "s3"]);
    },
  );

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

  it("ignores project and recall annotations when deriving concept tags", () => {
    const tags = deriveConceptTags({
      path: "memory/2026-07-28.md",
      snippet:
        "Alpha ingest workflow. <!-- project: github.com/acme/alpha --> <!-- trigger: kraken deploy ritual --> <!-- importance: 8 -->",
    });

    expect(tags).toContain("alpha");
    expect(tags).toContain("ingest");
    expect(tags).not.toContain("github.com/acme/alpha");
    expect(tags).not.toContain("acme");
    expect(tags).not.toContain("kraken");
    expect(tags).not.toContain("importance");
  });

  it("summarizes entry coverage across latin, cjk, and mixed tags", () => {
    expect(
      summarizeConceptTagScriptCoverage([
        ["routeur", "sauvegarde"],
        ["路由器", "备份"],
        ["vectors", "路由器"],
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
