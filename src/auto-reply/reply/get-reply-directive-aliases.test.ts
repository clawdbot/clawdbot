import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { parseInlineDirectives } from "./directive-handling.parse.js";
import {
  reserveSkillCommandNames,
  resolveConfiguredDirectiveAliases,
} from "./get-reply-directive-aliases.js";

function configWithModelAlias(alias: string): OpenClawConfig {
  return {
    agents: {
      defaults: {
        models: {
          "anthropic/claude-opus-4-6": { alias },
        },
      },
    },
  } as unknown as OpenClawConfig;
}

describe("reply directive aliases", () => {
  it("does not expose skill command names as inline model aliases", () => {
    const reservedCommands = new Set<string>();
    const cfg = configWithModelAlias("demo_skill");

    const beforeSkillRegistration = parseInlineDirectives("/demo_skill", {
      modelAliases: resolveConfiguredDirectiveAliases({
        cfg,
        commandTextHasSlash: true,
        reservedCommands,
      }),
    });
    expect(beforeSkillRegistration.hasModelDirective).toBe(true);
    expect(beforeSkillRegistration.cleaned).toBe("");

    reserveSkillCommandNames({
      reservedCommands,
      skillCommands: [
        {
          name: "demo_skill",
          skillName: "demo-skill",
          description: "Demo skill",
          sourceFilePath: "/tmp/demo/SKILL.md",
        },
      ],
    });

    const afterSkillRegistration = parseInlineDirectives("/demo_skill", {
      modelAliases: resolveConfiguredDirectiveAliases({
        cfg,
        commandTextHasSlash: true,
        reservedCommands,
      }),
    });
    expect(afterSkillRegistration.hasModelDirective).toBe(false);
    expect(afterSkillRegistration.cleaned).toBe("/demo_skill");
  });

  it("does not expose chat command names as inline model aliases", () => {
    const cfg = configWithModelAlias(" help ");
    const reservedCommands = new Set(["help"]);

    const parsed = parseInlineDirectives("/help", {
      modelAliases: resolveConfiguredDirectiveAliases({
        cfg,
        commandTextHasSlash: true,
        reservedCommands,
      }),
    });
    expect(parsed.hasModelDirective).toBe(false);
    expect(parsed.cleaned).toBe("/help");
  });
});
