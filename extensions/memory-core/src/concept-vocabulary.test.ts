import { describe, expect, it } from "vitest";
import {
  classifyConceptTagScript,
  deriveConceptTags,
  summarizeConceptTagScriptCoverage,
} from "./concept-vocabulary.js";

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

  it("classifies concept tags by script family", () => {
    expect(classifyConceptTagScript("routeur")).toBe("latin");
    expect(classifyConceptTagScript("路由器")).toBe("cjk");
    expect(classifyConceptTagScript("qmd路由器")).toBe("mixed");
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
