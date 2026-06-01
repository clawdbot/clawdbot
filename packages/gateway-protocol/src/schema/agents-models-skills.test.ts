import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  AgentsListResultSchema,
  SkillsProposalInspectResultSchema,
  ToolsEffectiveResultSchema,
} from "./agents-models-skills.js";

function toolsEffectiveResult() {
  return {
    agentId: "main",
    profile: "full",
    groups: [
      {
        id: "core",
        label: "Built-in tools",
        source: "core",
        tools: [
          {
            id: "exec",
            label: "Exec",
            description: "Run shell commands",
            rawDescription: "Run shell commands",
            source: "core",
          },
        ],
      },
    ],
  };
}

describe("AgentsListResultSchema", () => {
  it("accepts resolved per-agent thinking metadata", () => {
    const result = {
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [
        {
          id: "investment-master",
          name: "Investment Master",
          model: { primary: "deepseek/deepseek-v4-flash" },
          thinkingLevels: [
            { id: "off", label: "off" },
            { id: "xhigh", label: "xhigh" },
          ],
          thinkingOptions: ["off", "xhigh"],
          thinkingDefault: "xhigh",
        },
      ],
    };

    expect(Value.Check(AgentsListResultSchema, result)).toBe(true);
  });
});

describe("ToolsEffectiveResultSchema", () => {
  it("accepts runtime tool quarantine notices", () => {
    const result = {
      ...toolsEffectiveResult(),
      notices: [
        {
          id: "unsupported-tool-schema:fuzzplugin_move_angles",
          severity: "warning",
          message:
            'Tool "fuzzplugin_move_angles" from plugin "fuzzplugin" has an unsupported runtime input schema and was quarantined before model projection.',
        },
      ],
    };

    expect(Value.Check(ToolsEffectiveResultSchema, result)).toBe(true);
  });

  it("keeps tool quarantine notices strict", () => {
    const result = {
      ...toolsEffectiveResult(),
      notices: [
        {
          id: "unsupported-tool-schema:fuzzplugin_move_angles",
          severity: "warning",
          message: "Unsupported schema.",
          extra: true,
        },
      ],
    };

    expect(Value.Check(ToolsEffectiveResultSchema, result)).toBe(false);
  });
});

describe("SkillsProposalInspectResultSchema", () => {
  it("accepts update proposal support file target metadata", () => {
    const result = {
      record: {
        id: "proposal-1",
        kind: "update",
        status: "pending",
        title: "weather-helper",
        description: "Improve weather checks",
        schema: "openclaw.skill-workshop.proposal.v1",
        createdAt: "2026-05-30T00:00:00.000Z",
        updatedAt: "2026-05-30T00:00:00.000Z",
        createdBy: "skill-workshop",
        proposedVersion: "v1",
        draftFile: "PROPOSAL.md",
        target: {
          skillName: "weather-helper",
          skillDir: "/tmp/workspace/skills/weather-helper",
          skillFile: "/tmp/workspace/skills/weather-helper/SKILL.md",
          skillKey: "weather-helper",
          currentContentHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        },
        draftHash: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
        scan: {
          state: "clean",
          scannedAt: "2026-05-30T00:00:00.000Z",
          critical: 0,
          warn: 0,
          info: 0,
          findings: [],
        },
        supportFiles: [
          {
            path: "references/weather.md",
            sizeBytes: 42,
            hash: "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
            targetExisted: true,
            targetContentHash: "123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0",
          },
        ],
      },
      content: "# Weather Helper\n",
      supportFiles: [
        {
          path: "references/weather.md",
          content: "Use current weather before recommendations.\n",
        },
      ],
    };

    expect(Value.Check(SkillsProposalInspectResultSchema, result)).toBe(true);
  });
});
