// Gateway Protocol tests cover agents models skills behavior.
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  AgentsDeleteResultSchema,
  AgentsListResultSchema,
  AgentsUpdateParamsSchema,
  ModelsAuthLogoutParamsSchema,
  ModelsAuthStatusParamsSchema,
  ModelsListParamsSchema,
  ModelsListResultSchema,
  ModelsProbeParamsSchema,
  ModelsProbeResultSchema,
  SkillProposalEvaluationSchema,
  SkillProposalLifecycleEventSchema,
  SkillsDetailResultSchema,
  SkillsProposalEvaluateParamsSchema,
  SkillsProposalEvaluateResultSchema,
  SkillsProposalEventsListParamsSchema,
  SkillsProposalEventsListResultSchema,
  SkillsProposalInspectResultSchema,
  SkillsProposalRequestRevisionResultSchema,
  ToolsEffectiveResultSchema,
  ToolsInvokeParamsSchema,
} from "./agents-models-skills.js";

type ProtocolSchema = TSchema;

function expectSchemaCases(schema: ProtocolSchema, expected: boolean, values: readonly unknown[]) {
  for (const value of values) {
    expect(Value.Check(schema, value)).toBe(expected);
  }
}

const expectAccepted = (schema: ProtocolSchema, ...values: readonly unknown[]) =>
  expectSchemaCases(schema, true, values);
const expectRejected = (schema: ProtocolSchema, ...values: readonly unknown[]) =>
  expectSchemaCases(schema, false, values);

const cleanProposalScan = {
  state: "clean",
  scannedAt: "2026-05-30T00:00:00.000Z",
  critical: 0,
  warn: 0,
  info: 0,
  findings: [],
};

const proposalTarget = (overrides: Record<string, unknown> = {}) => ({
  skillName: "weather-helper",
  skillDir: "/tmp/workspace/skills/weather-helper",
  skillFile: "/tmp/workspace/skills/weather-helper/SKILL.md",
  skillKey: "weather-helper",
  ...overrides,
});

const proposalRecord = (overrides: Record<string, unknown> = {}) => ({
  id: "proposal-1",
  kind: "create",
  status: "pending",
  title: "weather-helper",
  description: "Improve weather checks",
  schema: "openclaw.skill-workshop.proposal.v1",
  createdAt: "2026-05-30T00:00:00.000Z",
  updatedAt: "2026-05-30T00:00:00.000Z",
  createdBy: "gateway",
  proposedVersion: "v2",
  draftFile: "PROPOSAL.md",
  draftHash: "b".repeat(64),
  target: proposalTarget(),
  scan: cleanProposalScan,
  ...overrides,
});

const proposalEvaluation = (overrides: Record<string, unknown> = {}) => ({
  id: "evaluation-1",
  proposedVersion: "v2",
  revisionHash: "b".repeat(64),
  trigger: "apply",
  startedAt: "2026-05-30T00:01:00.000Z",
  completedAt: "2026-05-30T00:01:01.000Z",
  outcomes: [],
  ...overrides,
});

describe("AgentsDeleteResultSchema", () => {
  it("accepts per-path cleanup outcomes", () => {
    expectAccepted(AgentsDeleteResultSchema, {
      ok: true,
      agentId: "ops",
      removedBindings: 1,
      removed: [{ path: "/state/agents/ops/agent", method: "trash" }],
      failed: [{ path: "/state/workspace-ops", reason: "trash unavailable" }],
    });
  });
});

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
          kind: "agent",
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

    expectAccepted(AgentsListResultSchema, result);
  });

  it("accepts system and legacy omitted kinds but rejects unknown kinds", () => {
    const result = {
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "main" }, { id: "custodian", kind: "system" }],
    };

    expectAccepted(AgentsListResultSchema, result);
    expectRejected(AgentsListResultSchema, {
      ...result,
      agents: [{ id: "custodian", kind: "worker" }],
    });
  });
});

describe("AgentsUpdateParamsSchema", () => {
  it("distinguishes omitted, cleared, and invalid model values", () => {
    expectAccepted(AgentsUpdateParamsSchema, { agentId: "work" }, { agentId: "work", model: null });
    expectRejected(AgentsUpdateParamsSchema, { agentId: "work", model: "" });
  });
});

describe("ModelsListParamsSchema", () => {
  it("accepts the provider-config inventory view", () => {
    expectAccepted(
      ModelsListParamsSchema,
      { view: "provider-config" },
      {
        view: "all",
        includeProviderCapabilities: true,
      },
    );
    expectRejected(ModelsListParamsSchema, { view: "provider-route" });
  });
});

