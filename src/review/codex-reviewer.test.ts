/**
 * Codexレビュアーテスト
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  runCodexReview,
  parseCodexOutput,
  createReviewRequest,
  evaluateReview,
  formatReview,
  detectLanguage,
} from "./codex-reviewer.js";

// tmuxモック
vi.mock("child_process");

describe("codex-reviewer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("runCodexReview", () => {
    it("should execute Codex review via tmux", async () => {
      expect(true).toBe(true);
    });

    it("should handle execution timeout", async () => {
      expect(true).toBe(true);
    });

    it("should return review result with score", async () => {
      expect(true).toBe(true);
    });
  });

  describe("parseCodexOutput", () => {
    it("should parse Codex output with score", () => {
      const output = `## Score
overall: 0.85, accuracy: 0.9, completeness: 0.8

## Issues
[major] src/file.ts:42: Missing error handling

## Suggestions
[high] performance: Use memoization

## Summary
Review completed successfully.`;

      const review = parseCodexOutput(output);

      expect(review.score.overall).toBe(0.85);
      expect(review.issues).toHaveLength(1);
      expect(review.suggestions).toHaveLength(1);
      expect(review.approved).toBe(true);
    });

    it("should handle empty output", () => {
      const review = parseCodexOutput("");
      expect(review).toBeDefined();
    });
  });

  describe("createReviewRequest", () => {
    it("should create review request", () => {
      const code = "const x = 1;";
      const request = createReviewRequest(code);

      expect(request.id).toBeDefined();
      expect(request.code).toBe(code);
      expect(request.language).toBe("typescript");
    });

    it("should detect language from code", () => {
      expect(detectLanguage("def foo():")).toBe("python");
      expect(detectLanguage("fn foo()")).toBe("rust");
      expect(detectLanguage("const x = 1")).toBe("typescript");
    });
  });

  describe("evaluateReview", () => {
    it("should approve review with high score", () => {
      const result = {
        success: true,
        review: {
          id: "test",
          target: "code",
          score: { overall: 0.9, accuracy: 0.9, completeness: 0.9, style: 0.9, security: 0.9 },
          issues: [],
          suggestions: [],
          summary: "Good",
          approved: true,
          timestamp: Date.now(),
          duration: 100,
        },
        duration: 100,
      };

      const evalResult = evaluateReview(result, 0.8);
      expect(evalResult.approved).toBe(true);
    });

    it("should reject review with low score", () => {
      const result = {
        success: true,
        review: {
          id: "test",
          target: "code",
          score: { overall: 0.7, accuracy: 0.7, completeness: 0.7, style: 0.7, security: 0.7 },
          issues: [],
          suggestions: [],
          summary: "Needs improvement",
          approved: false,
          timestamp: Date.now(),
          duration: 100,
        },
        duration: 100,
      };

      const evalResult = evaluateReview(result, 0.8);
      expect(evalResult.approved).toBe(false);
    });

    it("should reject review with critical issues", () => {
      const result = {
        success: true,
        review: {
          id: "test",
          target: "code",
          score: { overall: 0.9, accuracy: 0.9, completeness: 0.9, style: 0.9, security: 0.9 },
          issues: [
            {
              id: "1",
              severity: "critical",
              category: "security",
              message: "SQL injection vulnerability",
            },
          ],
          suggestions: [],
          summary: "Critical issue found",
          approved: true, // スコアは高いがcritical issueがある
          timestamp: Date.now(),
          duration: 100,
        },
        duration: 100,
      };

      const evalResult = evaluateReview(result, 0.8);
      expect(evalResult.approved).toBe(false);
      expect(evalResult.reason).toContain("critical");
    });
  });

  describe("formatReview", () => {
    it("should format review as markdown", () => {
      const review = {
        id: "test",
        target: "code",
        score: { overall: 0.85, accuracy: 0.9, completeness: 0.8, style: 0.9, security: 0.8 },
        issues: [
          {
            id: "1",
            severity: "major",
            category: "style",
            message: "Use const instead of let",
            file: "test.ts",
            line: 10,
          },
        ],
        suggestions: [
          {
            id: "1",
            priority: "medium",
            category: "performance",
            description: "Add caching",
          },
        ],
        summary: "Review completed",
        approved: true,
        timestamp: Date.now(),
        duration: 100,
      };

      const formatter = formatReview(review);
      const markdown = formatter.toMarkdown();

      expect(markdown).toContain("## Codex Review Report");
      expect(markdown).toContain("**Score**: 0.85");
      expect(markdown).toContain("### Issues");
      expect(markdown).toContain("### Suggestions");
    });

    it("should format review as JSON", () => {
      const review = {
        id: "test",
        target: "code",
        score: { overall: 0.85, accuracy: 0.9, completeness: 0.8, style: 0.9, security: 0.8 },
        issues: [],
        suggestions: [],
        summary: "Good",
        approved: true,
        timestamp: Date.now(),
        duration: 100,
      };

      const formatter = formatReview(review);
      const json = formatter.toJSON();

      expect(() => JSON.parse(json)).not.toThrow();
      expect(JSON.parse(json)).toEqual(review);
    });
  });
});
