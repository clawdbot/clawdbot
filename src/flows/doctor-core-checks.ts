import path from "node:path";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { buildWorkspaceSkillStatus, type SkillStatusEntry } from "../agents/skills-status.js";
import {
  detectLegacyClawdBrowserProfileResidue,
  maybeArchiveLegacyClawdBrowserProfileResidue,
  type LegacyClawdBrowserProfileResidue,
} from "../commands/doctor-browser.js";
import { hasConfiguredCommandOwners } from "../commands/doctor-command-owner.js";
import {
  collectUnavailableAgentSkills,
  disableUnavailableSkillsInConfig,
} from "../commands/doctor-skills.js";
import type { ConfigValidationIssue, OpenClawConfig } from "../config/types.openclaw.js";
import { hasAmbiguousGatewayAuthModeConfig } from "../gateway/auth-mode-policy.js";
import { registerHealthCheck } from "./health-check-registry.js";
import type { HealthCheck, HealthFinding } from "./health-checks.js";

const BROWSER_CLAWD_PROFILE_RESIDUE_CHECK_ID = "core/doctor/browser-clawd-profile-residue";
const FINAL_CONFIG_VALIDATION_CHECK_ID = "core/doctor/final-config-validation";

export function configValidationIssuesToHealthFindings(
  issues: readonly ConfigValidationIssue[],
): readonly HealthFinding[] {
  return issues.map(
    (issue): HealthFinding => ({
      checkId: FINAL_CONFIG_VALIDATION_CHECK_ID,
      severity: "error",
      message: issue.message,
      path: issue.path || "<root>",
    }),
  );
}

const gatewayConfigCheck: HealthCheck = {
  id: "core/doctor/gateway-config",
  kind: "core",
  description: "openclaw.jsonc gateway block is set and unambiguous.",
  source: "doctor",
  async detect(ctx) {
    const findings: HealthFinding[] = [];
    if (!ctx.cfg.gateway?.mode) {
      findings.push({
        checkId: "core/doctor/gateway-config",
        severity: "warning",
        message: "gateway.mode is unset; gateway start will be blocked.",
        path: "gateway.mode",
        fixHint:
          "Run `openclaw configure` and set Gateway mode (local/remote), or `openclaw config set gateway.mode local`.",
      });
    }
    if (ctx.cfg.gateway?.mode !== "remote" && hasAmbiguousGatewayAuthModeConfig(ctx.cfg)) {
      findings.push({
        checkId: "core/doctor/gateway-config",
        severity: "warning",
        message:
          "gateway.auth.token and gateway.auth.password are both configured while gateway.auth.mode is unset; auth selection is ambiguous.",
        path: "gateway.auth.mode",
        fixHint:
          "Set an explicit mode: `openclaw config set gateway.auth.mode token` or `... password`.",
      });
    }
    return findings;
  },
};

const commandOwnerCheck: HealthCheck = {
  id: "core/doctor/command-owner",
  kind: "core",
  description: "An owner account is configured for owner-only commands.",
  source: "doctor",
  async detect(ctx) {
    if (hasConfiguredCommandOwners(ctx.cfg)) {
      return [];
    }
    return [
      {
        checkId: "core/doctor/command-owner",
        severity: "info",
        message:
          "No command owner is configured. Owner-only commands (/diagnostics, /export-trajectory, /config, exec approvals) have no allowed sender.",
        path: "commands.ownerAllowFrom",
        fixHint:
          "Set commands.ownerAllowFrom to your channel user id, e.g. `openclaw config set commands.ownerAllowFrom '[\"telegram:123456789\"]'`.",
      },
    ];
  },
};