describe("Models auth params schemas", () => {
  it("accepts optional agent-scoped status and logout requests", () => {
    expectAccepted(
      ModelsAuthStatusParamsSchema,
      {},
      { refresh: true, agentId: "writer" },
      { agentId: "" },
    );
    expectAccepted(
      ModelsAuthLogoutParamsSchema,
      {
        provider: "openai",
        profileIds: ["openai:writer"],
        agentId: "writer",
      },
      { provider: "openai" },
      { provider: "openai", agentId: "" },
    );
    expectRejected(ModelsAuthLogoutParamsSchema, { provider: "openai", profileIds: [] });
  });
});

describe("ModelsListResultSchema", () => {
  it("accepts stable public input capabilities", () => {
    const model = {
      id: "gpt-image",
      name: "GPT Image",
      provider: "openai",
      agentRuntime: { id: "codex", fallback: "openclaw", source: "model" },
      input: ["text", "image", "audio", "video", "document"],
    };

    expectAccepted(ModelsListResultSchema, { models: [model] });
    expectRejected(
      ModelsListResultSchema,
      {
        models: [{ ...model, agentRuntime: { id: "codex", source: "unknown" } }],
      },
      { models: [{ ...model, input: ["text", "binary"] }] },
    );
  });
});

describe("ModelsProbe schemas", () => {
  it("accepts bounded request and secret-free result shapes", () => {
    expectAccepted(
      ModelsProbeParamsSchema,
      {
        provider: "openai",
        profileId: "work",
        timeoutMs: 20_000,
        agentId: "writer",
      },
      { provider: "openai", agentId: "" },
    );
    expectAccepted(ModelsProbeResultSchema, {
      provider: "openai",
      status: "ok",
      latencyMs: 125,
      results: [{ profileId: "work", label: "Work", status: "ok", latencyMs: 125 }],
    });
  });
});

describe("ToolsEffectiveResultSchema", () => {
  it("accepts MCP identity and a true session-denial marker", () => {
    const result = {
      ...toolsEffectiveResult(),
      groups: [
        ...toolsEffectiveResult().groups,
        {
          id: "mcp",
          label: "MCP server tools",
          source: "mcp",
          tools: [
            {
              id: "notion__delete-page",
              label: "Delete page",
              description: "Delete a page",
              rawDescription: "Delete a page",
              source: "mcp",
              mcpServer: "notion",
              mcpToolName: "delete_page",
              deniedBySession: true,
            },
          ],
        },
      ],
    };

    expectAccepted(ToolsEffectiveResultSchema, result);
    expectRejected(ToolsEffectiveResultSchema, {
      ...result,
      groups: [
        ...result.groups.slice(0, -1),
        {
          ...result.groups.at(-1),
          tools: [{ ...result.groups.at(-1)?.tools[0], deniedBySession: false }],
        },
      ],
    });
  });

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

    expectAccepted(ToolsEffectiveResultSchema, result);
  });

  it("accepts server-scoped inventory notices", () => {
    const result = {
      ...toolsEffectiveResult(),
      notices: [
        {
          id: "mcp-not-yet-connected",
          severity: "info",
          message: "MCP tools are not available yet.",
          servers: ["github", "notion"],
        },
      ],
    };

    expectAccepted(ToolsEffectiveResultSchema, result);
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

    expectRejected(ToolsEffectiveResultSchema, result);
  });
});

describe("ToolsInvokeParamsSchema", () => {
  it("accepts only the operation-local direct-operator marker", () => {
    expectAccepted(ToolsInvokeParamsSchema, {
      name: "message",
      conversationReadOrigin: "direct-operator",
    });
    expectRejected(ToolsInvokeParamsSchema, {
      name: "message",
      conversationReadOrigin: "delegated",
    });
  });
});

describe("SkillsProposalInspectResultSchema", () => {
  it("accepts support metadata and the latest bounded evaluation", () => {
    const result = {
      record: proposalRecord({
        kind: "update",
        createdBy: "skill-workshop",
        proposedVersion: "v1",
        target: proposalTarget({
          currentContentHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        }),
        draftHash: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
        evaluation: proposalEvaluation({
          proposedVersion: "v1",
          revisionHash: "a".repeat(64),
          trigger: "manual",
          correlationId: "correlation-1",
          outcomes: [
            {
              pluginId: "quality-plugin",
              pluginVersion: "1.2.3",
              evaluatorId: "quality",
              status: "completed",
              result: {
                summary: "Ready to apply.",
                findings: [],
                metrics: { score: 0.98, deterministic: true, profile: "strict" },
                evaluatorVersion: "rules-v2",
                mode: "static",
                decision: "pass",
                decisionReason: "No blocking findings.",
              },
            },
          ],
        }),
        supportFiles: [
          {
            path: "references/weather.md",
            sizeBytes: 42,
            hash: "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
            targetExisted: true,
            targetContentHash: "123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0",
          },
        ],
      }),
      revisionHash: "a".repeat(64),
      content: "# Weather Helper\n",
      supportFiles: [
        {
          path: "references/weather.md",
          content: "Use current weather before recommendations.\n",
        },
      ],
    };

    expectAccepted(SkillsProposalInspectResultSchema, result, {
      record: result.record,
      content: result.content,
    });
  });
});

