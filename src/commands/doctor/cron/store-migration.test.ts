// Cron store migration tests cover doctor migration of persisted cron stores.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { resolveAgentHarnessPolicy } from "../../../agents/harness/policy.js";
import { legacyCodexProviderIdentityKey } from "../shared/codex-route-model-ref.js";
import {
  planCronCodexRefRewriteAgainstPersistedConfig,
  repairCronCodexRuntimePolicies,
} from "./runtime-policy-migration.js";
import {
  collectStoredCronCodexRuntimePolicyTargets,
  cronCodexRuntimePolicyTargetKey,
  normalizeStoredCronJobs,
} from "./store-migration.js";

const DEFAULT_TOP_OF_HOUR_STAGGER_MS = 5 * 60 * 1000;

function makeLegacyJob(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "job-legacy",
    agentId: undefined,
    name: "Legacy job",
    description: null,
    enabled: true,
    deleteAfterRun: false,
    createdAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_000_000,
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: {
      kind: "systemEvent",
      text: "tick",
    },
    state: {},
    ...overrides,
  };
}

function normalizeOneJob(
  job: Record<string, unknown>,
  options: Parameters<typeof normalizeStoredCronJobs>[1] = {},
) {
  const jobs = [job];
  const result = normalizeStoredCronJobs(jobs, options);
  return { job: jobs[0], result };
}

