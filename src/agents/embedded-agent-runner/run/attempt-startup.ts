import {
  diagnosticErrorCategory,
  diagnosticErrorMessage,
} from "../../../infra/diagnostic-error-metadata.js";
import {
  emitTrustedDiagnosticEvent,
  emitTrustedDiagnosticEventWithPrivateData,
} from "../../../infra/diagnostic-events.js";
import {
  createChildDiagnosticTraceContext,
  createDiagnosticTraceContext,
  freezeDiagnosticTraceContext,
  getActiveDiagnosticTraceContext,
} from "../../../infra/diagnostic-trace-context.js";
import { resolveSkillsPromptForRun } from "../../../skills/loading/workspace.js";
import { resolveEmbeddedRunSkillEntries } from "../../../skills/runtime/embedded-run-entries.js";
import {
  applySkillEnvOverrides,
  applySkillEnvOverridesFromSnapshot,
} from "../../../skills/runtime/env-overrides.js";
import {
  mapSandboxSkillEntriesForPrompt,
  mapSandboxSkillUsagePaths,
  resolveSandboxSkillRuntimeInputs,
} from "../sandbox-skills.js";
import type { prepareEmbeddedAttemptSetup } from "./attempt-setup.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type AttemptSetup = Awaited<ReturnType<typeof prepareEmbeddedAttemptSetup>>;

export function prepareEmbeddedAttemptSkills(params: {
  attempt: EmbeddedRunAttemptParams;
  effectiveWorkspace: string;
  sandbox: AttemptSetup["sandbox"];
  sessionAgentId: string;
}) {
  if (params.attempt.operation === "settled-tool-finalization") {
    return {
      restoreSkillEnv: () => {},
      skillUsagePaths: undefined,
      skillsPrompt: "",
      skillsSnapshotForRun: undefined,
    };
  }
  const {
    skillsEligibility,
    skillsPromptWorkspaceDir,
    skillsSnapshot,
    skillsWorkspaceDir,
    workspaceOnly,
  } = resolveSandboxSkillRuntimeInputs({
    sandbox: params.sandbox,
    effectiveWorkspace: params.effectiveWorkspace,
    skillsSnapshot: params.attempt.skillsSnapshot,
  });
  const { shouldLoadSkillEntries, skillEntries } = resolveEmbeddedRunSkillEntries({
    workspaceDir: skillsWorkspaceDir,
    config: params.attempt.config,
    agentId: params.sessionAgentId,
    eligibility: skillsEligibility,
    skillsSnapshot,
    workspaceOnly,
  });
  const restoreSkillEnv = skillsSnapshot
    ? applySkillEnvOverridesFromSnapshot({
        snapshot: skillsSnapshot,
        config: params.attempt.config,
      })
    : applySkillEnvOverrides({
        skills: skillEntries ?? [],
        config: params.attempt.config,
      });
  try {
    const promptSkillEntries = mapSandboxSkillEntriesForPrompt({
      entries: shouldLoadSkillEntries ? skillEntries : undefined,
      skillsWorkspaceDir,
      skillsPromptWorkspaceDir,
    });
    const skillUsagePaths = mapSandboxSkillUsagePaths({
      paths: params.sandbox?.skillUsagePaths,
      skillsWorkspaceDir,
      skillsPromptWorkspaceDir,
    });
    const skillsPrompt = resolveSkillsPromptForRun({
      skillsSnapshot,
      entries: promptSkillEntries,
      config: params.attempt.config,
      workspaceDir: skillsPromptWorkspaceDir,
      agentId: params.sessionAgentId,
      eligibility: skillsEligibility,
    });
    return {
      restoreSkillEnv,
      skillUsagePaths,
      skillsPrompt,
      skillsSnapshotForRun: skillsSnapshot,
    };
  } catch (error) {
    restoreSkillEnv();
    throw error;
  }
}

export type EmitDiagnosticRunCompleted = (
  outcome: "completed" | "aborted" | "blocked" | "error",
  err?: unknown,
  extra?: { blockedBy?: string },
) => void;

export function startEmbeddedAttemptDiagnostics(params: EmbeddedRunAttemptParams): {
  diagnosticTrace: ReturnType<typeof freezeDiagnosticTraceContext>;
  runTrace: ReturnType<typeof freezeDiagnosticTraceContext>;
  emitCompleted: EmitDiagnosticRunCompleted;
} {
  const diagnosticTrace = freezeDiagnosticTraceContext(
    getActiveDiagnosticTraceContext() ?? createDiagnosticTraceContext(),
  );
  const runTrace = freezeDiagnosticTraceContext(createChildDiagnosticTraceContext(diagnosticTrace));
  const diagnosticRunBase = {
    runId: params.runId,
    ...(params.sessionKey && { sessionKey: params.sessionKey }),
    ...(params.sessionId && { sessionId: params.sessionId }),
    provider: params.provider,
    model: params.modelId,
    trigger: params.trigger,
    ...((params.messageChannel ?? params.messageProvider)
      ? { channel: params.messageChannel ?? params.messageProvider }
      : {}),
    trace: runTrace,
  };
  emitTrustedDiagnosticEvent({
    type: "run.started",
    ...diagnosticRunBase,
  });
  const startedAt = Date.now();
  let completed = false;
  const emitCompleted: EmitDiagnosticRunCompleted = (outcome, err, extra) => {
    if (completed) {
      return;
    }
    completed = true;
    const failed = err != null && outcome !== "blocked";
    const errorMessage = failed ? diagnosticErrorMessage(err) : undefined;
    emitTrustedDiagnosticEventWithPrivateData(
      {
        type: "run.completed",
        ...diagnosticRunBase,
        durationMs: Date.now() - startedAt,
        outcome,
        ...(extra?.blockedBy ? { blockedBy: extra.blockedBy } : {}),
        ...(failed ? { errorCategory: diagnosticErrorCategory(err) } : {}),
      },
      errorMessage ? { errorMessage } : undefined,
    );
  };
  return { diagnosticTrace, runTrace, emitCompleted };
}