describe("SkillProposalEvaluationSchema", () => {
  const completedOutcome = {
    pluginId: "quality-plugin",
    evaluatorId: "quality",
    status: "completed",
    result: {
      findings: [
        {
          ruleId: "skill.structure",
          severity: "warn",
          message: "Add a troubleshooting section.",
          file: "SKILL.md",
          line: 12,
        },
      ],
      decision: "revise",
    },
  };
  const evaluation = proposalEvaluation({
    targetTreeSha256: "c".repeat(64),
    outcomes: [completedOutcome],
  });

  it("accepts bounded evaluator outcomes", () => {
    expectAccepted(SkillProposalEvaluationSchema, evaluation);
  });

  it("accepts the service result wrapper", () => {
    const record = proposalRecord({
      evaluation,
    });

    expectAccepted(SkillsProposalEvaluateResultSchema, { record, evaluation });
  });

  it("rejects non-primitive metrics and unknown decisions", () => {
    expectRejected(SkillProposalEvaluationSchema, {
      ...evaluation,
      outcomes: [
        {
          ...completedOutcome,
          result: {
            findings: [],
            metrics: { nested: { score: 1 } },
            decision: "approve",
          },
        },
      ],
    });
  });

  it.each(["", "x".repeat(129)])("rejects invalid metric key %j", (key) => {
    expectRejected(SkillProposalEvaluationSchema, {
      ...evaluation,
      outcomes: [
        {
          ...completedOutcome,
          result: { findings: [], metrics: { [key]: true } },
        },
      ],
    });
  });

  it("enforces status-specific result and error fields", () => {
    expectRejected(
      SkillProposalEvaluationSchema,
      {
        ...evaluation,
        outcomes: [{ pluginId: "quality-plugin", evaluatorId: "quality", status: "completed" }],
      },
      {
        ...evaluation,
        outcomes: [{ pluginId: "quality-plugin", evaluatorId: "quality", status: "error" }],
      },
    );
  });
});

describe("skill proposal evaluation and event replay params", () => {
  it("validates optimistic evaluation and bounded event cursors", () => {
    expectAccepted(SkillsProposalEvaluateParamsSchema, {
      agentId: "main",
      proposalId: "proposal-1",
      expectedRevisionHash: "c".repeat(64),
      correlationId: "correlation-1",
    });
    expectAccepted(SkillsProposalEventsListParamsSchema, {
      proposalId: "proposal-1",
      afterSequence: 10,
      limit: 200,
    });
    expectRejected(SkillsProposalEventsListParamsSchema, { limit: 201 });
  });

  it("accepts sequence-ordered lifecycle replay pages", () => {
    const event = {
      sequence: 11,
      eventId: "event-11",
      proposalId: "proposal-1",
      proposedVersion: "v2",
      revisionHash: "d".repeat(64),
      type: "evaluation_completed",
      occurredAt: "2026-05-30T00:01:01.000Z",
      actor: { type: "plugin", id: "quality-plugin" },
      correlationId: "correlation-1",
      payload: { trigger: "manual", outcomeCount: 1, blocking: false, note: null },
      evaluation: proposalEvaluation({
        id: "evaluation-11",
        revisionHash: "d".repeat(64),
        trigger: "manual",
      }),
    };

    expectAccepted(SkillProposalLifecycleEventSchema, event);
    expectAccepted(SkillsProposalEventsListResultSchema, {
      events: [event],
      nextSequence: 11,
    });
    expectRejected(
      SkillProposalLifecycleEventSchema,
      {
        ...event,
        actor: { type: "operator" },
      },
      {
        ...event,
        payload: { note: "x".repeat(4_001) },
      },
    );
    for (const key of ["", "x".repeat(81)]) {
      expectRejected(SkillProposalLifecycleEventSchema, {
        ...event,
        payload: { [key]: true },
      });
    }
  });
});

describe("SkillsProposalRequestRevisionResultSchema", () => {
  it.each(["started", "in_flight", "ok", "timeout", "error"])(
    "accepts forwarded chat.send ack status %s",
    (status) => {
      expectAccepted(SkillsProposalRequestRevisionResultSchema, {
        runId: "run-revision",
        status,
      });
    },
  );

  it("rejects unknown forwarded chat.send ack statuses", () => {
    expectRejected(SkillsProposalRequestRevisionResultSchema, {
      runId: "run-revision",
      status: "queued",
    });
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

    expectAccepted(SkillsDetailResultSchema, result);
  });
});
