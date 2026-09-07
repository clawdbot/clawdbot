// Tests the first-class /dashboard command's bridge into the Control UI skill.
import { describe, expect, it } from "vitest";
import type { SkillCommandSpec } from "../../skills/types.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { handleDashboardCommand } from "./commands-dashboard.js";
import type { HandleCommandsParams } from "./commands-types.js";

const controlUiSkill: SkillCommandSpec = {
  name: "control-ui",
  skillName: "control-ui",
  displayName: "Control UI",
  description: "Operate the Control UI and build session dashboards.",
  skillFile: "/bundled/skills/control-ui/SKILL.md",
  skillSource: "bundled",
  modelVisible: true,
};
const workspaceControlUiSkill: SkillCommandSpec = {
  ...controlUiSkill,
  skillFile: "/workspace/skills/control-ui/SKILL.md",
  skillSource: "workspace",
};
const releaseNotesSkill: SkillCommandSpec = {
  name: "release_notes",
  skillName: "release-notes",
  description: "Summarize release notes.",
  skillFile: "/workspace/skills/release-notes/SKILL.md",
  modelVisible: true,
};

function buildParams(
  commandBodyNormalized: string,
  skills: SkillCommandSpec[] = [controlUiSkill],
): HandleCommandsParams {
  return {
    cfg: {},
    ctx: {
      Provider: INTERNAL_MESSAGE_CHANNEL,
      Surface: INTERNAL_MESSAGE_CHANNEL,
      CommandSource: "text",
      Body: commandBodyNormalized,
      RawBody: commandBodyNormalized,
      CommandBody: commandBodyNormalized,
      BodyForCommands: commandBodyNormalized,
      BodyForAgent: commandBodyNormalized,
      BodyStripped: commandBodyNormalized,
    },
    command: {
      commandBodyNormalized,
      isAuthorizedSender: true,
      senderIsOwner: true,
      senderId: "tester",
      channel: INTERNAL_MESSAGE_CHANNEL,
      channelId: INTERNAL_MESSAGE_CHANNEL,
      surface: INTERNAL_MESSAGE_CHANNEL,
      ownerList: [],
      rawBodyNormalized: commandBodyNormalized,
    },
    directives: {},
    elevated: { enabled: true, allowed: true, failures: [] },
    agentId: "main",
    sessionKey: "agent:main:webchat:test",
    workspaceDir: "/workspace",
    provider: "openai",
    model: "test-model",
    contextTokens: 0,
    defaultGroupActivation: () => "mention",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    isGroup: false,
    skillCommands: skills,
  } as unknown as HandleCommandsParams;
}

describe("dashboard command", () => {
  it("expands the Control UI skill for a bare dashboard request", async () => {
    const params = buildParams("/dashboard");

    const result = await handleDashboardCommand(params, true);
    const prompt = params.ctx.BodyForAgent ?? "";

    expect(result).toEqual({
      shouldContinue: true,
      explicitSkillSelections: [
        { name: "control-ui", path: "/bundled/skills/control-ui/SKILL.md" },
      ],
    });
    expect(prompt).toContain("Use the following explicitly referenced skills");
    expect(prompt).toContain("- control-ui");
    expect(prompt).toContain("Create a dashboard for this session.");
    expect(params.command.commandBodyNormalized).toBe(prompt);
  });

  it("preserves dashboard requirements in the skill-routed agent request", async () => {
    const params = buildParams("/dashboard release health and deploy status");

    const result = await handleDashboardCommand(params, true);

    expect(result?.shouldContinue).toBe(true);
    expect(params.ctx.BodyForAgent).toContain("release health and deploy status");
  });

  it("preserves additional explicit skills used by dashboard requirements", async () => {
    const params = buildParams("/dashboard include $release_notes", [
      controlUiSkill,
      releaseNotesSkill,
    ]);

    const result = await handleDashboardCommand(params, true);

    expect(result?.explicitSkillSelections).toEqual([
      { name: "control-ui", path: "/bundled/skills/control-ui/SKILL.md" },
      { name: "release_notes", path: "/workspace/skills/release-notes/SKILL.md" },
    ]);
    expect(params.ctx.BodyForAgent).toContain("- release-notes");
  });

  it("loads skills on demand when command discovery did not preload them", async () => {
    const params = buildParams("/dashboard", []);
    params.loadSkillCommands = async () => [controlUiSkill];

    const result = await handleDashboardCommand(params, true);

    expect(result?.explicitSkillSelections).toEqual([
      { name: "control-ui", path: "/bundled/skills/control-ui/SKILL.md" },
    ]);
    expect(params.ctx.BodyForAgent).toContain("- control-ui");
  });

  it("selects the bundled Control UI skill across a workspace name collision", async () => {
    const params = buildParams("/dashboard release health", [workspaceControlUiSkill]);
    params.loadBundledSkillCommand = async () => controlUiSkill;

    const result = await handleDashboardCommand(params, true);

    expect(result?.explicitSkillSelections).toEqual([
      { name: "control-ui", path: "/bundled/skills/control-ui/SKILL.md" },
    ]);
    expect(params.ctx.BodyForAgent).toContain("release health");
  });

  it("returns a deterministic reply when the Control UI skill is unavailable", async () => {
    const params = buildParams("/dashboard", []);

    const result = await handleDashboardCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("control-ui skill is unavailable");
    expect(params.ctx.BodyForAgent).toBe("/dashboard");
  });
});
