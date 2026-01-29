import { describe, it, expect } from "vitest";
import {
  resolvePresenceTemplate,
  resolveBotPresenceVarsSync,
  type BotPresenceVars,
} from "./bot-presence.js";
import type { MoltbotConfig } from "../../config/config.js";

describe("bot-presence", () => {
  describe("resolvePresenceTemplate", () => {
    it("replaces all template variables", () => {
      const vars: BotPresenceVars = {
        model: "Opus 4.5",
        modelFull: "anthropic/claude-opus-4-5",
        authProfile: "anthropic:work",
        provider: "anthropic",
      };

      const result = resolvePresenceTemplate("{model} • {authProfile}", vars);
      expect(result).toBe("Opus 4.5 • anthropic:work");
    });

    it("replaces modelFull and provider", () => {
      const vars: BotPresenceVars = {
        model: "Opus 4.5",
        modelFull: "anthropic/claude-opus-4-5",
        authProfile: "anthropic:work",
        provider: "anthropic",
      };

      const result = resolvePresenceTemplate("{modelFull} ({provider})", vars);
      expect(result).toBe("anthropic/claude-opus-4-5 (anthropic)");
    });

    it("handles templates with multiple occurrences", () => {
      const vars: BotPresenceVars = {
        model: "Opus 4.5",
        modelFull: "anthropic/claude-opus-4-5",
        authProfile: "anthropic:work",
        provider: "anthropic",
      };

      const result = resolvePresenceTemplate("{model} - {model}", vars);
      expect(result).toBe("Opus 4.5 - Opus 4.5");
    });

    it("preserves text without variables", () => {
      const vars: BotPresenceVars = {
        model: "Opus 4.5",
        modelFull: "anthropic/claude-opus-4-5",
        authProfile: "anthropic:work",
        provider: "anthropic",
      };

      const result = resolvePresenceTemplate("Static text", vars);
      expect(result).toBe("Static text");
    });
  });

  describe("resolveBotPresenceVarsSync", () => {
    it("resolves model from config", () => {
      const cfg: MoltbotConfig = {
        agents: {
          defaults: {
            model: {
              primary: "anthropic/claude-opus-4-5",
            },
          },
        },
        auth: {
          order: {
            anthropic: ["anthropic:work", "anthropic:personal"],
          },
        },
      };

      const vars = resolveBotPresenceVarsSync(cfg);
      expect(vars.modelFull).toBe("anthropic/claude-opus-4-5");
      expect(vars.provider).toBe("anthropic");
      expect(vars.authProfile).toBe("anthropic:work");
    });

    it("uses friendly model name for known models", () => {
      const cfg: MoltbotConfig = {
        agents: {
          defaults: {
            model: {
              primary: "anthropic/claude-opus-4-5",
            },
          },
        },
      };

      const vars = resolveBotPresenceVarsSync(cfg);
      expect(vars.model).toBe("Opus 4.5");
    });

    it("formats unknown model names", () => {
      const cfg: MoltbotConfig = {
        agents: {
          defaults: {
            model: {
              primary: "anthropic/some-new-model",
            },
          },
        },
      };

      const vars = resolveBotPresenceVarsSync(cfg);
      expect(vars.model).toBe("Some New Model");
    });

    it("finds auth profile from profiles config", () => {
      const cfg: MoltbotConfig = {
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-4o",
            },
          },
        },
        auth: {
          profiles: {
            "openai:personal": {
              provider: "openai",
              mode: "api_key",
            },
          },
        },
      };

      const vars = resolveBotPresenceVarsSync(cfg);
      expect(vars.authProfile).toBe("openai:personal");
    });

    it("falls back to provider:default when no auth config", () => {
      const cfg: MoltbotConfig = {
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-4o",
            },
          },
        },
      };

      const vars = resolveBotPresenceVarsSync(cfg);
      expect(vars.authProfile).toBe("openai:default");
    });
  });
});
