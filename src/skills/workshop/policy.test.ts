import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfig,
  setRuntimeConfigSnapshot,
} from "../../config/config.js";
import { PLUGIN_APPROVAL_DESCRIPTION_MAX_LENGTH } from "../../infra/plugin-approvals.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { resolveSkillWorkshopToolApproval } from "./policy.js";
import { proposeCreateSkill } from "./service.js";

const tempDirs = createTrackedTempDirs();
let testState: OpenClawTestState;

beforeEach(async () => {
  testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-skill-workshop-policy-",
  });
});

afterEach(async () => {
  clearRuntimeConfigSnapshot();
  await testState.cleanup();
  await tempDirs.cleanup();
});

describe("resolveSkillWorkshopToolApproval", () => {
  it("describes the target proposal and bounds the approval wait", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-workshop-policy-workspace-");
    const description = "d".repeat(160);
    const proposal = await proposeCreateSkill({
      workspaceDir,
      name: "Weather Helper",
      description,
      content: "# Weather Helper\n\nUse the weather provider before answering.\n",
      supportFiles: [
        { path: "references/provider.md", content: "# Provider\n" },
        { path: "scripts/check.js", content: "export const check = true;\n" },
      ],
    });

    const result = await resolveSkillWorkshopToolApproval({
      toolName: "skill_workshop",
      toolParams: { action: "apply", proposal_id: proposal.record.id },
      workspaceDir,
    });

    expect(result?.requireApproval).toMatchObject({
      title: "Apply workspace skill proposal",
      severity: "warning",
      timeoutMs: 70_000,
      allowedDecisions: ["allow-once", "deny"],
    });
    expect(result?.requireApproval?.description).toContain(`Proposal ID: ${proposal.record.id}`);
    expect(result?.requireApproval?.description).toContain("Target skill: Weather Helper");
    expect(result?.requireApproval?.description).toContain(`Description: ${description}`);
    expect(result?.requireApproval?.description).toContain("Support files: 2");
    expect(result?.requireApproval?.description).toContain(
      `Body size: ${(Buffer.byteLength(proposal.content, "utf8") / 1024).toFixed(1)} KB`,
    );
    expect(result?.requireApproval?.timeoutReason).toContain(
      `left Proposal ${proposal.record.id} unchanged and pending`,
    );
    const resolvedByName = await resolveSkillWorkshopToolApproval({
      toolName: "skill_workshop",
      toolParams: { action: "reject", name: "weather-helper" },
      workspaceDir,
    });
    expect(resolvedByName?.requireApproval?.description).toContain(
      `Proposal ID: ${proposal.record.id}`,
    );
  });

  it("bounds approval metadata without splitting UTF-16 surrogates", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-workshop-policy-long-name-");
    const description = "d".repeat(160);
    const content = "# Long name\n";
    const proposalIdLength = 60 + 1 + 8 + 1 + 10;
    const fixedLines = [
      `Proposal ID: ${"p".repeat(proposalIdLength)}`,
      `Description: ${description}`,
      "Support files: 0",
      `Body size: ${(Buffer.byteLength(content, "utf8") / 1024).toFixed(1)} KB`,
    ];
    const skillPrefix = "Target skill: ";
    const fixedLength = fixedLines.join("\n").length + skillPrefix.length + fixedLines.length;
    const availableSkillNameLength = Math.max(
      1,
      PLUGIN_APPROVAL_DESCRIPTION_MAX_LENGTH - fixedLength,
    );
    const prefix = "n".repeat(availableSkillNameLength - 2);
    const proposal = await proposeCreateSkill({
      workspaceDir,
      name: `${prefix}\u{1F600}tail`,
      description,
      content,
    });

    const result = await resolveSkillWorkshopToolApproval({
      toolName: "skill_workshop",
      toolParams: { action: "apply", proposal_id: proposal.record.id },
      workspaceDir,
    });
    const approvalDescription = result?.requireApproval?.description ?? "";

    expect(approvalDescription.length).toBeLessThanOrEqual(PLUGIN_APPROVAL_DESCRIPTION_MAX_LENGTH);
    expect(approvalDescription).toContain(`Proposal ID: ${proposal.record.id}`);
    expect(approvalDescription).toContain(`Description: ${description}`);
    expect(approvalDescription).toContain("Support files: 0");
    expect(approvalDescription).toContain(
      `Body size: ${(Buffer.byteLength(proposal.content, "utf8") / 1024).toFixed(1)} KB`,
    );
    const targetLine = result?.requireApproval?.description.split("\n")[1] ?? "";

    expect(targetLine).toBe(`Target skill: ${prefix}…`);
    expect(approvalDescription).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    );
  });

  it("renders proposal-controlled fields without approval-line injection", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-workshop-policy-controls-");
    const proposal = await proposeCreateSkill({
      workspaceDir,
      name: "Line\nBreak\u202eSpoof",
      description:
        "Real description\nSupport files: 999\tBody size: 999 KB\u2028Target skill: fake\u2066",
      content: "# Controls\n",
    });

    const result = await resolveSkillWorkshopToolApproval({
      toolName: "skill_workshop",
      toolParams: { action: "apply", proposal_id: proposal.record.id },
      workspaceDir,
    });
    const lines = result?.requireApproval?.description.split("\n") ?? [];

    expect(lines).toHaveLength(5);
    expect(lines[1]).toContain("Target skill: Line↵Break�Spoof");
    expect(lines[2]).toBe(
      "Description: Real description↵Support files: 999�Body size: 999 KB↵Target skill: fake�",
    );
    for (const line of lines) {
      expect(line).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    }
    expect(lines[3]).toBe("Support files: 0");
  });

  it("falls back to the action description when the proposal cannot be resolved", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-workshop-policy-missing-");

    const result = await resolveSkillWorkshopToolApproval({
      toolName: "skill_workshop",
      toolParams: { action: "apply", proposal_id: "missing-20260705-0000000000" },
      workspaceDir,
    });

    expect(result?.requireApproval?.description).toBe(
      "Apply a pending workspace skill proposal into live workspace skills.",
    );
    expect(result?.requireApproval?.timeoutMs).toBe(70_000);

    const withoutWorkspace = await resolveSkillWorkshopToolApproval({
      toolName: "skill_workshop",
      toolParams: { action: "apply", proposal_id: "any-proposal" },
    });
    expect(withoutWorkspace?.requireApproval?.description).toBe(
      "Apply a pending workspace skill proposal into live workspace skills.",
    );
  });

  it("uses runtime config when lifecycle hook config is absent", async () => {
    setRuntimeConfigSnapshot({
      skills: {
        workshop: {
          approvalPolicy: "auto",
        },
      },
    });

    await expect(
      resolveSkillWorkshopToolApproval({
        toolName: "skill_workshop",
        toolParams: { action: "apply", proposal_id: "weather-20260530-a1b2c3d4e5" },
      }),
    ).resolves.toBeUndefined();
  });

  it("keeps approval pending when runtime config loading throws", async () => {
    const sharedAgentDir = testState.agentDir("shared");
    await testState.writeConfig({
      agents: {
        list: [
          { id: "alpha", agentDir: sharedAgentDir },
          { id: "beta", agentDir: sharedAgentDir },
        ],
      },
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      expect(() => getRuntimeConfig()).toThrow(/duplicate agentDir/i);
      const result = await resolveSkillWorkshopToolApproval({
        toolName: "skill_workshop",
        toolParams: { action: "quarantine", proposal_id: "weather-20260530-a1b2c3d4e5" },
      });

      expect(result?.requireApproval?.title).toBe("Quarantine workspace skill proposal");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("keeps explicit lifecycle hook config ahead of runtime config", async () => {
    setRuntimeConfigSnapshot({
      skills: {
        workshop: {
          approvalPolicy: "auto",
        },
      },
    });

    const result = await resolveSkillWorkshopToolApproval({
      toolName: "skill_workshop",
      toolParams: { action: "reject", proposal_id: "weather-20260530-a1b2c3d4e5" },
      config: {
        skills: {
          workshop: {
            approvalPolicy: "pending",
          },
        },
      },
    });

    expect(result?.requireApproval?.title).toBe("Reject workspace skill proposal");
  });
});
