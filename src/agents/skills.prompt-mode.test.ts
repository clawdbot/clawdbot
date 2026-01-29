import { describe, expect, it } from "vitest";
import { buildWorkspaceSkillsPrompt } from "./skills/workspace.js";
import type { MoltbotConfig } from "../config/config.js";

describe("skills promptMode", () => {
  const workspaceDir = "/tmp/test-workspace";

  it("uses full mode by default", () => {
    const prompt = buildWorkspaceSkillsPrompt(workspaceDir, {
      entries: [],
    });
    // Empty entries should return empty prompt
    expect(prompt).toBe("");
  });

  it("uses compact mode when configured", () => {
    const config: Partial<MoltbotConfig> = {
      skills: {
        promptMode: "compact",
      },
    };
    const prompt = buildWorkspaceSkillsPrompt(workspaceDir, {
      config: config as MoltbotConfig,
      entries: [],
    });
    expect(prompt).toBe("");
  });

  it("uses lazy mode when configured", () => {
    const config: Partial<MoltbotConfig> = {
      skills: {
        promptMode: "lazy",
      },
    };
    const prompt = buildWorkspaceSkillsPrompt(workspaceDir, {
      config: config as MoltbotConfig,
      entries: [],
    });
    expect(prompt).toBe("");
  });
});
