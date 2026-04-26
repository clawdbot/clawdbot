import { describe, expect, it } from "vitest";
import { extractModelDirective } from "./model.js";

describe("extractModelDirective", () => {
  describe("basic /model command", () => {
    it("extracts /model with argument", () => {
      const result = extractModelDirective("/model gpt-5");
      expect(result.hasDirective).toBe(true);
      expect(result.rawModel).toBe("gpt-5");
      expect(result.cleaned).toBe("");
    });

    it("does not treat /models as a /model directive", () => {
      const result = extractModelDirective("/models gpt-5");
      expect(result.hasDirective).toBe(false);
      expect(result.rawModel).toBeUndefined();
      expect(result.cleaned).toBe("/models gpt-5");
    });

    it("does not parse /models as a /model directive (no args)", () => {
      const result = extractModelDirective("/models");
      expect(result.hasDirective).toBe(false);
      expect(result.cleaned).toBe("/models");
    });

    it("extracts /model with provider/model format", () => {
      const result = extractModelDirective("/model anthropic/claude-opus-4-6");
      expect(result.hasDirective).toBe(true);
      expect(result.rawModel).toBe("anthropic/claude-opus-4-6");
    });

    it("extracts /model with a runtime override", () => {
      const result = extractModelDirective("/model anthropic/claude-opus-4-7 --runtime claude-cli");
      expect(result.hasDirective).toBe(true);
      expect(result.rawModel).toBe("anthropic/claude-opus-4-7");
      expect(result.rawRuntime).toBe("claude-cli");
      expect(result.cleaned).toBe("");
    });

    it("extracts /model with profile override", () => {
      const result = extractModelDirective("/model gpt-5@myprofile");
      expect(result.hasDirective).toBe(true);
      expect(result.rawModel).toBe("gpt-5");
      expect(result.rawProfile).toBe("myprofile");
    });

    it("keeps OpenRouter preset paths that include @ in the model name", () => {
      const result = extractModelDirective("/model openrouter/@preset/kimi-2-5");
      expect(result.hasDirective).toBe(true);
      expect(result.rawModel).toBe("openrouter/@preset/kimi-2-5");
      expect(result.rawProfile).toBeUndefined();
    });

    it("still allows profile overrides after OpenRouter preset paths", () => {
      const result = extractModelDirective("/model openrouter/@preset/kimi-2-5@work");
      expect(result.hasDirective).toBe(true);
      expect(result.rawModel).toBe("openrouter/@preset/kimi-2-5");
      expect(result.rawProfile).toBe("work");
    });

    it("keeps Cloudflare @cf path segments inside model ids", () => {
      const result = extractModelDirective("/model openai/@cf/openai/gpt-oss-20b");
      expect(result.hasDirective).toBe(true);
      expect(result.rawModel).toBe("openai/@cf/openai/gpt-oss-20b");
      expect(result.rawProfile).toBeUndefined();
    });

    it("allows profile overrides after Cloudflare @cf path segments", () => {
      const result = extractModelDirective("/model openai/@cf/openai/gpt-oss-20b@cf:default");
      expect(result.hasDirective).toBe(true);
      expect(result.rawModel).toBe("openai/@cf/openai/gpt-oss-20b");
      expect(result.rawProfile).toBe("cf:default");
    });

    it("keeps LM Studio @iq* quant suffixes inside model ids", () => {
      const result = extractModelDirective("/model lmstudio/qwen3.6-27b@iq3_xxs");
      expect(result.hasDirective).toBe(true);
      expect(result.rawModel).toBe("lmstudio/qwen3.6-27b@iq3_xxs");
      expect(result.rawProfile).toBeUndefined();
    });

    it("allows profile overrides after LM Studio @iq* quant suffixes", () => {
      const result = extractModelDirective("/model lmstudio/qwen3.6-27b@iq3_xxs@work");
      expect(result.hasDirective).toBe(true);
      expect(result.rawModel).toBe("lmstudio/qwen3.6-27b@iq3_xxs");
      expect(result.rawProfile).toBe("work");
    });

    it("returns no directive for plain text", () => {
      const result = extractModelDirective("hello world");
      expect(result.hasDirective).toBe(false);
      expect(result.cleaned).toBe("hello world");
    });
  });

  describe("alias shortcuts", () => {
    it("recognizes /gpt as model directive when alias is configured", () => {
      const result = extractModelDirective("/gpt", {
        aliases: ["gpt", "sonnet", "opus"],
      });
      expect(result.hasDirective).toBe(true);
      expect(result.rawModel).toBe("gpt");
      expect(result.cleaned).toBe("");
    });

    it("recognizes /gpt: as model directive when alias is configured", () => {
      const result = extractModelDirective("/gpt:", {
        aliases: ["gpt", "sonnet", "opus"],
      });
      expect(result.hasDirective).toBe(true);
      expect(result.rawModel).toBe("gpt");
      expect(result.cleaned).toBe("");
    });

    it("recognizes /sonnet as model directive", () => {
      const result = extractModelDirective("/sonnet", {
        aliases: ["gpt", "sonnet", "opus"],
      });
      expect(result.hasDirective).toBe(true);
      expect(result.rawModel).toBe("sonnet");
    });

    it("recognizes alias mid-message", () => {
      const result = extractModelDirective("switch to /opus please", {
        aliases: ["opus"],
      });
      expect(result.hasDirective).toBe(true);
      expect(result.rawModel).toBe("opus");
      expect(result.cleaned).toBe("switch to please");
    });

    it("is case-insensitive for aliases", () => {
      const result = extractModelDirective("/GPT", { aliases: ["gpt"] });
      expect(result.hasDirective).toBe(true);
      expect(result.rawModel).toBe("GPT");
    });

    it("does not match alias without leading slash", () => {
      const result = extractModelDirective("gpt is great", {
        aliases: ["gpt"],
      });
      expect(result.hasDirective).toBe(false);
    });

    it("does not match unknown aliases", () => {
      const result = extractModelDirective("/unknown", {
        aliases: ["gpt", "sonnet"],
      });
      expect(result.hasDirective).toBe(false);
      expect(result.cleaned).toBe("/unknown");
    });

    it("prefers /model over alias when both present", () => {
      const result = extractModelDirective("/model haiku", {
        aliases: ["gpt"],
      });
      expect(result.hasDirective).toBe(true);
      expect(result.rawModel).toBe("haiku");
    });

    it("handles empty aliases array", () => {
      const result = extractModelDirective("/gpt", { aliases: [] });
      expect(result.hasDirective).toBe(false);
    });

    it("handles undefined aliases", () => {
      const result = extractModelDirective("/gpt");
      expect(result.hasDirective).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("absorbs path-like segments when /model includes extra slashes", () => {
      const result = extractModelDirective("thats not /model gpt-5/tmp/hello");
      expect(result.hasDirective).toBe(true);
      expect(result.cleaned).toBe("thats not");
    });

    it("handles alias with special regex characters", () => {
      const result = extractModelDirective("/test.alias", {
        aliases: ["test.alias"],
      });
      expect(result.hasDirective).toBe(true);
      expect(result.rawModel).toBe("test.alias");
    });

    it("does not match partial alias", () => {
      const result = extractModelDirective("/gpt-turbo", { aliases: ["gpt"] });
      expect(result.hasDirective).toBe(false);
    });

    it("handles empty body", () => {
      const result = extractModelDirective("", { aliases: ["gpt"] });
      expect(result.hasDirective).toBe(false);
      expect(result.cleaned).toBe("");
    });

    it("handles undefined body", () => {
      const result = extractModelDirective(undefined, { aliases: ["gpt"] });
      expect(result.hasDirective).toBe(false);
    });
  });
});
