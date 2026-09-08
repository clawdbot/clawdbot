import os from "node:os";
import { isDeepStrictEqual } from "node:util";
import { note } from "../../packages/terminal-core/src/note.js";
import {
  detectRepointedWorkspaceAlias,
  inspectWorkspaceAliasMove,
  rebindRepointedWorkspaceAlias,
  type RepointedWorkspaceAliasFacts,
  type WorkspaceAliasRebindOutcome,
} from "../agents/workspace-alias-rebind.js";
import { listWorkspaceStateDirs } from "../agents/workspace-state-dirs.js";
import { readConfigFileSnapshot } from "../config/io.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { shortenHomePath } from "../utils.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

function configuredWorkspaceDirs(cfg: OpenClawConfig): string[] {
  return listWorkspaceStateDirs({
    cfg,
    env: process.env,
    homedir: os.homedir,
    stateDir: resolveStateDir(),
  });
}

function describeRepointedWorkspaceAlias(facts: RepointedWorkspaceAliasFacts): string {
  return `Workspace path ${shortenHomePath(facts.aliasPath)} now resolves to ${shortenHomePath(facts.currentWorkspacePath)}, but its saved setup records belong to ${shortenHomePath(facts.storedWorkspacePath)}.`;
}

export type WorkspaceAliasFinding = {
  checkId: string;
  severity: "warning";
  message: string;
  fixHint: string;
};

const WORKSPACE_ALIAS_CHECK_ID = "core/doctor/workspace-alias";
const REPAIR_HINT =
  "If the same workspace moved, run `openclaw doctor --fix` and confirm the move, or use `openclaw doctor --fix --force`. Otherwise restore the original link or configure the intended workspace directly.";
const REBIND_MESSAGES: Record<Exclude<WorkspaceAliasRebindOutcome, "rebound">, string> = {
  "no-repoint": "The alias no longer needs repair.",
  "repoint-changed":
    "The workspace changed after inspection. Nothing was transferred; rerun doctor to inspect it again.",
  "current-target-owns-state":
    "The destination already owns workspace records. Nothing was merged or deleted. Restore the original link, or configure that destination directly if you intended to switch workspaces.",
  "original-workspace-exists":
    "The original workspace still exists. This repair only moves records after the original folder has moved; restore the link if the move was not intended.",
  "target-directory-missing":
    "The destination is not an existing directory. Restore the moved folder before repairing the link.",
  "configured-workspace-conflict":
    "Another workspace path still refers to the original location. Update the links for the moved workspace, then rerun doctor; no records were transferred.",
};

/** Read-only findings include failed inspection so health cannot report a false success. */
export function collectRepointedWorkspaceAliasFindings(
  cfg: OpenClawConfig,
): WorkspaceAliasFinding[] {
  const findings: WorkspaceAliasFinding[] = [];
  for (const workspaceDir of configuredWorkspaceDirs(cfg)) {
    let message: string;
    try {
      const facts = detectRepointedWorkspaceAlias(workspaceDir);
      if (!facts) {
        continue;
      }
      message = `${describeRepointedWorkspaceAlias(facts)} Incoming messages cannot use this workspace until it is repaired.`;
    } catch (error) {
      message = `Workspace alias inspection failed for ${shortenHomePath(workspaceDir)}: ${formatErrorMessage(error)}`;
    }
    findings.push({
      checkId: WORKSPACE_ALIAS_CHECK_ID,
      severity: "warning",
      message,
      fixHint: REPAIR_HINT,
    });
  }
  return findings;
}

async function maybeRepairRepointedWorkspaceAliases(params: {
  cfg: OpenClawConfig;
  prompter: DoctorPrompter;
}): Promise<void> {
  // Explicit repair acquires Doctor's maintenance owner before any state move.
  if (!params.prompter.shouldRepair) {
    return;
  }
  const workspaceDirs = configuredWorkspaceDirs(params.cfg);
  const configuration = await readConfigFileSnapshot();
  const verifyConfiguration = async () => {
    const current = await readConfigFileSnapshot();
    if (current.readError || !isDeepStrictEqual(current.sourceConfig, configuration.sourceConfig)) {
      throw new Error(
        "Workspace configuration changed during repair. No records were transferred; rerun doctor to inspect the current workspace owners.",
      );
    }
  };
  for (const workspaceDir of workspaceDirs) {
    try {
      // Earlier repairs can cover another spelling; inspect each scope when used.
      const facts = detectRepointedWorkspaceAlias(workspaceDir);
      if (!facts) {
        continue;
      }
      const description = describeRepointedWorkspaceAlias(facts);
      const inspection = inspectWorkspaceAliasMove(workspaceDir, facts, workspaceDirs);
      if (inspection.kind === "blocked") {
        note(`${description} ${REBIND_MESSAGES[inspection.outcome]}`, "Workspace");
        continue;
      }
      const confirmation = {
        message: `${description} Confirm only if this is the same workspace after a folder move. Transfer its saved setup and file-verification history without changing workspace files?`,
        initialValue: false,
      };
      const approved = params.prompter.shouldForce
        ? await params.prompter.confirmAggressiveAutoFix(confirmation)
        : await params.prompter.confirmRuntimeRepair({
            ...confirmation,
            requiresInteractiveConfirmation: true,
          });
      if (!approved) {
        note(`${description} No records were transferred. ${REPAIR_HINT}`, "Workspace");
        continue;
      }
      const outcome = await rebindRepointedWorkspaceAlias(
        workspaceDir,
        facts,
        {},
        workspaceDirs,
        verifyConfiguration,
      );
      note(
        outcome === "rebound"
          ? `Rebound workspace state for ${shortenHomePath(facts.aliasPath)} to ${shortenHomePath(facts.currentWorkspacePath)}. Workspace files were not changed.`
          : `${description} ${REBIND_MESSAGES[outcome]}`,
        "Workspace",
      );
    } catch (error) {
      note(
        `Workspace repair was not applied for ${shortenHomePath(workspaceDir)}: ${formatErrorMessage(error)}`,
        "Workspace",
      );
    }
  }
}

/** Stop migration discovery if its workspace owner still needs an operator decision. */
export function createWorkspaceAliasMigrationRepair(
  prompter: DoctorPrompter | undefined,
  beforePrompt: () => void,
): ((cfg: OpenClawConfig) => Promise<void>) | undefined {
  if (!prompter?.shouldRepair) {
    return undefined;
  }
  return async (cfg) => {
    if (collectRepointedWorkspaceAliasFindings(cfg).length === 0) {
      return;
    }
    beforePrompt();
    await maybeRepairRepointedWorkspaceAliases({ cfg, prompter });
    const unresolved = collectRepointedWorkspaceAliasFindings(cfg);
    if (unresolved.length > 0) {
      throw new Error(
        unresolved.map((finding) => `${finding.message} ${finding.fixHint}`).join("\n"),
      );
    }
  };
}