const workspaceStatusCheck: HealthCheck = {
  id: "core/doctor/workspace-status",
  kind: "core",
  description: "Workspace directory exists and has no legacy duplicates.",
  source: "doctor",
  async detect(ctx) {
    const { detectLegacyWorkspaceDirs } = await import("../commands/doctor-workspace.js");
    const workspaceDir = resolveAgentWorkspaceDir(ctx.cfg, resolveDefaultAgentId(ctx.cfg));
    const legacy = detectLegacyWorkspaceDirs({ workspaceDir });
    if (legacy.legacyDirs.length === 0) {
      return [];
    }
    return [
      {
        checkId: "core/doctor/workspace-status",
        severity: "info",
        message: `Detected ${legacy.legacyDirs.length} legacy workspace director${
          legacy.legacyDirs.length === 1 ? "y" : "ies"
        } alongside the active workspace.`,
        path: workspaceDir,
        fixHint:
          "Inspect the legacy directories and migrate or remove them; see `openclaw doctor` for the detailed migration prompt.",
      },
    ];
  },
};

const skillsReadinessCheck: HealthCheck = {
  id: "core/doctor/skills-readiness",
  kind: "core",
  description: "Allowed skills are usable in the current runtime environment.",
  source: "doctor",
  async detect(ctx, scope) {
    const unavailable = filterUnavailableSkillsForScope(
      detectUnavailableSkills(ctx.cfg),
      scope?.paths,
    );
    return unavailable.map(unavailableSkillToFinding);
  },
  async repair(ctx, findings) {
    const unavailable = filterUnavailableSkillsForScope(
      detectUnavailableSkills(ctx.cfg),
      findings.map((finding) => finding.path),
    );
    if (unavailable.length === 0) {
      return { changes: [] };
    }
    const nextConfig = disableUnavailableSkillsInConfig(ctx.cfg, unavailable);
    return {
      config: nextConfig,
      changes: unavailable.map((skill) => `Disabled unavailable skill ${skill.name}.`),
      effects: unavailable.map((skill) => ({
        kind: "config" as const,
        action: ctx.dryRun === true ? "would-disable-skill" : "disable-skill",
        target: skillReadinessPath(skill),
        dryRunSafe: true,
      })),
    };
  },
};

function unavailableSkillToFinding(skill: SkillStatusEntry): HealthFinding {
  return {
    checkId: "core/doctor/skills-readiness",
    severity: "warning",
    message: `${skill.name} is allowed but unavailable: ${formatMissingSkillSummary(skill)}.`,
    path: skillReadinessPath(skill),
    fixHint:
      "Install/configure the missing requirement, or run `openclaw doctor --fix` to disable unused unavailable skills.",
  };
}

function filterUnavailableSkillsForScope(
  unavailable: readonly SkillStatusEntry[],
  paths: readonly (string | undefined)[] | undefined,
): SkillStatusEntry[] {
  const scopedPaths = new Set(paths?.filter((path): path is string => path !== undefined) ?? []);
  if (scopedPaths.size === 0) {
    return [...unavailable];
  }
  return unavailable.filter((skill) => scopedPaths.has(skillReadinessPath(skill)));
}

function skillReadinessPath(skill: SkillStatusEntry): string {
  return `skills.entries.${skill.skillKey}.enabled`;
}

function browserResidueDeps(ctx: { configPath?: string }) {
  return ctx.configPath ? { configDir: path.dirname(ctx.configPath) } : {};
}

function browserResidueFinding(residue: LegacyClawdBrowserProfileResidue): HealthFinding {
  return {
    checkId: BROWSER_CLAWD_PROFILE_RESIDUE_CHECK_ID,
    severity: "warning",
    message: `Legacy managed browser profile residue was found at ${residue.legacyProfileDir}.`,
    path: residue.legacyProfileDir,
    ocPath: "oc://state/browser/clawd",
    fixHint:
      "Run `openclaw doctor --fix` to archive the stale clawd profile safely instead of deleting it in place.",
  };
}

function formatWouldArchiveBrowserResidue(residue: LegacyClawdBrowserProfileResidue): string {
  return [
    "Would archive legacy clawd managed browser profile residue.",
    `- legacy profile: ${residue.legacyProfileDir}`,
    `- canonical profile: ${residue.canonicalUserDataDir}`,
  ].join("\n");
}

