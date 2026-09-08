import { resolveSkillsPrompt } from "../../skills/loading/workspace-skill-prompt.js";
import { resolveEmbeddedRunSkillEntries } from "../../skills/runtime/embedded-run-entries.js";
import {
  applySkillEnvOverrides,
  applySkillEnvOverridesFromSnapshot,
} from "../../skills/runtime/env-overrides.js";
import { resolveCodeModeSkills, type CodeModeSkillReader } from "../code-mode-skills.js";
import type { SandboxContext } from "../sandbox/types.js";
import { isToolExecutionAllowed } from "../tool-policy-shared.js";
import type { EmbeddedRunAttemptParams } from "./run/types.js";
import {
  createSandboxPromptEntryLoader,
  mapSandboxSkillEntriesForPrompt,
  mapSandboxSkillUsagePaths,
  resolveSandboxSkillRuntimeInputs,
} from "./sandbox-skills.js";

/** Prepares readable skills and owns environment rollback until the caller takes custody. */
export function prepareEmbeddedSkills(params: {
  attempt: Pick<
    EmbeddedRunAttemptParams,
    | "config"
    | "bootstrapWorkspaceDir"
    | "skillsSnapshot"
    | "contextTokenBudget"
    | "toolExecutionAllow"
    | "operation"
  >;
  effectiveWorkspace: string;
  sandbox: SandboxContext | null | undefined;
  sessionAgentId: string;
  includeCodeModeSkills: boolean;
}) {
  const executionAllow = params.attempt.toolExecutionAllow;
  // Retained schemas are not execution permission. An unreadable skill catalog
  // creates impossible prerequisites and exposes an ungated Code Mode reader.
  if (
    params.attempt.operation === "settled-tool-finalization" ||
    (executionAllow && !isToolExecutionAllowed(executionAllow, "read"))
  ) {
    return {
      restoreSkillEnv: () => {},
      skillUsagePaths: undefined,
      skillsPrompt: "",
      skillsSnapshotForRun: undefined,
      codeModeSkills: [],
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
    skillsAnchorWorkspace: params.attempt.bootstrapWorkspaceDir ?? params.effectiveWorkspace,
    skillsSnapshot: params.attempt.skillsSnapshot,
  });
  const { shouldLoadSkillEntries, skillEntries, loadSkillEntries, preserveEntryOrder } =
    resolveEmbeddedRunSkillEntries({
      workspaceDir: skillsWorkspaceDir,
      config: params.attempt.config,
      agentId: params.sessionAgentId,
      eligibility: skillsEligibility,
      skillsSnapshot,
      // Sandbox fallbacks stay inside their sandbox skill workspace;
      // host execution skills are not mounted there.
      ...(params.sandbox?.enabled === true
        ? {}
        : { executionWorkspaceDir: params.effectiveWorkspace }),
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
    const skillsPrompt = resolveSkillsPrompt({
      contextTokenBudget: params.attempt.contextTokenBudget,
      skillsSnapshot,
      entries: promptSkillEntries,
      loadEntries: createSandboxPromptEntryLoader({
        loadEntries: loadSkillEntries,
        skillsWorkspaceDir,
        skillsPromptWorkspaceDir,
      }),
      config: params.attempt.config,
      workspaceDir: skillsPromptWorkspaceDir,
      agentId: params.sessionAgentId,
      eligibility: skillsEligibility,
      preserveEntryOrder,
    });
    const sandbox = params.sandbox;
    const sandboxSkillReader: CodeModeSkillReader | undefined = sandbox?.enabled
      ? async ({ location, signal }) => {
          const bridge = sandbox.fsBridge;
          if (!bridge) {
            throw new Error("Sandbox filesystem bridge is unavailable for skill reads.");
          }
          return (
            await bridge.readFile({
              filePath: location,
              cwd: sandbox.containerWorkdir,
              signal,
            })
          ).toString("utf8");
        }
      : undefined;
    const codeModeSkills = params.includeCodeModeSkills
      ? resolveCodeModeSkills({
          skillsPrompt,
          candidates: skillsSnapshot?.resolvedSkills ?? skillEntries.map((entry) => entry.skill),
          reader: sandboxSkillReader,
        })
      : [];
    return {
      restoreSkillEnv,
      skillUsagePaths,
      skillsPrompt,
      skillsSnapshotForRun: skillsSnapshot,
      codeModeSkills,
    };
  } catch (error) {
    restoreSkillEnv();
    throw error;
  }
}