describe("normalizeStoredCronJobs", () => {
  it("normalizes legacy cron fields and reports migration issues", () => {
    const jobs = [
      {
        jobId: "legacy-job",
        schedule: { kind: "cron", cron: "*/5 * * * *", tz: "UTC" },
        message: "say hi",
        model: "openai/gpt-5.5",
        deliver: true,
        provider: " TeLeGrAm ",
        to: "12345",
        threadId: " 77 ",
      },
    ] as Array<Record<string, unknown>>;

    const result = normalizeStoredCronJobs(jobs);

    expect(result.mutated).toBe(true);
    expect(result.issues.jobId).toBe(1);
    expect(result.issues.legacyScheduleCron).toBe(1);
    expect(result.issues.legacyTopLevelPayloadFields).toBe(1);
    expect(result.issues.legacyTopLevelDeliveryFields).toBe(1);

    const [job] = jobs;
    expect(job?.jobId).toBeUndefined();
    expect(job?.id).toBe("legacy-job");
    const schedule = job?.schedule as Record<string, unknown> | undefined;
    expect(schedule?.kind).toBe("cron");
    expect(schedule?.expr).toBe("*/5 * * * *");
    expect(schedule?.tz).toBe("UTC");
    expect(job?.message).toBeUndefined();
    expect(job?.provider).toBeUndefined();
    const delivery = job?.delivery as Record<string, unknown> | undefined;
    expect(delivery?.mode).toBe("announce");
    expect(delivery?.channel).toBe("telegram");
    expect(delivery?.to).toBe("12345");
    expect(delivery?.threadId).toBe("77");
    const payload = job?.payload as Record<string, unknown> | undefined;
    expect(payload?.kind).toBe("agentTurn");
    expect(payload?.message).toBe("say hi");
    expect(payload?.model).toBe("openai/gpt-5.5");
  });

  it("normalizes payload provider alias into channel", () => {
    const jobs = [
      {
        id: "legacy-provider",
        schedule: { kind: "every", everyMs: 60_000 },
        payload: {
          kind: "agentTurn",
          message: "ping",
          provider: " Slack ",
        },
      },
    ] as Array<Record<string, unknown>>;

    const result = normalizeStoredCronJobs(jobs);

    expect(result.mutated).toBe(true);
    expect(result.issues.legacyPayloadProvider).toBe(1);
    const payload = jobs[0]?.payload as Record<string, unknown> | undefined;
    expect(payload?.kind).toBe("agentTurn");
    expect(payload?.message).toBe("ping");
    expect(payload?.provider).toBeUndefined();
    const delivery = jobs[0]?.delivery as Record<string, unknown> | undefined;
    expect(delivery?.mode).toBe("announce");
    expect(delivery?.channel).toBe("slack");
  });

  it("rewrites legacy OpenAI Codex model refs in cron payloads", () => {
    const { job, result } = normalizeOneJob(
      makeLegacyJob({
        id: "legacy-codex-cron-model",
        schedule: { kind: "every", everyMs: 60_000 },
        payload: {
          kind: "agentTurn",
          message: "ping",
          model: " openai-codex/gpt-5.5 ",
          fallbacks: ["anthropic/claude-opus-4.6", "openai-codex/gpt-5.4-mini"],
        },
      }),
      { migrateCodexModelRefs: true },
    );

    expect(result.mutated).toBe(true);
    expect(result.issues.legacyPayloadCodexModel).toBe(1);
    const payload = expectDefined(job, "job test invariant").payload as Record<string, unknown>;
    expect(payload.kind).toBe("agentTurn");
    expect(payload.message).toBe("ping");
    expect(payload.model).toBe("openai/gpt-5.5");
    expect(payload.fallbacks).toEqual(["anthropic/claude-opus-4.6", "openai/gpt-5.4-mini"]);
  });

  it("rewrites shipped codex model refs in cron payloads", () => {
    const { job, result } = normalizeOneJob(
      makeLegacyJob({
        id: "shipped-codex-cron-model",
        schedule: { kind: "every", everyMs: 60_000 },
        payload: {
          kind: "agentTurn",
          message: "ping",
          model: "codex/gpt-5.6-sol",
          fallbacks: ["codex/gpt-5.4-mini"],
        },
      }),
      { migrateCodexModelRefs: true },
    );

    expect(result.mutated).toBe(true);
    expect(result.issues.legacyPayloadCodexModel).toBe(1);
    const payload = expectDefined(job, "job test invariant").payload as Record<string, unknown>;
    expect(payload.model).toBe("openai/gpt-5.6-sol");
    expect(payload.fallbacks).toEqual(["openai/gpt-5.4-mini"]);
    const runtimeRepair = repairCronCodexRuntimePolicies({
      cfg: { agents: { entries: { main: { default: true } } } },
      targets: result.codexRuntimePolicyTargets,
    });
    expect(runtimeRepair.warnings).toStrictEqual([]);
    expect(runtimeRepair.config.agents?.defaults?.models).toMatchObject({
      "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } },
      "openai/gpt-5.4-mini": { agentRuntime: { id: "codex" } },
    });
    expect(
      resolveAgentHarnessPolicy({
        provider: "openai",
        modelId: "gpt-5.6-sol",
        config: runtimeRepair.config,
      }).runtime,
    ).toBe("codex");
  });

  it("keeps the whole provider-conflicted cron namespace legacy", () => {
    const jobs = [
      makeLegacyJob({
        id: "provider-conflicted-codex-model",
        schedule: { kind: "every", everyMs: 60_000 },
        payload: {
          kind: "agentTurn",
          message: "ping",
          model: "codex/gpt-5.6-sol",
          fallbacks: ["codex/gpt-5.3-mini"],
        },
      }),
    ];
    const blockedNamespace = expectDefined(
      legacyCodexProviderIdentityKey("codex"),
      "blocked cron namespace test invariant",
    );
    const policyPlan = repairCronCodexRuntimePolicies({
      cfg: {},
      targets: collectStoredCronCodexRuntimePolicyTargets(jobs),
      blockedModelIdentities: new Set([blockedNamespace]),
    });
    const blockedTargets = new Set(policyPlan.blockedTargets.map(cronCodexRuntimePolicyTargetKey));

    normalizeStoredCronJobs(jobs, {
      migrateCodexModelRefs: true,
      shouldMigrateCodexRuntimePolicyTarget: (target) =>
        !blockedTargets.has(cronCodexRuntimePolicyTargetKey(target)),
    });

    const payload = expectDefined(jobs[0], "job test invariant").payload as Record<string, unknown>;
    expect(payload.model).toBe("codex/gpt-5.6-sol");
    expect(payload.fallbacks).toEqual(["codex/gpt-5.3-mini"]);
    expect(policyPlan.config.agents?.defaults?.models).toBeUndefined();
  });

  it("retains a legacy cron ref when canonical runtime policy conflicts", () => {
    const jobs = [
      makeLegacyJob({
        id: "blocked-codex-cron-model",
        schedule: { kind: "every", everyMs: 60_000 },
        payload: {
          kind: "agentTurn",
          message: "ping",
          model: "codex/gpt-5.6-sol",
        },
      }),
    ];
    const policyPlan = repairCronCodexRuntimePolicies({
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.6-sol": { agentRuntime: { id: "openclaw" } },
            },
          },
          entries: { main: { default: true } },
        },
      },
      targets: collectStoredCronCodexRuntimePolicyTargets(jobs),
    });
    const blocked = new Set(policyPlan.blockedTargets.map(cronCodexRuntimePolicyTargetKey));

    const result = normalizeStoredCronJobs(jobs, {
      migrateCodexModelRefs: true,
      shouldMigrateCodexRuntimePolicyTarget: (target) =>
        !blocked.has(cronCodexRuntimePolicyTargetKey(target)),
    });

    expect(policyPlan.warnings.join("\n")).toContain("conflicts with migrated cron Codex runtime");
    expect(result.issues.legacyPayloadCodexModel).toBe(1);
    expect(result.codexRuntimePolicyTargets).toStrictEqual([]);
    const job = expectDefined(jobs[0], "job test invariant");
    expect((job.payload as Record<string, unknown>).model).toBe("codex/gpt-5.6-sol");
  });

  it("retains a default-agent cron ref when its list-entry runtime conflicts", () => {
    const jobs = [
      makeLegacyJob({
        id: "default-agent-shadowed-codex-model",
        schedule: { kind: "every", everyMs: 60_000 },
        payload: {
          kind: "agentTurn",
          message: "ping",
          model: "codex/gpt-5.6-sol",
        },
      }),
    ];
    const rewritePlan = planCronCodexRefRewriteAgainstPersistedConfig({
      cfg: {
        agents: {
          list: [
            {
              id: "primary",
              default: true,
              models: {
                "openai/gpt-5.6-sol": { agentRuntime: { id: "openclaw" } },
              },
            },
          ],
        },
      },
      targets: collectStoredCronCodexRuntimePolicyTargets(jobs),
    });
    const blocked = new Set(rewritePlan.blockedTargets.map(cronCodexRuntimePolicyTargetKey));

    normalizeStoredCronJobs(jobs, {
      migrateCodexModelRefs: true,
      shouldMigrateCodexRuntimePolicyTarget: (target) =>
        !blocked.has(cronCodexRuntimePolicyTargetKey(target)),
    });

    expect(rewritePlan.warnings.join("\n")).toContain(
      'Retained agents.list.primary.models.openai/gpt-5.6-sol.agentRuntime.id="openclaw"',
    );
    const job = expectDefined(jobs[0], "job test invariant");
    expect((job.payload as Record<string, unknown>).model).toBe("codex/gpt-5.6-sol");
  });

  it("blocks every stored identity that resolves to one conflicted policy owner", () => {
    // agentId omitted and the default agent named explicitly are distinct
    // stored identities resolving to the same owner; both must stay legacy.
    const jobs = [
      makeLegacyJob({
        id: "implicit-default-agent",
        schedule: { kind: "every", everyMs: 60_000 },
        payload: { kind: "agentTurn", message: "ping", model: "codex/gpt-5.6-sol" },
      }),
      makeLegacyJob({
        id: "explicit-default-agent",
        schedule: { kind: "every", everyMs: 60_000 },
        payload: {
          kind: "agentTurn",
          message: "ping",
          model: "codex/gpt-5.6-sol",
          agentId: "primary",
        },
      }),
    ];
    const rewritePlan = planCronCodexRefRewriteAgainstPersistedConfig({
      cfg: {
        agents: {
          list: [
            {
              id: "primary",
              default: true,
              models: {
                "openai/gpt-5.6-sol": { agentRuntime: { id: "openclaw" } },
              },
            },
          ],
        },
      },
      targets: collectStoredCronCodexRuntimePolicyTargets(jobs),
    });
    const blocked = new Set(rewritePlan.blockedTargets.map(cronCodexRuntimePolicyTargetKey));

    normalizeStoredCronJobs(jobs, {
      migrateCodexModelRefs: true,
      shouldMigrateCodexRuntimePolicyTarget: (target) =>
        !blocked.has(cronCodexRuntimePolicyTargetKey(target)),
    });

    for (const job of jobs) {
      expect(
        (expectDefined(job, "job test invariant").payload as Record<string, unknown>).model,
      ).toBe("codex/gpt-5.6-sol");
    }
  });

  it("writes a named default agent policy to its list entry before rewriting cron", () => {
    const jobs = [
      makeLegacyJob({
        id: "default-agent-list-codex-model",
        agentId: "primary",
        schedule: { kind: "every", everyMs: 60_000 },
        payload: {
          kind: "agentTurn",
          message: "ping",
          model: "codex/gpt-5.6-sol",
        },
      }),
    ];
    const targets = collectStoredCronCodexRuntimePolicyTargets(jobs);
    const policyRepair = repairCronCodexRuntimePolicies({
      cfg: {
        agents: {
          list: [{ id: "primary", default: true }],
        },
      },
      targets,
    });

    expect(policyRepair.config.agents?.list?.[0]?.models).toMatchObject({
      "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } },
    });
    expect(policyRepair.config.agents?.defaults?.models).toBeUndefined();
    const rewritePlan = planCronCodexRefRewriteAgainstPersistedConfig({
      cfg: policyRepair.config,
      targets,
    });
    expect(rewritePlan).toStrictEqual({ warnings: [], blockedTargets: [] });
    const blocked = new Set(rewritePlan.blockedTargets.map(cronCodexRuntimePolicyTargetKey));

    normalizeStoredCronJobs(jobs, {
      migrateCodexModelRefs: true,
      shouldMigrateCodexRuntimePolicyTarget: (target) =>
        !blocked.has(cronCodexRuntimePolicyTargetKey(target)),
    });
    const job = expectDefined(jobs[0], "job test invariant");
    expect((job.payload as Record<string, unknown>).model).toBe("openai/gpt-5.6-sol");
  });

  it("writes the configured default agent policy to its canonical keyed entry", () => {
    const jobs = [
      makeLegacyJob({
        id: "implicit-default-codex-model",
        schedule: { kind: "every", everyMs: 60_000 },
        payload: {
          kind: "agentTurn",
          message: "ping",
          model: "codex/gpt-5.6-sol",
        },
      }),
    ];
    const policyRepair = repairCronCodexRuntimePolicies({
      cfg: { agents: { entries: { main: { default: true } } } },
      targets: collectStoredCronCodexRuntimePolicyTargets(jobs),
    });

    expect(policyRepair.config.agents?.entries?.main?.models).toMatchObject({
      "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } },
    });
    expect(policyRepair.config.agents?.defaults?.models).toBeUndefined();
  });

  it("retains a post-snapshot Codex ref until its runtime policy is persisted", () => {
    const jobs = [
      makeLegacyJob({
        id: "post-snapshot-codex-cron-model",
        schedule: { kind: "every", everyMs: 60_000 },
        payload: {
          kind: "agentTurn",
          message: "ping",
          model: "codex/gpt-5.6-sol",
        },
      }),
    ];
    const rewritePlan = planCronCodexRefRewriteAgainstPersistedConfig({
      cfg: { agents: { entries: { main: { default: true } } } },
      targets: collectStoredCronCodexRuntimePolicyTargets(jobs),
    });
    const blocked = new Set(rewritePlan.blockedTargets.map(cronCodexRuntimePolicyTargetKey));

    const result = normalizeStoredCronJobs(jobs, {
      migrateCodexModelRefs: true,
      shouldMigrateCodexRuntimePolicyTarget: (target) =>
        !blocked.has(cronCodexRuntimePolicyTargetKey(target)),
    });

    expect(rewritePlan.warnings).toEqual([
      expect.stringContaining("policy is not present in persisted config"),
    ]);
    expect(result.issues.legacyPayloadCodexModel).toBe(1);
    expect(result.codexRuntimePolicyTargets).toStrictEqual([]);
    const job = expectDefined(jobs[0], "job test invariant");
    expect((job.payload as Record<string, unknown>).model).toBe("codex/gpt-5.6-sol");
  });

  it("does not rewrite Codex refs during an ordinary cron normalization pass", () => {
    const { job, result } = normalizeOneJob(
      makeLegacyJob({
        id: "deferred-codex-cron-model",
        schedule: { kind: "every", everyMs: 60_000 },
        payload: {
          kind: "agentTurn",
          message: "ping",
          model: "codex/gpt-5.6-sol",
        },
      }),
    );

    expect(result.issues.legacyPayloadCodexModel).toBe(1);
    expect(result.codexRuntimePolicyTargets).toStrictEqual([]);
    expect(
      (expectDefined(job, "job test invariant").payload as Record<string, unknown>).model,
    ).toBe("codex/gpt-5.6-sol");
  });

  it("converts legacy agent command prompts into command cron payloads", () => {
    const command =
      "cd /home/openclaw/.razor/quant && ./scripts/system/run_position_control.sh --write-card --silent-token NO_REPLY";
    const { job, result } = normalizeOneJob(
      makeLegacyJob({
        id: "quant-position-card",
        schedule: { kind: "cron", expr: "*/30 * * * *", tz: "Europe/Madrid" },
        sessionTarget: "isolated",
        payload: {
          kind: "agentTurn",
          message: [
            "Run this deterministic shell job once and report only the final JSON/status.",
            "",
            "Command to run:",
            `- command: ${command}`,
            "- workdir: /home/openclaw/.razor/quant",
            "- background: false",
            "- timeout: 840",
            "",
            "Final response contract:",
            "- If the command prints exactly NO_REPLY, respond exactly NO_REPLY.",
            "- Otherwise return the concise command output.",
          ].join("\n"),
          toolsAllow: ["bash", "process"],
          lightContext: true,
          timeoutSeconds: 900,
          model: "openai/gpt-5.5",
          deliver: true,
          channel: "telegram",
          to: "123",
        },
      }),
    );

    expect(result.mutated).toBe(true);
    expect(result.issues.legacyAgentTurnCommandPayload).toBe(1);
    expect(expectDefined(job, "job test invariant").delivery).toEqual({
      mode: "announce",
      channel: "telegram",
      to: "123",
    });
    const payload = expectDefined(job, "job test invariant").payload as Record<string, unknown>;
    expect(payload).toEqual({
      kind: "command",
      argv: ["sh", "-lc", command],
      cwd: "/home/openclaw/.razor/quant",
      timeoutSeconds: 900,
    });
  });

  it("does not convert command-shaped prompts without shell tool access", () => {
    const command = "python3 scripts/check_mail.py";
    const { job, result } = normalizeOneJob(
      makeLegacyJob({
        id: "restricted-command-prompt",
        schedule: { kind: "cron", expr: "*/30 * * * *", tz: "Europe/Madrid" },
        sessionTarget: "isolated",
        payload: {
          kind: "agentTurn",
          message: [
            "Command to run:",
            `- command: ${command}`,
            "- workdir: /home/openclaw/.razor/clawd",
          ].join("\n"),
          toolsAllow: ["read", "message"],
        },
      }),
    );

    expect(result.issues.legacyAgentTurnCommandPayload).toBeUndefined();
    expect(result.issues.unresolvedAgentTurnShellToolPrompt).toBe(1);
    expect(result.unresolvedAgentTurnCommandPromptJobs).toEqual(["Legacy job"]);
    expect(result.unresolvedAgentTurnShellToolPromptJobs).toEqual([]);
    const payload = expectDefined(job, "job test invariant").payload as Record<string, unknown>;
    expect(payload.kind).toBe("agentTurn");
    expect(payload.message).toContain(command);
    expect(payload.toolsAllow).toEqual(["read", "message"]);
  });

  it("warns without converting mixed agent prompts that request shell tools", () => {
    const { job, result } = normalizeOneJob(
      makeLegacyJob({
        id: "mixed-agent-job",
        schedule: { kind: "cron", expr: "0 9 * * *", tz: "Europe/Madrid" },
        sessionTarget: "isolated",
        payload: {
          kind: "agentTurn",
          message:
            "Run deterministic health first: python3 scripts/check_mail.py and then decide whether to send a summary.",
          toolsAllow: ["bash", "read", "message"],
          lightContext: true,
        },
      }),
    );

    expect(result.issues.legacyAgentTurnCommandPayload).toBeUndefined();
    expect(result.issues.unresolvedAgentTurnShellToolPrompt).toBe(1);
    expect(result.unresolvedAgentTurnShellToolPromptJobs).toEqual(["Legacy job"]);
    const payload = expectDefined(job, "job test invariant").payload as Record<string, unknown>;
    expect(payload.kind).toBe("agentTurn");
    expect(payload.message).toContain("Run deterministic health first");
    expect(payload.toolsAllow).toEqual(["bash", "read", "message"]);
  });

  it("warns on shell-style prompts with unrestricted tool access", () => {
    const { result } = normalizeOneJob(
      makeLegacyJob({
        id: "implicit-tools-shell-job",
        schedule: { kind: "cron", expr: "0 9 * * *", tz: "Europe/Madrid" },
        sessionTarget: "isolated",
        payload: {
          kind: "agentTurn",
          message:
            "Run python3 scripts/check_mail.py and send a compact summary if anything changed.",
          lightContext: true,
        },
      }),
    );

    expect(result.issues.unresolvedAgentTurnShellToolPrompt).toBe(1);
    expect(result.unresolvedAgentTurnShellToolPromptJobs).toEqual(["Legacy job"]);
  });

  it("warns on shell-style prompts with wildcard tool access", () => {
    const { result } = normalizeOneJob(
      makeLegacyJob({
        id: "wildcard-tools-shell-job",
        schedule: { kind: "cron", expr: "0 9 * * *", tz: "Europe/Madrid" },
        sessionTarget: "isolated",
        payload: {
          kind: "agentTurn",
          message:
            "Execute ./scripts/check_mail.sh and send a compact summary if anything changed.",
          toolsAllow: ["*"],
          lightContext: true,
        },
      }),
    );

    expect(result.issues.unresolvedAgentTurnShellToolPrompt).toBe(1);
    expect(result.unresolvedAgentTurnShellToolPromptJobs).toEqual(["Legacy job"]);
  });

  it("does not warn on ordinary agent prompts that mention commands without shell tools", () => {
    const { job, result } = normalizeOneJob(
      makeLegacyJob({
        id: "ordinary-agent-job",
        schedule: { kind: "cron", expr: "0 9 * * *", tz: "Europe/Madrid" },
        sessionTarget: "isolated",
        payload: {
          kind: "agentTurn",
          message: "Explain whether the user should run python3 scripts/check_mail.py.",
          toolsAllow: ["read", "message"],
          lightContext: true,
        },
        delivery: { mode: "announce" },
      }),
    );

    expect(result.issues.unresolvedAgentTurnShellToolPrompt).toBeUndefined();
    const payload = expectDefined(job, "job test invariant").payload as Record<string, unknown>;
    expect(payload.kind).toBe("agentTurn");
    expect(payload.message).toContain("python3 scripts/check_mail.py");
  });

  it("does not report legacyPayloadKind for already-normalized payload kinds", () => {
    const jobs = [
      {
        id: "normalized-agent-turn",
        name: "normalized",
        enabled: true,
        wakeMode: "now",
        schedule: { kind: "every", everyMs: 60_000, anchorMs: 1 },
        payload: { kind: "agentTurn", message: "ping" },
        sessionTarget: "isolated",
        delivery: { mode: "announce" },
        state: {},
      },
    ] as Array<Record<string, unknown>>;

    const result = normalizeStoredCronJobs(jobs);

    expect(result.mutated).toBe(false);
    expect(result.issues.legacyPayloadKind).toBeUndefined();
  });

  it("rewrites legacy systemEvent message payloads to text", () => {
    const jobs = [
      makeLegacyJob({
        id: "legacy-system-event-message",
        schedule: { kind: "every", everyMs: 60_000, anchorMs: 1 },
        payload: { kind: "systemEvent", message: "tick" },
      }),
    ];

    const result = normalizeStoredCronJobs(jobs);

    expect(result.mutated).toBe(true);
    expect(result.jobs[0]?.payload).toEqual({ kind: "systemEvent", text: "tick" });
    expect(result.removedJobs).toEqual([]);
  });

  it("removes unrepairable persisted schedule and payload shapes", () => {
    const jobs = [
      makeLegacyJob({
        id: "valid",
        schedule: { kind: "every", everyMs: 60_000, anchorMs: 1 },
        payload: { kind: "systemEvent", text: "tick" },
      }),
      makeLegacyJob({
        id: "bad-schedule",
        schedule: { kind: "cron", expr: [] },
        payload: { kind: "systemEvent", text: "tick" },
      }),
      makeLegacyJob({
        id: "bad-payload",
        schedule: { kind: "every", everyMs: 60_000, anchorMs: 1 },
        payload: { kind: "agentTurn", message: ["tick"] },
      }),
      makeLegacyJob({
        id: "missing-schedule",
        schedule: undefined,
        payload: { kind: "systemEvent", text: "tick" },
      }),
      makeLegacyJob({
        id: "missing-payload",
        schedule: { kind: "every", everyMs: 60_000, anchorMs: 1 },
        payload: undefined,
      }),
      makeLegacyJob({
        id: "incomplete-system-payload",
        schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
        payload: { kind: "systemEvent" },
      }),
    ];

    const result = normalizeStoredCronJobs(jobs);

    expect(result.mutated).toBe(true);
    expect(result.issues.invalidSchedule).toBe(2);
    expect(result.issues.invalidPayload).toBe(3);
    expect(jobs.map((job) => job.id)).toEqual(["valid"]);
    expect(result.jobs.map((job) => job.id)).toEqual(["valid"]);
  });

  it("does not normalize unsupported payload kinds into runnable cron jobs", () => {
    const jobs = [
      makeLegacyJob({
        id: "legacy-command-kind",
        schedule: { kind: "every", everyMs: 60_000, anchorMs: 1 },
        payload: { kind: "command", command: "echo daily" },
      }),
      makeLegacyJob({
        id: "legacy-agentmessage-kind",
        schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
        sessionTarget: "isolated",
        payload: { kind: "agentmessage", message: "summarize" },
      }),
    ];

    const result = normalizeStoredCronJobs(jobs);

    expect(result.mutated).toBe(true);
    expect(result.issues.invalidPayload).toBe(2);
    expect(jobs).toEqual([]);
    expect(result.jobs).toEqual([]);
  });

  it("normalizes whitespace-padded and non-canonical payload kinds", () => {
    const jobs = [
      {
        id: "spaced-agent-turn",
        name: "normalized",
        enabled: true,
        wakeMode: "now",
        schedule: { kind: "every", everyMs: 60_000, anchorMs: 1 },
        payload: { kind: " agentTurn ", message: "ping" },
        sessionTarget: "isolated",
        delivery: { mode: "announce" },
        state: {},
      },
      {
        id: "upper-system-event",
        name: "normalized",
        enabled: true,
        wakeMode: "now",
        schedule: { kind: "every", everyMs: 60_000, anchorMs: 1 },
        payload: { kind: "SYSTEMEVENT", text: "pong" },
        sessionTarget: "main",
        delivery: { mode: "announce" },
        state: {},
      },
    ] as Array<Record<string, unknown>>;

    const result = normalizeStoredCronJobs(jobs);

    expect(result.mutated).toBe(true);
    expect(result.issues.legacyPayloadKind).toBe(2);
    const firstPayload = jobs[0]?.payload as Record<string, unknown> | undefined;
    expect(firstPayload?.kind).toBe("agentTurn");
    expect(firstPayload?.message).toBe("ping");
    const secondPayload = jobs[1]?.payload as Record<string, unknown> | undefined;
    expect(secondPayload?.kind).toBe("systemEvent");
    expect(secondPayload?.text).toBe("pong");
  });

  it("normalizes isolated legacy jobs without mutating runtime code paths", () => {
    const { job, result } = normalizeOneJob(
      makeLegacyJob({
        id: "job-1",
        sessionKey: "  agent:main:discord:channel:ops  ",
        schedule: { kind: "at", atMs: 1_700_000_000_000 },
        sessionTarget: "isolated",
        payload: {
          kind: "agentTurn",
          message: "hi",
          deliver: true,
          channel: "telegram",
          to: "7200373102",
          bestEffortDeliver: true,
        },
        isolation: { postToMainPrefix: "Cron" },
      }),
    );

    expect(result.mutated).toBe(true);
    expect(expectDefined(job, "job test invariant").sessionKey).toBe(
      "agent:main:discord:channel:ops",
    );
    expect(expectDefined(job, "job test invariant").delivery).toEqual({
      mode: "announce",
      channel: "telegram",
      to: "7200373102",
      bestEffort: true,
    });
    expect("isolation" in expectDefined(job, "job test invariant")).toBe(false);

    const payload = expectDefined(job, "job test invariant").payload as Record<string, unknown>;
    expect(payload.deliver).toBeUndefined();
    expect(payload.channel).toBeUndefined();
    expect(payload.to).toBeUndefined();
    expect(payload.bestEffortDeliver).toBeUndefined();

    const schedule = expectDefined(job, "job test invariant").schedule as Record<string, unknown>;
    expect(schedule.kind).toBe("at");
    expect(schedule.at).toBe(new Date(1_700_000_000_000).toISOString());
    expect(schedule.atMs).toBeUndefined();
  });

  it("leaves Date-invalid legacy atMs for persisted shape validation", () => {
    const { job, result } = normalizeOneJob(
      makeLegacyJob({
        id: "job-invalid-at",
        schedule: { kind: "at", atMs: 8_700_000_000_000_000 },
      }),
    );

    expect(result.mutated).toBe(true);
    expect(result.issues.invalidSchedule).toBe(1);
    expect(job).toBeUndefined();
  });

  it("drops Date-invalid legacy atMs when canonical at is valid", () => {
    const at = "2026-04-01T10:00:00.000Z";
    const { job, result } = normalizeOneJob(
      makeLegacyJob({
        id: "job-valid-at-invalid-at-ms",
        schedule: { kind: "at", at, atMs: 8_700_000_000_000_000 },
      }),
    );

    const schedule = expectDefined(job, "job test invariant").schedule as Record<string, unknown>;
    expect(result.mutated).toBe(true);
    expect(result.issues.invalidSchedule).toBeUndefined();
    expect(schedule.at).toBe(at);
    expect(schedule.atMs).toBeUndefined();
  });

  it("preserves stored custom session targets", () => {
    const { job } = normalizeOneJob(
      makeLegacyJob({
        id: "job-custom-session",
        name: "Custom session",
        schedule: { kind: "cron", expr: "0 23 * * *", tz: "UTC" },
        sessionTarget: "session:ProjectAlpha",
        payload: {
          kind: "agentTurn",
          message: "hello",
        },
      }),
    );

    expect(expectDefined(job, "job test invariant").sessionTarget).toBe("session:ProjectAlpha");
    expect(expectDefined(job, "job test invariant").delivery).toEqual({ mode: "announce" });
  });

  it("adds anchorMs to legacy every schedules", () => {
    const createdAtMs = 1_700_000_000_000;
    const { job } = normalizeOneJob(
      makeLegacyJob({
        id: "job-every-legacy",
        name: "Legacy every",
        createdAtMs,
        updatedAtMs: createdAtMs,
        schedule: { kind: "every", everyMs: 120_000 },
      }),
    );

    const schedule = expectDefined(job, "job test invariant").schedule as Record<string, unknown>;
    expect(schedule.kind).toBe("every");
    expect(schedule.anchorMs).toBe(createdAtMs);
  });

  it("adds default staggerMs to legacy recurring top-of-hour cron schedules", () => {
    const { job } = normalizeOneJob(
      makeLegacyJob({
        id: "job-cron-legacy",
        name: "Legacy cron",
        schedule: { kind: "cron", expr: "0 */2 * * *", tz: "UTC" },
      }),
    );

    const schedule = expectDefined(job, "job test invariant").schedule as Record<string, unknown>;
    expect(schedule.kind).toBe("cron");
    expect(schedule.staggerMs).toBe(DEFAULT_TOP_OF_HOUR_STAGGER_MS);
  });

  it("adds default staggerMs to legacy 6-field top-of-hour cron schedules", () => {
    const { job } = normalizeOneJob(
      makeLegacyJob({
        id: "job-cron-seconds-legacy",
        name: "Legacy cron seconds",
        schedule: { kind: "cron", expr: "0 0 */3 * * *", tz: "UTC" },
      }),
    );

    const schedule = expectDefined(job, "job test invariant").schedule as Record<string, unknown>;
    expect(schedule.kind).toBe("cron");
    expect(schedule.staggerMs).toBe(DEFAULT_TOP_OF_HOUR_STAGGER_MS);
  });

  it("removes invalid legacy staggerMs from non top-of-hour cron schedules", () => {
    const { job } = normalizeOneJob(
      makeLegacyJob({
        id: "job-cron-minute-legacy",
        name: "Legacy minute cron",
        schedule: {
          kind: "cron",
          expr: "17 * * * *",
          tz: "UTC",
          staggerMs: "bogus",
        },
      }),
    );

    const schedule = expectDefined(job, "job test invariant").schedule as Record<string, unknown>;
    expect(schedule.kind).toBe("cron");
    expect(schedule.staggerMs).toBeUndefined();
  });

  it("migrates legacy string schedules and command-only payloads (#18445)", () => {
    const { job, result } = normalizeOneJob({
      id: "imessage-refresh",
      name: "iMessage Refresh",
      enabled: true,
      createdAtMs: 1_700_000_000_000,
      updatedAtMs: 1_700_000_000_000,
      schedule: "0 */2 * * *",
      command: "bash /tmp/imessage-refresh.sh",
      timeout: 120,
      state: {},
    });

    expect(result.mutated).toBe(true);
    const schedule = expectDefined(job, "job test invariant").schedule as Record<string, unknown>;
    expect(schedule.kind).toBe("cron");
    expect(schedule.expr).toBe("0 */2 * * *");
    expect(expectDefined(job, "job test invariant").sessionTarget).toBe("main");
    expect(expectDefined(job, "job test invariant").wakeMode).toBe("now");
    expect(expectDefined(job, "job test invariant").payload).toEqual({
      kind: "systemEvent",
      text: "bash /tmp/imessage-refresh.sh",
    });
    expect("command" in expectDefined(job, "job test invariant")).toBe(false);
    expect("timeout" in expectDefined(job, "job test invariant")).toBe(false);
  });
});
