import { describe, expect, it } from "vitest";
import { resolveCoreToolProfilePolicy } from "./tool-catalog.js";

describe("tool-catalog", () => {
  it("includes code_execution, web_search, x_search, web_fetch, and update_plan in the coding profile policy", () => {
    const policy = resolveCoreToolProfilePolicy("coding");
    expect(policy).toBeDefined();
    expect(policy!.allow).toContain("code_execution");
    expect(policy!.allow).toContain("web_search");
    expect(policy!.allow).toContain("x_search");
    expect(policy!.allow).toContain("web_fetch");
    expect(policy!.allow).toContain("image_generate");
    expect(policy!.allow).toContain("music_generate");
    expect(policy!.allow).toContain("video_generate");
    expect(policy!.allow).toContain("update_plan");
    expect(policy!.allow).not.toContain("browser");
  });

  it("includes bundle MCP tools in coding and messaging profile policies", () => {
    expect(resolveCoreToolProfilePolicy("coding")?.allow).toContain("bundle-mcp");
    expect(resolveCoreToolProfilePolicy("messaging")?.allow).toContain("bundle-mcp");
    expect(resolveCoreToolProfilePolicy("minimal")?.allow).not.toContain("bundle-mcp");
  });

  it("full profile uses wildcard to grant all tools (#76507)", () => {
    const policy = resolveCoreToolProfilePolicy("full");
    expect(policy).toBeDefined();
    expect(policy!.allow).toContain("*");
  });
});
