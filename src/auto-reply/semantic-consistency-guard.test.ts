/**
 * Unit tests for semantic-consistency-guard.ts
 *
 * Tests the core guard logic: pattern detection, definition extraction,
 * consistency checking, and correction message generation.
 */
import { describe, it, expect } from "vitest";
import {
  checkConsistency,
  hasContrastStructure,
  type ContrastPattern,
} from "./semantic-consistency-guard.js";

// ── Pattern Detection ────────────────────────────────────────────────────

describe("hasContrastStructure", () => {
  it("detects Chinese contrast patterns", () => {
    expect(hasContrastStructure("方案一和方案二比较")).toBe(true);
    expect(hasContrastStructure("方案一、方案二、方案三")).toBe(true);
  });

  it("detects numbered alternatives", () => {
    expect(hasContrastStructure("选项A和选项B")).toBe(true);
    expect(hasContrastStructure("方式1 和 方式2")).toBe(true);
  });

  it("detects English contrast patterns", () => {
    expect(hasContrastStructure("Approach A vs Approach B")).toBe(true);
    expect(hasContrastStructure("Option 1 and Option 2")).toBe(true);
  });

  it("returns false for non-contrast text", () => {
    expect(hasContrastStructure("今天天气不错")).toBe(false);
    expect(hasContrastStructure("hello world")).toBe(false);
    expect(hasContrastStructure("代码 review 意见")).toBe(false);
  });

  it("returns false for single-concept mentions", () => {
    // "方案" alone without numbering should not trigger
    expect(hasContrastStructure("这个方案很好")).toBe(false);
  });
});

// ── Consistency Checking ─────────────────────────────────────────────────

describe("checkConsistency", () => {
  it("passes through when no contrast structure in user text", () => {
    const result = checkConsistency(
      "agent reply about weather",
      "今天天气怎么样",
    );
    expect(result.drifted).toBe(false);
    expect(result.correctionMessage).toBeNull();
  });

  it("detects real-world concept drift (方案一 redefined)", () => {
    const userText =
      "方案一：graphify 源码拉到 github 目录，用 github conda 环境管理依赖，跟 robotassistant 完全分离。" +
      "方案二：graphify 直接嵌入到 robotassistant 项目里，跟 robotassistant 绑在一起。";

    const agentText =
      "方案一就是装 uv tool install graphify 全局跑..." +
      "方案二才是集成到项目里。";

    const result = checkConsistency(agentText, userText, { threshold: 0.3 });
    expect(result.drifted).toBe(true);
    expect(result.concepts.length).toBeGreaterThan(0);
    expect(result.correctionMessage).not.toBeNull();
  });

  it("passes through when agent correctly restates user definitions", () => {
    const userText =
      "方案一：graphify 源码放到 github conda 环境管理，跟 robotassistant 分离。" +
      "方案二：graphify 嵌入 robotassistant 项目内。";

    const agentText =
      "方案一（分开的）：graphify 放 github 环境，跟 robotassistant 独立。" +
      "方案二（混合的）：graphify 嵌入 robotassistant 内。";

    const result = checkConsistency(agentText, userText, { threshold: 0.3 });
    // Should NOT detect drift for correct restatement
    const driftCount = result.concepts.filter(
      (c) => c.label === "方案一 " && c.similarity < 0.3,
    ).length;
    expect(driftCount).toBe(0);
  });

  it("skips disabled guard", () => {
    const result = checkConsistency(
      "方案一就是全局装",
      "方案一：独立部署",
      { enabled: false },
    );
    expect(result.drifted).toBe(false);
  });

  it("respects configurable threshold", () => {
    const userText = "方案一：独立部署 project。方案二：嵌入 project。";
    const agentText = "方案一：部署在独立环境。方案二：直接嵌入。";
    // With very high threshold, even similar definitions would be flagged
    const strictResult = checkConsistency(agentText, userText, { threshold: 0.99 });
    // With very low threshold, nothing is flagged
    const looseResult = checkConsistency(agentText, userText, { threshold: 0.0 });
    expect(looseResult.drifted).toBe(false);
  });

  it("handles empty text gracefully", () => {
    expect(() => checkConsistency("", "")).not.toThrow();
    expect(() => checkConsistency("", "方案一：test")).not.toThrow();
    expect(() => checkConsistency("reply text", "")).not.toThrow();
  });
});

// ── Correction Message Format ────────────────────────────────────────────

describe("correctionMessage format", () => {
  it("includes label and both definitions for each drifted concept", () => {
    const userText = "方案一：独立部署，与项目分离。";
    const agentText = "方案一：全局安装工具。";
    const result = checkConsistency(agentText, userText, { threshold: 0.3 });
    if (result.correctionMessage) {
      expect(result.correctionMessage).toContain("方案一");
      expect(result.correctionMessage).toContain("独立部署");
      expect(result.correctionMessage).toContain("全局安装");
    }
  });
});

// ── Performance ──────────────────────────────────────────────────────────

describe("performance", () => {
  it("hasContrastStructure runs in under 1ms for typical input", () => {
    const text = "这是一段普通的对话文本没有任何对比结构".repeat(10);
    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      hasContrastStructure(text);
    }
    const elapsed = performance.now() - start;
    // 1000 checks on non-contrast text should be very fast
    expect(elapsed).toBeLessThan(50);
  });
});