const browserClawdProfileResidueCheck: HealthCheck = {
  id: BROWSER_CLAWD_PROFILE_RESIDUE_CHECK_ID,
  kind: "core",
  description:
    "Legacy clawd managed browser profile residue has been archived after the OpenClaw rename.",
  source: "doctor",
  async detect(ctx, scope) {
    const residue = await detectLegacyClawdBrowserProfileResidue(ctx.cfg, browserResidueDeps(ctx));
    if (!residue) {
      return [];
    }
    const scopedPaths = new Set(scope?.paths ?? []);
    if (scopedPaths.size > 0 && !scopedPaths.has(residue.legacyProfileDir)) {
      return [];
    }
    return [browserResidueFinding(residue)];
  },
  async repair(ctx) {
    const residue = await detectLegacyClawdBrowserProfileResidue(ctx.cfg, browserResidueDeps(ctx));
    if (!residue) {
      return {
        status: "skipped",
        reason: "legacy clawd browser profile residue no longer exists",
        changes: [],
      };
    }
    const effect = {
      kind: "state" as const,
      action:
        ctx.dryRun === true
          ? "would-archive-legacy-browser-profile-residue"
          : "archive-legacy-browser-profile-residue",
      target: residue.legacyProfileDir,
      dryRunSafe: false,
    };
    if (ctx.dryRun === true) {
      return {
        changes: [formatWouldArchiveBrowserResidue(residue)],
        effects: [effect],
      };
    }
    const result = await maybeArchiveLegacyClawdBrowserProfileResidue(
      ctx.cfg,
      browserResidueDeps(ctx),
    );
    if (result.changes.length === 0 && result.warnings.length > 0) {
      return {
        status: "failed",
        reason: result.warnings.join("; "),
        changes: [],
        warnings: result.warnings,
        effects: [],
      };
    }
    return {
      changes: result.changes,
      warnings: result.warnings,
      effects: result.changes.length > 0 ? [effect] : [],
    };
  },
};

const finalConfigValidationCheck: HealthCheck = {
  id: FINAL_CONFIG_VALIDATION_CHECK_ID,
  kind: "core",
  description: "Active openclaw.jsonc parses and conforms to the config schema.",
  source: "doctor",
  async detect() {
    const { readConfigFileSnapshot } = await import("../config/config.js");
    const snap = await readConfigFileSnapshot();
    if (!snap.exists || snap.valid) {
      return [];
    }
    return configValidationIssuesToHealthFindings(snap.issues);
  },
};

let registered = false;

export function registerCoreHealthChecks(): void {
  if (registered) {
    return;
  }
  registerHealthCheck(gatewayConfigCheck);
  registerHealthCheck(commandOwnerCheck);
  registerHealthCheck(workspaceStatusCheck);
  registerHealthCheck(skillsReadinessCheck);
  registerHealthCheck(browserClawdProfileResidueCheck);
  registerHealthCheck(finalConfigValidationCheck);
  registered = true;
}

export function resetCoreHealthChecksForTest(): void {
  registered = false;
}

export const CORE_HEALTH_CHECKS: readonly HealthCheck[] = [
  gatewayConfigCheck,
  commandOwnerCheck,
  workspaceStatusCheck,
  skillsReadinessCheck,
  browserClawdProfileResidueCheck,
  finalConfigValidationCheck,
];

function detectUnavailableSkills(cfg: OpenClawConfig): SkillStatusEntry[] {
  const agentId = resolveDefaultAgentId(cfg);
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  const report = buildWorkspaceSkillStatus(workspaceDir, {
    config: cfg,
    agentId,
  });
  return collectUnavailableAgentSkills(report);
}

function formatMissingSkillSummary(skill: SkillStatusEntry): string {
  const missing: string[] = [];
  if (skill.missing.bins.length > 0) {
    missing.push(`bins: ${skill.missing.bins.join(", ")}`);
  }
  if (skill.missing.anyBins.length > 0) {
    missing.push(`any bins: ${skill.missing.anyBins.join(", ")}`);
  }
  if (skill.missing.env.length > 0) {
    missing.push(`env: ${skill.missing.env.join(", ")}`);
  }
  if (skill.missing.config.length > 0) {
    missing.push(`config: ${skill.missing.config.join(", ")}`);
  }
  if (skill.missing.os.length > 0) {
    missing.push(`os: ${skill.missing.os.join(", ")}`);
  }
  return missing.join("; ") || "unknown requirement";
}
