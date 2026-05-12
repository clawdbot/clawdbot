import { describe, expect, it } from "vitest";
import { expandQueryForFts, extractKeywords } from "./query-expansion.js";

describe("extractKeywords", () => {
  it("extracts keywords from English conversational query", () => {
    const keywords = extractKeywords("that thing we discussed about the API");
    expect(keywords).toStrictEqual(["discussed", "api"]);
  });

  it("extracts keywords from Chinese conversational query", () => {
    const keywords = extractKeywords("之前讨论的那个方案");
    expect(keywords).toStrictEqual([
      "之",
      "讨",
      "论",
      "个",
      "方",
      "案",
      "前讨",
      "讨论",
      "论的",
      "的那",
      "个方",
      "方案",
    ]);
  });

  it("extracts keywords from mixed language query", () => {
    const keywords = extractKeywords("昨天讨论的 API design");
    expect(keywords).toStrictEqual([
      "昨",
      "天",
      "讨",
      "论",
      "天讨",
      "讨论",
      "论的",
      "api",
      "design",
    ]);
  });

  it("returns specific technical terms", () => {
    const keywords = extractKeywords("what was the solution for the CFR bug");
    expect(keywords).toStrictEqual(["solution", "cfr", "bug"]);
  });

  it("extracts keywords from Korean conversational query", () => {
    const keywords = extractKeywords("어제 논의한 배포 전략");
    expect(keywords).toStrictEqual(["논의한", "배포", "전략"]);
  });

  it("strips Korean particles to extract stems", () => {
    const keywords = extractKeywords("서버에서 발생한 에러를 확인");
    expect(keywords).toStrictEqual(["서버에서", "서버", "발생한", "에러를", "에러", "확인"]);
  });

  it("filters Korean stop words including inflected forms", () => {
    const keywords = extractKeywords("나는 그리고 그래서");
    expect(keywords).toStrictEqual([]);
  });

  it("filters inflected Korean stop words not explicitly listed", () => {
    const keywords = extractKeywords("그녀는 우리는");
    expect(keywords).toStrictEqual([]);
  });

  it("does not produce bogus single-char stems from particle stripping", () => {
    const keywords = extractKeywords("논의");
    expect(keywords).toStrictEqual(["논의"]);
  });

  it("strips longest Korean trailing particles first", () => {
    const keywords = extractKeywords("기능으로 설명");
    expect(keywords).toStrictEqual(["기능으로", "기능", "설명"]);
  });

  it("keeps stripped ASCII stems for mixed Korean tokens", () => {
    const keywords = extractKeywords("API를 배포했다");
    expect(keywords).toStrictEqual(["api를", "api", "배포했다"]);
  });

  it("handles mixed Korean and English query", () => {
    const keywords = extractKeywords("API 배포에 대한 논의");
    expect(keywords).toStrictEqual(["api", "배포에", "배포", "대한", "논의"]);
  });

  it("extracts keywords from Japanese conversational query", () => {
    const keywords = extractKeywords("昨日話したデプロイ戦略");
    expect(keywords).toStrictEqual(["昨日話", "日話", "デプロイ", "戦略"]);
  });

  it("handles mixed Japanese and English query", () => {
    const keywords = extractKeywords("昨日話したAPIのバグ");
    expect(keywords).toStrictEqual(["昨日話", "日話", "api", "バグ"]);
  });

  it("filters Japanese stop words", () => {
    const keywords = extractKeywords("これ それ そして どう");
    expect(keywords).toStrictEqual([]);
  });

  it("extracts keywords from Spanish conversational query", () => {
    const keywords = extractKeywords("ayer hablamos sobre la estrategia de despliegue");
    expect(keywords).toStrictEqual(["hablamos", "estrategia", "despliegue"]);
  });

  it("extracts keywords from Portuguese conversational query", () => {
    const keywords = extractKeywords("ontem falamos sobre a estratégia de implantação");
    expect(keywords).toStrictEqual(["falamos", "estratégia", "implantação"]);
  });

  it("filters Spanish and Portuguese question stop words", () => {
    const keywords = extractKeywords("cómo cuando donde porquê quando onde");
    expect(keywords).toStrictEqual([]);
  });

  it("extracts keywords from Arabic conversational query", () => {
    const keywords = extractKeywords("بالأمس ناقشنا استراتيجية النشر");
    expect(keywords).toStrictEqual(["ناقشنا", "استراتيجية", "النشر"]);
  });

  it("filters Arabic question stop words", () => {
    const keywords = extractKeywords("كيف متى أين ماذا");
    expect(keywords).toStrictEqual([]);
  });

  it("handles empty query", () => {
    expect(extractKeywords("")).toStrictEqual([]);
    expect(extractKeywords("   ")).toStrictEqual([]);
  });

  it("handles query with only stop words", () => {
    const keywords = extractKeywords("the a an is are");
    expect(keywords).toStrictEqual([]);
  });

  it("removes duplicate keywords", () => {
    const keywords = extractKeywords("test test testing");
    expect(keywords).toStrictEqual(["test", "testing"]);
  });

  describe("with trigram tokenizer", () => {
    const trigramOpts = { ftsTokenizer: "trigram" as const };

    it("emits whole CJK block instead of unigrams in trigram mode", () => {
      const defaultKeywords = extractKeywords("之前讨论的那个方案");
      const trigramKeywords = extractKeywords("之前讨论的那个方案", trigramOpts);
      expect(defaultKeywords).toStrictEqual([
        "之",
        "讨",
        "论",
        "个",
        "方",
        "案",
        "前讨",
        "讨论",
        "论的",
        "的那",
        "个方",
        "方案",
      ]);
      expect(trigramKeywords).toStrictEqual(["之前讨论的那个方案"]);
    });

    it("skips Japanese kanji bigrams in trigram mode", () => {
      const defaultKeywords = extractKeywords("経済政策について");
      const trigramKeywords = extractKeywords("経済政策について", trigramOpts);
      expect(defaultKeywords).toStrictEqual(["経済政策", "経済", "済政", "政策", "について"]);
      expect(trigramKeywords).toStrictEqual(["経済政策", "について"]);
    });

    it("still filters stop words in trigram mode", () => {
      const keywords = extractKeywords("これ それ そして どう", trigramOpts);
      expect(keywords).toStrictEqual([]);
    });

    it("does not affect English keyword extraction", () => {
      const keywords = extractKeywords("that thing we discussed about the API", trigramOpts);
      expect(keywords).toStrictEqual(["discussed", "api"]);
    });
  });
});

describe("expandQueryForFts", () => {
  it("returns original query and extracted keywords", () => {
    const result = expandQueryForFts("that API we discussed");
    expect(result).toStrictEqual({
      original: "that API we discussed",
      keywords: ["api", "discussed"],
      expanded: "that API we discussed OR api OR discussed",
    });
  });

  it("builds expanded OR query for FTS", () => {
    const result = expandQueryForFts("the solution for bugs");
    expect(result).toStrictEqual({
      original: "the solution for bugs",
      keywords: ["solution", "bugs"],
      expanded: "the solution for bugs OR solution OR bugs",
    });
  });

  it("returns original query when no keywords extracted", () => {
    const result = expandQueryForFts("the");
    expect(result).toStrictEqual({
      original: "the",
      keywords: [],
      expanded: "the",
    });
  });
});
