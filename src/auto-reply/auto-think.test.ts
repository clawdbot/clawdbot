import { describe, expect, it } from "vitest";
import { classifyThinkLevel, type AutoThinkConfig } from "./auto-think.js";

describe("auto-think", () => {
  describe("classifyThinkLevel", () => {
    it("returns undefined when disabled", () => {
      expect(classifyThinkLevel("debug this code", { enabled: false })).toBeUndefined();
      expect(classifyThinkLevel("debug this code", undefined)).toBeUndefined();
      expect(classifyThinkLevel("debug this code", {})).toBeUndefined();
    });

    it("returns undefined for empty messages", () => {
      const config: AutoThinkConfig = { enabled: true };
      expect(classifyThinkLevel("", config)).toBeUndefined();
      expect(classifyThinkLevel("   ", config)).toBeUndefined();
    });

    describe("high complexity detection", () => {
      const config: AutoThinkConfig = { enabled: true };

      it("detects debug-related messages", () => {
        expect(classifyThinkLevel("Can you debug this code?", config)).toBe("high");
        expect(classifyThinkLevel("I'm debugging an issue", config)).toBe("high");
      });

      it("detects error-related messages", () => {
        expect(classifyThinkLevel("Getting an error: TypeError", config)).toBe("high");
        expect(classifyThinkLevel("Here's the stack trace", config)).toBe("high");
        expect(classifyThinkLevel("Exception thrown at line 42", config)).toBe("high");
      });

      it("detects security-related messages", () => {
        expect(classifyThinkLevel("Review for security vulnerabilities", config)).toBe("high");
        expect(classifyThinkLevel("Is this code vulnerable to SQL injection?", config)).toBe(
          "high",
        );
        expect(classifyThinkLevel("Security audit needed", config)).toBe("high");
      });

      it("detects architecture-related messages", () => {
        expect(classifyThinkLevel("Help me architect this system", config)).toBe("high");
        expect(classifyThinkLevel("What design pattern should I use?", config)).toBe("high");
        expect(classifyThinkLevel("System design for a chat app", config)).toBe("high");
      });

      it("detects large code blocks", () => {
        const largeCode = "```\n" + "x".repeat(600) + "\n```";
        expect(classifyThinkLevel(largeCode, config)).toBe("high");
      });
    });

    describe("medium complexity detection", () => {
      const config: AutoThinkConfig = { enabled: true };

      it("detects how-to questions", () => {
        expect(classifyThinkLevel("How do I implement a linked list?", config)).toBe("medium");
        expect(classifyThinkLevel("How should I structure this?", config)).toBe("medium");
        expect(classifyThinkLevel("How can I improve performance?", config)).toBe("medium");
      });

      it("detects analysis requests", () => {
        expect(classifyThinkLevel("Explain how this algorithm works", config)).toBe("medium");
        expect(classifyThinkLevel("Analyze this data structure", config)).toBe("medium");
        expect(classifyThinkLevel("Compare these two approaches", config)).toBe("medium");
      });

      it("detects step-by-step requests", () => {
        expect(classifyThinkLevel("Walk me through this step by step", config)).toBe("medium");
        expect(classifyThinkLevel("Give me a step-by-step guide", config)).toBe("medium");
      });

      it("detects implementation requests", () => {
        expect(classifyThinkLevel("Implement a binary search tree", config)).toBe("medium");
        expect(classifyThinkLevel("Build a REST API for this", config)).toBe("medium");
        expect(classifyThinkLevel("Create a function that does X", config)).toBe("medium");
      });

      it("detects medium code blocks", () => {
        const mediumCode = "```\n" + "x".repeat(150) + "\n```";
        expect(classifyThinkLevel(mediumCode, config)).toBe("medium");
      });
    });

    describe("low complexity detection", () => {
      const config: AutoThinkConfig = { enabled: true };

      it("detects simple what/when/where questions", () => {
        expect(classifyThinkLevel("What is a closure?", config)).toBe("low");
        expect(classifyThinkLevel("When was Python released?", config)).toBe("low");
        expect(classifyThinkLevel("Where is the config file?", config)).toBe("low");
      });

      it("detects translation/conversion requests", () => {
        expect(classifyThinkLevel("Translate this to Spanish", config)).toBe("low");
        expect(classifyThinkLevel("Convert this to JSON", config)).toBe("low");
        expect(classifyThinkLevel("Reformat this code", config)).toBe("low");
      });

      it("detects simple list requests", () => {
        expect(classifyThinkLevel("List the programming languages", config)).toBe("low");
        expect(classifyThinkLevel("Name all the HTTP methods", config)).toBe("low");
      });
    });

    describe("length-based fallbacks", () => {
      const config: AutoThinkConfig = { enabled: true };

      it("returns off for very short messages", () => {
        expect(classifyThinkLevel("hi", config)).toBe("off");
        expect(classifyThinkLevel("thanks", config)).toBe("off");
      });

      it("returns medium for very long messages", () => {
        const longMessage = "a".repeat(2500);
        expect(classifyThinkLevel(longMessage, config)).toBe("medium");
      });

      it("returns minimal for unclassified messages", () => {
        expect(
          classifyThinkLevel("Here's some random text that doesn't match patterns", config),
        ).toBe("minimal");
      });
    });

    describe("floor and ceiling", () => {
      it("respects floor setting", () => {
        const config: AutoThinkConfig = { enabled: true, floor: "low" };
        expect(classifyThinkLevel("hi", config)).toBe("low"); // Would be "off" without floor
      });

      it("respects ceiling setting", () => {
        const config: AutoThinkConfig = { enabled: true, ceiling: "medium" };
        expect(classifyThinkLevel("debug this security vulnerability", config)).toBe("medium"); // Would be "high" without ceiling
      });

      it("respects both floor and ceiling", () => {
        const config: AutoThinkConfig = { enabled: true, floor: "low", ceiling: "medium" };
        expect(classifyThinkLevel("hi", config)).toBe("low");
        expect(classifyThinkLevel("debug this", config)).toBe("medium");
      });
    });

    describe("custom rules", () => {
      it("applies custom rules before built-in patterns", () => {
        const config: AutoThinkConfig = {
          enabled: true,
          rules: [{ match: "newsletter", level: "medium" }],
        };
        expect(classifyThinkLevel("Write the newsletter", config)).toBe("medium");
      });

      it("supports regex patterns in rules", () => {
        const config: AutoThinkConfig = {
          enabled: true,
          rules: [{ match: "urgent|asap|immediately", level: "high" }],
        };
        expect(classifyThinkLevel("Fix this ASAP", config)).toBe("high");
        expect(classifyThinkLevel("This is urgent", config)).toBe("high");
      });

      it("skips invalid regex patterns", () => {
        const config: AutoThinkConfig = {
          enabled: true,
          rules: [
            { match: "[invalid(regex", level: "high" },
            { match: "valid", level: "medium" },
          ],
        };
        expect(classifyThinkLevel("This is valid", config)).toBe("medium");
      });

      it("first matching rule wins", () => {
        const config: AutoThinkConfig = {
          enabled: true,
          rules: [
            { match: "first", level: "low" },
            { match: "first", level: "high" },
          ],
        };
        expect(classifyThinkLevel("first match wins", config)).toBe("low");
      });
    });
  });
});
