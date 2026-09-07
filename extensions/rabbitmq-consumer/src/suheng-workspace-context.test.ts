import { describe, expect, it } from "vitest";
import {
  buildSuhengWorkspaceContext,
  shouldInjectSuhengWorkspaceContext,
} from "./suheng-workspace-context.js";

describe("Suheng workspace context", () => {
  it.each([
    "请创建工作文件夹：舆情报告（夙衡）",
    "生成一份标题含中文引号的 PPT",
    "把分析结果保存成 Python 脚本",
    "Create a report file in the workspace",
  ])("detects workspace and generated-file requests: %s", (message) => {
    expect(shouldInjectSuhengWorkspaceContext(message)).toBe(true);
  });

  it.each(["帮我查一下今天的舆情", "你好", "分析这篇文章的观点"])(
    "does not add file-generation guidance to ordinary turns: %s",
    (message) => {
      expect(shouldInjectSuhengWorkspaceContext(message)).toBe(false);
      expect(buildSuhengWorkspaceContext(message)).toBe("");
    },
  );

  it.each(["以docx版发给我", "这个文件打不开，你给我普通WORD版", "导出投诉函.docx"])(
    "guides real Word generation and repair: %s",
    (message) => {
      const context = buildSuhengWorkspaceContext(message);
      expect(context).toContain("python-docx");
      expect(context).toContain("不能");
      expect(context).toContain("HTML");
      expect(context).toContain("file_share");
      expect(context).toContain("exec");
      expect(buildSuhengWorkspaceContext(message)).toBe(context);
    },
  );

  it("returns deterministic Unicode-safe Python guidance", () => {
    const context = buildSuhengWorkspaceContext("请生成中文目录下的报告文件");

    expect(context).toContain("[suheng-workspace]");
    expect(context).toContain("保留用户要求的中文目录名和文件名");
    expect(context).toContain("pathlib.Path(sys.argv[1])");
    expect(context).toContain("python -m py_compile");
    expect(context.length).toBeLessThan(1_200);
    expect(buildSuhengWorkspaceContext("请生成中文目录下的报告文件")).toBe(context);
  });
});
