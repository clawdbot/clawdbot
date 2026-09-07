import { describe, expect, it } from "vitest";
import { inferBuiltinSkillName, validateBuiltinSkillSelection } from "./builtin-skill-routing.js";

describe("validateBuiltinSkillSelection", () => {
  it("keeps bundled skills available and requires publication for every new name", async () => {
    await expect(validateBuiltinSkillSelection("ai-public-opinion-brief")).resolves.toBeUndefined();
    await expect(
      validateBuiltinSkillSelection("new-skill", async () => true),
    ).resolves.toBeUndefined();
    await expect(validateBuiltinSkillSelection("new-skill", async () => false)).rejects.toThrow(
      "not published",
    );
    await expect(validateBuiltinSkillSelection("new-skill")).rejects.toThrow("not published");
    await expect(validateBuiltinSkillSelection("../private", async () => true)).rejects.toThrow(
      "not published",
    );
    await expect(
      validateBuiltinSkillSelection("new-skill", async () => {
        throw new Error("DB unavailable");
      }),
    ).rejects.toThrow("DB unavailable");
  });
});

describe("inferBuiltinSkillName", () => {
  it("routes explicit public-opinion brief requests to the brief skill", () => {
    expect(inferBuiltinSkillName("深圳赛百味维修人员穿鞋踩踏出餐区，写撰写该事件舆情速报")).toBe(
      "ai-public-opinion-brief",
    );
    expect(inferBuiltinSkillName("根据刚才的新通报写一份舆情续报")).toBe("ai-public-opinion-brief");
  });

  it("routes formal public-opinion analysis requests to the government report skill", () => {
    expect(inferBuiltinSkillName("请生成正式政务舆情分析报告")).toBe(
      "gov-public-opinion-analysis-agent",
    );
    expect(inferBuiltinSkillName("研判该事件的网络舆情风险并形成舆情专报")).toBe(
      "gov-public-opinion-analysis-agent",
    );
  });

  it("does not capture ordinary reports or questions that merely mention public opinion", () => {
    expect(inferBuiltinSkillName("  ")).toBeUndefined();
    expect(inferBuiltinSkillName("写一份销售分析报告")).toBeUndefined();
    expect(inferBuiltinSkillName("什么是舆情？")).toBeUndefined();
    expect(inferBuiltinSkillName("这篇新闻提到了舆情速报制度，请概括一下")).toBeUndefined();
  });
});
