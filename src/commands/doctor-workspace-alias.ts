/** Doctor detection and non-destructive repair for repointed workspace path aliases. */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { note } from "../../packages/terminal-core/src/note.js";
import {
  listAgentIds,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import {
  detectRepointedWorkspaceAlias,
  rebindRepointedWorkspaceAlias,
  type RepointedWorkspaceAliasFacts,
} from "../agents/workspace-alias-rebind.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { shortenHomePath } from "../utils.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

type WorkspaceAliasScope = {
  agentId: string;
  workspaceDir: string;
  labelAgent: boolean;
};

type DetectedWorkspaceAliasScope = WorkspaceAliasScope & {
  facts: RepointedWorkspaceAliasFacts;
};

function resolveWorkspaceAliasScopes(cfg: OpenClawConfig): WorkspaceAliasScope[] {
  const listedAgentIds = listAgentIds(cfg);
  const agentIds = listedAgentIds.length > 0 ? listedAgentIds : [resolveDefaultAgentId(cfg)];
  const labelAgent = agentIds.length > 1;
  return agentIds.map((agentId) => ({
    agentId,
    workspaceDir: resolveAgentWorkspaceDir(cfg, agentId),
    labelAgent,
  }));
}

function detectRepointedWorkspaceAliasScopes(cfg: OpenClawConfig): DetectedWorkspaceAliasScope[] {
  const detected: DetectedWorkspaceAliasScope[] = [];
  for (const scope of resolveWorkspaceAliasScopes(cfg)) {
    let facts: RepointedWorkspaceAliasFacts | undefined;
    try {
      facts = detectRepointedWorkspaceAlias(scope.workspaceDir);
    } catch (error) {
      note(
        `Workspace alias check failed for ${shortenHomePath(scope.workspaceDir)}: ${formatErrorMessage(error)}`,
        "Workspace",
      );
      continue;
    }
    if (facts) {
      detected.push({ ...scope, facts });
    }
  }
  return detected;
}

function describeRepointedWorkspaceAlias(facts: RepointedWorkspaceAliasFacts): string {
  return (
    `workspace path ${shortenHomePath(facts.aliasPath)} now resolves to ` +
    `${shortenHomePath(facts.currentWorkspacePath)}, but its stored setup state still belongs to ` +
    shortenHomePath(facts.storedWorkspacePath)
  );
}

/**
 * Continuity proof for auto-adoption: every attested generated file must exist
 * in the alias's current target with its recorded hash. Anything less keeps the
 * rebind an explicit operator decision.
 */
async function attestedHashesMatchCurrentTarget(
  facts: RepointedWorkspaceAliasFacts,
): Promise<boolean> {
  if (facts.storedAttestationHashes.size === 0) {
    return false;
  }
  for (const [filename, sha256] of facts.storedAttestationHashes) {
    try {
      const buffer = await fs.promises.readFile(path.join(facts.currentWorkspacePath, filename));
      if (crypto.createHash("sha256").update(buffer).digest("hex") !== sha256) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

export type WorkspaceAliasFinding = {
  checkId: string;
  severity: "warning";
  message: string;
  fixHint: string;
};

export const WORKSPACE_ALIAS_CHECK_ID = "core/doctor/workspace-alias";

/** Read-only findings for `openclaw doctor` preview and health reporting. */
export function collectRepointedWorkspaceAliasFindings(
  cfg: OpenClawConfig,
): WorkspaceAliasFinding[] {
  return detectRepointedWorkspaceAliasScopes(cfg).map(({ agentId, labelAgent, facts }) => ({
    checkId: WORKSPACE_ALIAS_CHECK_ID,
    severity: "warning",
    message: `${labelAgent ? `Agent "${agentId}": ` : ""}${describeRepointedWorkspaceAlias(facts)}. Inbound messages for this workspace fail until the alias is repaired.`,
    fixHint: "Run `openclaw doctor --fix` to rebind or retire the stale alias.",
  }));
}

/** Detects repointed workspace aliases and repairs them under doctor's repair flow. */
export async function maybeRepairRepointedWorkspaceAliases(params: {
  cfg: OpenClawConfig;
  prompter: DoctorPrompter;
}): Promise<void> {
  for (const { agentId, workspaceDir, labelAgent, facts } of detectRepointedWorkspaceAliasScopes(
    params.cfg,
  )) {
    const prefix = labelAgent ? `Agent "${agentId}": ` : "";
    const description = describeRepointedWorkspaceAlias(facts);
    if (facts.currentTargetHasOwnState) {
      note(
        `${prefix}${description}. The current target already has its own workspace state, so doctor cannot rebind without merging two workspaces. Delete one workspace's state first if this repoint was intentional.`,
        "Workspace",
      );
      continue;
    }
    if (!params.prompter.shouldRepair) {
      note(
        `${prefix}${description}. Inbound messages for this workspace fail until the alias is repaired. Run \`openclaw doctor --fix\` to rebind it.`,
        "Workspace",
      );
      continue;
    }
    const continuityProven = await attestedHashesMatchCurrentTarget(facts);
    const approved = continuityProven
      ? await params.prompter.confirmAutoFix({
          message: `${prefix}${description}. Attested workspace files match the current target. Rebind the stored state to it?`,
          initialValue: true,
        })
      : // Without matching attestation evidence the new target is unproven, so
        // adoption stays an explicit operator decision (interactive yes or --force).
        await params.prompter.confirmAggressiveAutoFix({
          message: `${prefix}${description}. Attested workspace files do NOT verify against the current target. Rebind the stored state to it anyway?`,
          initialValue: false,
        });
    if (!approved) {
      note(
        `${prefix}Left the repointed workspace alias in place. Inbound messages for this workspace keep failing until it is repaired.`,
        "Workspace",
      );
      continue;
    }
    const outcome = rebindRepointedWorkspaceAlias(workspaceDir);
    if (outcome === "rebound") {
      note(
        `${prefix}Rebound workspace state for ${shortenHomePath(facts.aliasPath)} to ${shortenHomePath(facts.currentWorkspacePath)}.`,
        "Workspace",
      );
    } else {
      note(
        `${prefix}Workspace alias rebind for ${shortenHomePath(facts.aliasPath)} was not applied (${outcome}); re-run \`openclaw doctor\` to re-check.`,
        "Workspace",
      );
    }
  }
}
