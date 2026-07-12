// Gateway Protocol tests cover agents models skills behavior.
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  AgentsListResultSchema,
  ModelsListParamsSchema,
  ModelsListResultSchema,
  SkillsDetailResultSchema,
  SkillsProposalInspectResultSchema,
  SkillsProposalRequestRevisionResultSchema,
  ToolsEffectiveResultSchema,
  ToolsInvokeParamsSchema,
} from "./agents-models-skills.js";

/**
 * Schema regression tests for agent metadata, skill proposals, and effective
 * tool catalogs. These payloads are UI-facing but also consumed by runtime
 * guards, so the fixtures exercise strictness at the public gateway boundary.
 */

/** Minimal effective-tools result used by strict notice tests. */
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
          workspaceGit: true,
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

describe("ModelsListParamsSchema", () => {
  it("accepts the provider-config inventory view", () => {
    expect(Value.Check(ModelsListParamsSchema, { view: "provider-config" })).toBe(true);
    expect(Value.Check(ModelsListParamsSchema, { view: "provider-route" })).toBe(false);
  });
});

describe("ModelsListResultSchema", () => {
  it("accepts stable public input capabilities", () => {
    const model = {
      id: "gpt-image",
      name: "GPT Image",
      provider: "openai",
      input: ["text", "image", "audio", "video", "document"],
    };

    expect(Value.Check(ModelsListResultSchema, { models: [model] })).toBe(true);
    expect(
      Value.Check(ModelsListResultSchema, {
        models: [{ ...model, input: ["text", "binary"] }],
      }),
    ).toBe(false);
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

describe("ToolsInvokeParamsSchema", () => {
  it("accepts only the operation-local direct-operator marker", () => {
    expect(
      Value.Check(ToolsInvokeParamsSchema, {
        name: "message",
        conversationReadOrigin: "direct-operator",
      }),
    ).toBe(true);
    expect(
      Value.Check(ToolsInvokeParamsSchema, {
        name: "message",
        conversationReadOrigin: "delegated",
      }),
    ).toBe(false);
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

describe("SkillsProposalRequestRevisionResultSchema", () => {
  it.each(["started", "in_flight", "ok", "timeout", "error"])(
    "accepts forwarded chat.send ack status %s",
    (status) => {
      expect(
        Value.Check(SkillsProposalRequestRevisionResultSchema, {
          runId: "run-revision",
          status,
        }),
      ).toBe(true);
    },
  );

  it("rejects unknown forwarded chat.send ack statuses", () => {
    expect(
      Value.Check(SkillsProposalRequestRevisionResultSchema, {
        runId: "run-revision",
        status: "queued",
      }),
    ).toBe(false);
  });
});

describe("SkillsDetailResultSchema", () => {
  it("accepts official ClawHub skill publisher metadata", () => {
    const result = {
      skill: {
        slug: "tao-setup-nvidia-gpu-host",
        displayName: "TAO Setup NVIDIA GPU Host",
        summary: "Prepare an NVIDIA GPU host for TAO workflows.",
        tags: { gpu: "GPU" },
        channel: "official",
        isOfficial: true,
        createdAt: 1_700_000_000,
        updatedAt: 1_700_010_000,
      },
      latestVersion: {
        version: "1.0.0",
        createdAt: 1_700_010_000,
      },
      owner: {
        handle: "nvidia",
        displayName: "NVIDIA",
        image: "https://example.test/nvidia.png",
        official: true,
        channel: "official",
        isOfficial: true,
      },
    };

    expect(Value.Check(SkillsDetailResultSchema, result)).toBe(true);
  });
});
