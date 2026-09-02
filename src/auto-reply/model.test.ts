/** Tests model reference formatting and parsing helpers used by auto-reply. */
import { describe, expect, it } from "vitest";
import { extractModelDirective } from "./model.js";

describe("extractModelDirective", () => {
  describe("basic /model command", () => {
    it("extracts /model with argument", () => {
      const result = extractModelDirective("/model gpt-5");
      expect(result.hasDirective).toBe(true);
      expect(result.source).toBe("model");
      expect(result.rawModel).toBe("gpt-5");
      expect(result.scope).toBeUndefined();
      expect(result.cleaned).toBe("");
    });

    it("extracts a session-only selection with -s", () => {
      const result = extractModelDirective("/model anthropic/claude-opus-4-6 -s");
      expect(result.hasDirective).toBe(true);
      expect(result.rawModel).toBe("anthropic/claude-opus-4-6");
      expect(result.scope).toBe("session");
      expect(result.cleaned).toBe("");
    });

    it("extracts a session-only default reset with --session", () => {
      const result = extractModelDirective("/model default --session");
      expect(result.hasDirective).toBe(true);
      expect(result.rawModel).toBe("default");
      expect(result.scope).toBe("session");
      expect(result.cleaned).toBe("");
    });

    it.each(["-slow", "--sessional"])(
      "does not treat partial session option %s as session-only",
      (option) => {
        const result = extractModelDirective(`/model anthropic/claude-opus-4-6 ${option}`);
        expect(result.hasDirective).toBe(true);
        expect(result.rawModel).toBe("anthropic/claude-opus-4-6");
        expect(result.cleaned).toBe(option);
      },
    );

    it("keeps here as a model name and preserves following message text", () => {
      const result = extractModelDirective("please /model here continue");
      expect(result.hasDirective).toBe(true);
      expect(result.rawModel).toBe("here");
      expect(result.cleaned).toBe("please continue");
    });

    it("parses a leading -s as a model-less session option", () => {
      const result = extractModelDirective("/model -s opus");
      expect(result.hasDirective).toBe(true);
      expect(result.rawModel).toBeUndefined();
      expect(result.cleaned).toBe("opus");
    });

    it.each(["-s", "--session"])("parses model-less session option %s", (option) => {
      const result = extractModelDirective(`/model ${option}`);
      expect(result.hasDirective).toBe(true);
      expect(result.rawModel).toBeUndefined();
      expect(result.cleaned).toBe("");
    });

    it.each(["--runtime codex", "runtime=codex", "harness=codex"])(
      "parses model-less runtime option %s",
      (option) => {
        const result = extractModelDirective(`/model ${option}`);
        expect(result.hasDirective).toBe(true);
        expect(result.rawModel).toBeUndefined();
        expect(result.rawRuntime).toBe("codex");
        expect(result.cleaned).toBe("");
      },
    );

    it("does not consume a reserved option as a missing runtime value", () => {
      const result = extractModelDirective("/model --runtime --session");
      expect(result.hasDirective).toBe(true);
      expect(result.rawModel).toBeUndefined();
      expect(result.rawRuntime).toBeUndefined();
      expect(result.cleaned).toBe("--runtime --session");
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

    it.each([
      "--runtime claude-cli -s",
      "-s --runtime claude-cli",
      "runtime= claude-cli -s",
      "runtime=claude-cli -s",
      "-s runtime= claude-cli",
      "-s runtime=claude-cli",
      "harness= claude-cli -s",
      "harness=claude-cli -s",
      "-s harness= claude-cli",
      "-s harness=claude-cli",
    ])("extracts runtime and session options from %s", (options) => {
      const result = extractModelDirective(`/model anthropic/claude-opus-4-7 ${options}`);
      expect(result.hasDirective).toBe(true);
      expect(result.rawModel).toBe("anthropic/claude-opus-4-7");
      expect(result.rawRuntime).toBe("claude-cli");
      expect(result.scope).toBe("session");
      expect(result.cleaned).toBe("");
    });

    it.each([
      ["-a", "agent"],
      ["--agent", "agent"],
      ["-g", "global"],
      ["--global", "global"],
    ] as const)("extracts %s as %s scope", (option, scope) => {
      const result = extractModelDirective(`/model openai/gpt-5.6-sol ${option}`);
      expect(result.rawModel).toBe("openai/gpt-5.6-sol");
      expect(result.scope).toBe(scope);
      expect(result.cleaned).toBe("");
    });

    it.each(["--runtime codex -a", "-g --runtime codex"])(
      "extracts runtime and persistent scope from %s",
      (options) => {
        const result = extractModelDirective(`/model openai/gpt-5.6-sol ${options}`);
        expect(result.rawRuntime).toBe("codex");
        expect(result.scope).toBe(options.includes("-a") ? "agent" : "global");
        expect(result.cleaned).toBe("");
      },
    );

    it("preserves duplicate runtime and session options for validation", () => {
      const runtime = extractModelDirective(
        "/model openai/gpt-5.6-luna --runtime codex --runtime acp",
      );
      expect(runtime.rawRuntime).toBe("codex");
      expect(runtime.cleaned).toBe("--runtime acp");

      const session = extractModelDirective("/model openai/gpt-5.6-luna -s -s");
      expect(session.scopeConflict).toBe(true);
      expect(session.cleaned).toBe("-s");
    });

    it("marks conflicting scope options", () => {
      const result = extractModelDirective("/model openai/gpt-5.6-luna -a -g");
      expect(result.scope).toBe("agent");
      expect(result.scopeConflict).toBe(true);
      expect(result.cleaned).toBe("-g");
    });

    it("keeps partial runtime option names as ordinary text", () => {
      const result = extractModelDirective("/model openai/gpt-5.6-luna runtime-extra=codex");
      expect(result.rawModel).toBe("openai/gpt-5.6-luna");
      expect(result.rawRuntime).toBeUndefined();
      expect(result.cleaned).toBe("runtime-extra=codex");
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
      expect(result.source).toBe("alias");
      expect(result.rawModel).toBe("gpt");
      expect(result.rawRuntime).toBeUndefined();
      expect(result.cleaned).toBe("");
    });

    it.each(["-s", "--session"])("applies alias session scope from %s", (option) => {
      const result = extractModelDirective(`/gpt ${option}`, {
        aliases: ["gpt", "sonnet", "opus"],
      });
      expect(result.hasDirective).toBe(true);
      expect(result.rawModel).toBe("gpt");
      expect(result.cleaned).toBe("");
    });

    it.each(["--runtime codex", "runtime=codex", "harness=codex"])(
      "applies runtime-only alias option %s",
      (option) => {
        const result = extractModelDirective(`/gpt ${option}`, {
          aliases: ["gpt"],
        });
        expect(result.rawModel).toBe("gpt");
        expect(result.rawRuntime).toBe("codex");
        expect(result.cleaned).toBe("");
      },
    );

    it.each(["--runtime codex -s", "-s --runtime codex"])(
      "applies runtime and session alias options from %s",
      (options) => {
        const result = extractModelDirective(`/gpt ${options}`, {
          aliases: ["gpt"],
        });
        expect(result.rawModel).toBe("gpt");
        expect(result.rawRuntime).toBe("codex");
        expect(result.cleaned).toBe("");
      },
    );

    it("recognizes alias options after an optional colon", () => {
      const result = extractModelDirective("/gpt: --session", {
        aliases: ["gpt", "sonnet", "opus"],
      });
      expect(result.hasDirective).toBe(true);
      expect(result.rawModel).toBe("gpt");
      expect(result.cleaned).toBe("");
    });

    it("preserves duplicate alias runtime and session options for validation", () => {
      const runtime = extractModelDirective("/gpt --runtime codex --runtime acp", {
        aliases: ["gpt"],
      });
      expect(runtime.rawRuntime).toBe("codex");
      expect(runtime.cleaned).toBe("--runtime acp");

      const session = extractModelDirective("/gpt -s --session", {
        aliases: ["gpt"],
      });
      expect(session.scopeConflict).toBe(true);
      expect(session.cleaned).toBe("--session");
    });

    it.each(["-slow", "--sessional"])(
      "does not treat partial alias session option %s as session-only",
      (option) => {
        const result = extractModelDirective(`/gpt ${option}`, {
          aliases: ["gpt"],
        });
        expect(result.rawModel).toBe("gpt");
        expect(result.cleaned).toBe(option);
      },
    );

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

    it("attributes a literal /model directive when alias text follows it", () => {
      const result = extractModelDirective("/model status /gpt", {
        aliases: ["gpt"],
      });
      expect(result.hasDirective).toBe(true);
      expect(result.source).toBe("model");
      expect(result.rawModel).toBe("status");
      expect(result.cleaned).toBe("/gpt");
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
      const result = extractModelDirective("/test.alias --session", {
        aliases: ["test.alias"],
      });
      expect(result.hasDirective).toBe(true);
      expect(result.rawModel).toBe("test.alias");
      expect(result.cleaned).toBe("");
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
