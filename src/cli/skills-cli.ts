// Skills CLI for workspace status, install/update, ClawHub verification, and workshop proposals.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { Command } from "commander";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { formatDocsLink } from "../../packages/terminal-core/src/links.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import {
  resolveConfiguredAgentId,
  resolveAgentIdByWorkspacePath,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import { getRuntimeConfig } from "../config/config.js";
import { resolveGatewayPort } from "../config/paths.js";
import { CLAWHUB_TRUST_ERROR_CODE } from "../infra/clawhub-install-trust.js";
import {
  CLAWHUB_SKILLS_SH_REF_PREFIX,
  CLAWHUB_SKILLS_SH_TRUST_LABEL,
  CLAWHUB_SKILLS_SH_TRUST_STATE,
  fetchClawHubSkillCard,
  type ClawHubSkillVerificationResponse,
} from "../infra/clawhub-skills.js";
import { formatErrorMessage } from "../infra/errors.js";
import { defaultRuntime } from "../runtime.js";
import { resolveSkillStatusEntry, type SkillStatusReport } from "../skills/discovery/status.js";
import {
  installSkillFromClawHub,
  readVerifiedClawHubSkillSourceUrl,
  readTrackedClawHubSkillSlugs,
  resolveClawHubSkillVerificationTarget,
  searchSkillsFromClawHub,
  updateSkillsFromClawHub,
  verifySkillWithClawHub,
} from "../skills/lifecycle/clawhub.js";
import {
  installSkillFromSource,
  isSkillSourceInstallSpec,
} from "../skills/lifecycle/source-install.js";
import {
  getSkillCuratorStatus,
  pinCuratedSkill,
  restoreCuratedSkill,
  type SkillCuratorStatus,
  unpinCuratedSkill,
} from "../skills/workshop/curator.js";
import {
  applySkillProposal,
  inspectSkillProposal,
  listSkillProposals,
  proposeCreateSkill,
  proposeUpdateSkill,
  quarantineSkillProposal,
  readSkillProposalDraftDirectory,
  readSkillProposalDraftFile,
  rejectSkillProposal,
  reviseSkillProposal,
} from "../skills/workshop/service.js";
import type {
  SkillProposalApplyResult,
  SkillProposalEvaluateResult,
  SkillProposalManifest,
  SkillProposalReadResult,
  SkillProposalSupportFileInput,
} from "../skills/workshop/types.js";
import { CONFIG_DIR } from "../utils.js";
import { resolveClawHubRiskAcknowledgementCliOptions } from "./clawhub-risk-acknowledgement.js";
import { resolveOptionFromCommand } from "./cli-utils.js";
import { inheritOptionFromParent } from "./command-options.js";
import { formatCliJsonFailure, rethrowExpectedCliError } from "./failure-output.js";
import { resolveInstallPolicyWarningAcknowledgementCliOptions } from "./install-policy-warning-acknowledgement.js";
import { parseStrictPositiveIntOption } from "./program/helpers.js";
import { setCommandJsonMode } from "./program/json-mode.js";
import { applyParentDefaultHelpAction } from "./program/parent-default-help.js";
import { formatSkillInfo, formatSkillsCheck, formatSkillsList } from "./skills-cli.format.js";
import { isSkillsMachineOutput } from "./skills-output-mode.js";

export type {
  SkillInfoOptions,
  SkillsCheckOptions,
  SkillsListOptions,
} from "./skills-cli.format.js";
export { formatSkillInfo, formatSkillsCheck, formatSkillsList } from "./skills-cli.format.js";

type ResolvedClawHubSkillVerificationTarget = Extract<
  Awaited<ReturnType<typeof resolveClawHubSkillVerificationTarget>>,
  { ok: true }
>;

function resolveSkillClawHubRiskOptions(
  acknowledgeClawHubRisk: boolean,
  action: "installing" | "updating",
) {
  const riskOptions = resolveClawHubRiskAcknowledgementCliOptions({
    acknowledgeClawHubRisk,
    action,
  });
  return {
    ...(riskOptions.acknowledgeClawHubRisk ? { acknowledgeClawHubRisk: true } : {}),
    ...(riskOptions.onClawHubRisk ? { onClawHubRisk: riskOptions.onClawHubRisk } : {}),
  };
}

function formatSkillWarning(message: string): string {
  return message.includes("╭─") ? message : theme.warn(message);
}

function formatClawHubSearchText(value: string): string {
  return sanitizeForLog(value.replace(/\s+/gu, " ")).trim();
}

function isClawHubSkillBlockedCliFailure(result: { code?: string; warning?: string }): boolean {
  return (
    result.code === CLAWHUB_TRUST_ERROR_CODE.CLAWHUB_DOWNLOAD_BLOCKED &&
    typeof result.warning === "string" &&
    result.warning.trim().length > 0
  );
}

type ResolveSkillsWorkspaceOptions = {
  agentId?: string;
  cwd?: string;
  skipPluginValidation?: boolean;
};

type ResolvedSkillsWorkspace = ReturnType<typeof resolveSkillsWorkspace>;
type SkillProposalDraftCliOptions = {
  agent?: string;
  json?: boolean;
  proposal?: string;
  proposalDir?: string;
  description?: string;
  goal?: string;
  evidence?: string;
};

const GATEWAY_SKILLS_STATUS_TIMEOUT_MS = 1_500;
const GATEWAY_SKILLS_EVALUATION_TIMEOUT_MS = 650_000;
const GATEWAY_SKILLS_OFFLINE_LOCK_TIMEOUT_MS = 250;
// Apply can await evaluator, proposal-change, and skill-change hook phases.
const GATEWAY_SKILLS_APPLY_TIMEOUT_MS = 1_850_000;

function normalizeExplicitAgentId(agentId?: string): string | undefined {
  const normalizedAgentId = agentId?.trim();
  if (agentId !== undefined && !normalizedAgentId) {
    throw new Error("--agent must not be blank");
  }
  return normalizedAgentId;
}

function resolveSkillsWorkspace(options?: ResolveSkillsWorkspaceOptions): {
  config: ReturnType<typeof getRuntimeConfig>;
  workspaceDir: string;
  agentId: string;
} {
  // Prefer explicit --agent, then infer from cwd, then fall back to configured default agent.
  const config = getRuntimeConfig(
    options?.skipPluginValidation ? { skipPluginValidation: true } : undefined,
  );
  const explicitAgentId = normalizeExplicitAgentId(options?.agentId);
  const inferredAgentId = explicitAgentId
    ? undefined
    : resolveAgentIdByWorkspacePath(config, options?.cwd ?? process.cwd());
  const agentId = explicitAgentId
    ? resolveConfiguredAgentId(config, explicitAgentId)
    : (inferredAgentId ??
      resolveDefaultAgentId(config, { surface: "the skills command", hint: "Pass --agent <id>." }));
  return {
    config,
    agentId,
    workspaceDir: resolveAgentWorkspaceDir(config, agentId),
  };
}

function resolveAgentOption(
  command: Command | undefined,
  opts?: { agent?: string },
): string | undefined {
  return resolveOptionFromCommand<string>(command, "agent") ?? opts?.agent;
}

async function loadGatewaySkillsStatusReport(
  resolved: ResolvedSkillsWorkspace,
): Promise<SkillStatusReport | null> {
  try {
    const { callGateway } = await import("../gateway/call.js");
    return await callGateway<SkillStatusReport>({
      config: resolved.config,
      method: "skills.status",
      params: { agentId: resolved.agentId },
      timeoutMs: GATEWAY_SKILLS_STATUS_TIMEOUT_MS,
      clientName: GATEWAY_CLIENT_NAMES.CLI,
      mode: GATEWAY_CLIENT_MODES.CLI,
    });
  } catch {
    return null;
  }
}

async function loadSkillsStatusReport(
  options?: ResolveSkillsWorkspaceOptions,
): Promise<SkillStatusReport> {
  const resolved = resolveSkillsWorkspace({ ...options, skipPluginValidation: true });
  const gatewayReport = await loadGatewaySkillsStatusReport(resolved);
  if (gatewayReport) {
    return gatewayReport;
  }
  const { buildWorkspaceSkillStatus } = await import("../skills/discovery/status.js");
  return buildWorkspaceSkillStatus(resolved.workspaceDir, {
    config: resolved.config,
    agentId: resolved.agentId,
  });
}

async function runSkillsAction(
  render: (report: SkillStatusReport) => string,
  options?: ResolveSkillsWorkspaceOptions,
): Promise<void> {
  try {
    const report = await loadSkillsStatusReport(options);
    defaultRuntime.writeStdout(render(report));
  } catch (err) {
    defaultRuntime.error(formatErrorMessage(err));
    defaultRuntime.exit(1);
  }
}

function resolveSkillsWorkspaceForCommand(
  command: Command | null | undefined,
  opts?: { agent?: string },
): ReturnType<typeof resolveSkillsWorkspace> {
  return resolveSkillsWorkspace({ agentId: resolveAgentOption(command ?? undefined, opts) });
}

function resolveClawHubTargetWorkspace(
  command: Command | undefined,
  opts: { agent?: string; global?: boolean },
  reportError: (message: string) => void = defaultRuntime.error,
): Pick<ResolvedSkillsWorkspace, "config" | "workspaceDir"> | undefined {
  const agentId = normalizeExplicitAgentId(resolveAgentOption(command, opts));
  if (opts.global && agentId) {
    reportError("Use either --global or --agent, not both.");
    defaultRuntime.exit(1);
    return undefined;
  }
  if (opts.global) {
    return { config: getRuntimeConfig(), workspaceDir: CONFIG_DIR };
  }
  return resolveSkillsWorkspace({ agentId });
}

function shouldFailSkillVerification(result: ClawHubSkillVerificationResponse): boolean {
  const envelope = result as { ok: unknown; decision: unknown };
  return envelope.ok !== true || envelope.decision !== "pass";
}

function buildSkillVerificationOutput(
  result: ClawHubSkillVerificationResponse,
  target: ResolvedClawHubSkillVerificationTarget,
): Record<string, unknown> {
  const verifiedSourceUrl = readVerifiedClawHubSkillSourceUrl(result.provenance);
  return {
    ...result,
    openclaw: {
      resolution: {
        source: target.resolution.source,
        selector: target.resolution.selector,
        registry: target.resolution.registry,
        installedVersion: target.resolution.installedVersion,
        ...(target.requestedReference ? { reference: target.requestedReference } : {}),
      },
      ...(target.trustState
        ? {
            trust: {
              state: target.trustState,
              label: CLAWHUB_SKILLS_SH_TRUST_LABEL,
            },
          }
        : {}),
      ...(verifiedSourceUrl ? { verifiedSourceUrl } : {}),
    },
  };
}

function readVerifiedSkillCardUrl(
  result: ClawHubSkillVerificationResponse,
): { ok: true; url: string } | { ok: false; error: string } {
  if (!result.card || typeof result.card !== "object" || Array.isArray(result.card)) {
    return { ok: false, error: "ClawHub verification response did not include a Skill Card URL." };
  }
  const card = result.card as { available?: unknown; url?: unknown };
  if (card.available === false) {
    return { ok: false, error: "Skill Card is not available." };
  }
  const url = normalizeOptionalString(card.url);
  if (!url) {
    return { ok: false, error: "ClawHub verification response did not include a Skill Card URL." };
  }
  return { ok: true, url };
}

function formatSkillProposalList(manifest: SkillProposalManifest): string {
  if (manifest.proposals.length === 0) {
    return "No skill proposals.\n";
  }
  return `${manifest.proposals
    .map(
      (entry) =>
        `${entry.id}  ${entry.status}  ${entry.kind}  ${entry.skillKey}  ${entry.title}${entry.workspaceMismatch ? "  [previous workspace]" : ""}`,
    )
    .join("\n")}\n`;
}

function formatSkillProposalInspect(read: SkillProposalReadResult): string {
  const { record } = read;
  const supportFiles =
    read.supportFiles && read.supportFiles.length > 0
      ? [
          "",
          "Support files:",
          ...read.supportFiles.flatMap((file) => ["", `--- ${file.path} ---`, file.content]),
        ]
      : [];
  return [
    `ID: ${record.id}`,
    `Status: ${record.status}`,
    `Kind: ${record.kind}`,
    `Skill: ${record.target.skillName}`,
    `Target: ${record.target.skillFile}`,
    `Scanner: ${record.scan.state}`,
    record.statusReason ? `Reason: ${record.statusReason}` : undefined,
    "",
    read.content,
    ...supportFiles,
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

function formatSkillProposalEvaluation(result: SkillProposalEvaluateResult): string {
  const lines = [
    `Proposal: ${result.record.id}`,
    `Proposed version: ${result.evaluation.proposedVersion}`,
    `Revision hash: ${result.evaluation.revisionHash}`,
    `Evaluators: ${result.evaluation.outcomes.length}`,
  ];
  for (const outcome of result.evaluation.outcomes) {
    const plugin = outcome.pluginVersion
      ? `${outcome.pluginId}@${outcome.pluginVersion}`
      : outcome.pluginId;
    const prefix = `${outcome.evaluatorId} (${plugin})`;
    if (outcome.status === "completed") {
      const decision = outcome.result.decision ? ` ${outcome.result.decision}` : "";
      const summary = outcome.result.summary ? `: ${outcome.result.summary}` : "";
      lines.push(`${prefix}  completed${decision}${summary}`);
      continue;
    }
    if (outcome.status === "error") {
      lines.push(`${prefix}  error: ${outcome.error}`);
      continue;
    }
    lines.push(`${prefix}  skipped`);
  }
  return `${lines.join("\n")}\n`;
}

function formatSkillCuratorStatus(status: SkillCuratorStatus): string {
  const timestamp = (value: number | null) =>
    value === null ? "never" : new Date(value).toISOString();
  const lines = [
    `Last attempt: ${timestamp(status.lastAttemptAtMs)}`,
    `Last success: ${timestamp(status.lastSuccessAtMs)}`,
    `Counts: ${status.counts.active} active, ${status.counts.stale} stale, ${status.counts.archived} archived`,
  ];
  if (status.lastError) {
    lines.push(`Last error: ${status.lastError}`);
  }
  const keyCounts = new Map<string, number>();
  for (const skill of status.skills) {
    keyCounts.set(skill.skillKey, (keyCounts.get(skill.skillKey) ?? 0) + 1);
  }
  for (const skill of status.skills) {
    const pinned = skill.pinned ? " pinned" : "";
    const lastUsed =
      skill.lastUsedAtMs === null ? "never" : new Date(skill.lastUsedAtMs).toISOString();
    const label =
      keyCounts.get(skill.skillKey) === 1
        ? skill.skillKey
        : `${skill.skillKey} (${skill.skillFile})`;
    lines.push(`${label}  ${skill.state}${pinned}  last-used=${lastUsed}  uses=${skill.useCount}`);
  }
  for (const overlap of status.overlaps) {
    lines.push(`Legacy overlap: ${overlap.left} ~ ${overlap.right}`);
  }
  return `${lines.join("\n")}\n`;
}

async function loadGatewaySkillCuratorStatus(
  config: ReturnType<typeof getRuntimeConfig>,
): Promise<SkillCuratorStatus | null> {
  try {
    const { callGateway } = await import("../gateway/call.js");
    return await callGateway<SkillCuratorStatus>({
      config,
      method: "skills.curator.status",
      params: {},
      timeoutMs: GATEWAY_SKILLS_STATUS_TIMEOUT_MS,
      clientName: GATEWAY_CLIENT_NAMES.CLI,
      mode: GATEWAY_CLIENT_MODES.CLI,
    });
  } catch (err) {
    if (config.gateway?.mode === "remote") {
      throw err;
    }
    return null;
  }
}

async function loadSkillCuratorStatus(): Promise<SkillCuratorStatus> {
  const config = getRuntimeConfig();
  return (await loadGatewaySkillCuratorStatus(config)) ?? getSkillCuratorStatus();
}

async function runSkillCuratorMutation(method: "pin" | "restore" | "unpin", skill: string) {
  const config = getRuntimeConfig();
  try {
    const { callGateway } = await import("../gateway/call.js");
    return await callGateway<SkillCuratorStatus["skills"][number]>({
      config,
      method: `skills.curator.${method}`,
      params: { skill },
      timeoutMs: GATEWAY_SKILLS_STATUS_TIMEOUT_MS,
      clientName: GATEWAY_CLIENT_NAMES.CLI,
      mode: GATEWAY_CLIENT_MODES.CLI,
    });
  } catch (err) {
    if (config.gateway?.mode === "remote") {
      throw err;
    }
  }
  if (method === "pin") {
    return pinCuratedSkill(skill);
  }
  if (method === "unpin") {
    return unpinCuratedSkill(skill);
  }
  return restoreCuratedSkill(skill);
}

async function runSkillProposalApply(
  resolved: ResolvedSkillsWorkspace,
  proposalId: string,
): Promise<SkillProposalApplyResult> {
  const { callGateway, isGatewayCredentialsRequiredError, isGatewayTransportError } =
    await import("../gateway/call.js");
  let proposal: SkillProposalReadResult;
  try {
    // Decide offline fallback before dispatching the non-idempotent mutation.
    // Once a Gateway answers, apply failures must never be replayed locally.
    proposal = await callGateway<SkillProposalReadResult>({
      config: resolved.config,
      method: "skills.proposals.inspect",
      params: { agentId: resolved.agentId, proposalId },
      timeoutMs: GATEWAY_SKILLS_STATUS_TIMEOUT_MS,
      clientName: GATEWAY_CLIENT_NAMES.CLI,
      mode: GATEWAY_CLIENT_MODES.CLI,
      requiredMethods: ["skills.proposals.apply"],
    });
  } catch (err) {
    const isOfflineCandidate =
      isGatewayCredentialsRequiredError(err) ||
      (isGatewayTransportError(err) && err.kind === "closed" && err.code === 1006);
    if (resolved.config.gateway?.mode === "remote" || !isOfflineCandidate) {
      throw err;
    }

    // Hold the canonical Gateway ownership locks across local mutation. This
    // makes offline apply atomic with Gateway startup, so a new process cannot
    // inherit a stale process-local skill snapshot.
    const { acquireGatewayLock } = await import("../infra/gateway-lock.js");
    let lock: Awaited<ReturnType<typeof acquireGatewayLock>>;
    try {
      lock = await acquireGatewayLock({
        allowInTests: true,
        port: resolveGatewayPort(resolved.config, process.env),
        role: "skill-workshop-apply",
        timeoutMs: GATEWAY_SKILLS_OFFLINE_LOCK_TIMEOUT_MS,
      });
    } catch {
      throw err;
    }
    if (!lock) {
      throw err;
    }
    try {
      const reviewedProposal = await inspectSkillProposal(proposalId, {
        agentId: resolved.agentId,
        workspaceDir: resolved.workspaceDir,
      });
      if (!reviewedProposal) {
        throw new Error(`Skill proposal not found: ${proposalId}`, { cause: err });
      }
      return await applySkillProposal({
        agentId: resolved.agentId,
        eventActor: { type: "system", id: "cli" },
        workspaceDir: resolved.workspaceDir,
        config: resolved.config,
        proposalId,
        expectedRevisionHash: reviewedProposal.revisionHash,
      });
    } finally {
      await lock.release();
    }
  }

  return await callGateway<SkillProposalApplyResult>({
    config: resolved.config,
    method: "skills.proposals.apply",
    params: {
      agentId: resolved.agentId,
      proposalId,
      expectedRevisionHash: proposal.revisionHash,
    },
    timeoutMs: GATEWAY_SKILLS_APPLY_TIMEOUT_MS,
    clientName: GATEWAY_CLIENT_NAMES.CLI,
    mode: GATEWAY_CLIENT_MODES.CLI,
  });
}

async function runSkillProposalEvaluate(
  resolved: ResolvedSkillsWorkspace,
  proposalId: string,
  correlationId?: string,
): Promise<SkillProposalEvaluateResult> {
  const { callGateway } = await import("../gateway/call.js");
  const proposal = await callGateway<SkillProposalReadResult>({
    config: resolved.config,
    method: "skills.proposals.inspect",
    params: { agentId: resolved.agentId, proposalId },
    timeoutMs: GATEWAY_SKILLS_STATUS_TIMEOUT_MS,
    clientName: GATEWAY_CLIENT_NAMES.CLI,
    mode: GATEWAY_CLIENT_MODES.CLI,
  });
  return await callGateway<SkillProposalEvaluateResult>({
    config: resolved.config,
    method: "skills.proposals.evaluate",
    params: {
      agentId: resolved.agentId,
      proposalId,
      expectedRevisionHash: proposal.revisionHash,
      ...(correlationId ? { correlationId } : {}),
    },
    timeoutMs: GATEWAY_SKILLS_EVALUATION_TIMEOUT_MS,
    clientName: GATEWAY_CLIENT_NAMES.CLI,
    mode: GATEWAY_CLIENT_MODES.CLI,
  });
}

async function readSkillProposalInput(options: {
  proposal?: string;
  proposalDir?: string;
}): Promise<{ content: string; supportFiles?: SkillProposalSupportFileInput[] }> {
  const proposal = normalizeOptionalString(options.proposal);
  const proposalDir = normalizeOptionalString(options.proposalDir);
  if (proposal && proposalDir) {
    throw new Error("Use either --proposal or --proposal-dir, not both.");
  }
  if (!proposal && !proposalDir) {
    throw new Error("Provide --proposal or --proposal-dir.");
  }
  if (proposalDir) {
    return await readSkillProposalDraftDirectory(proposalDir);
  }
  return { content: await readSkillProposalDraftFile(proposal!) };
}

/**
 * Register the skills CLI commands
 */
export function registerSkillsCli(program: Command) {
  const skills = program
    .command("skills")
    .description("List and inspect available skills")
    .option("--agent <id>", "Target agent workspace (defaults to cwd-inferred, then default agent)")
    .option("--json", "Output as JSON", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/skills", "docs.openclaw.ai/cli/skills")}\n`,
    );
  const hasJsonOutput = (opts?: { json?: boolean }): boolean =>
    Boolean(opts?.json || skills.opts<{ json?: boolean }>().json);
  setCommandJsonMode(skills, "output", ({ argv }) => isSkillsMachineOutput(argv));

  skills
    .command("search")
    .description("Search ClawHub skills")
    .argument("[query...]", "Optional search query")
    .option("--limit <n>", "Max results", (value) => parseStrictPositiveIntOption(value, "--limit"))
    .option("--json", "Output as JSON", false)
    .action(async (queryParts: string[], opts: { limit?: number; json?: boolean }) => {
      try {
        const results = await searchSkillsFromClawHub({
          query: normalizeOptionalString(queryParts.join(" ")),
          limit: opts.limit,
        });
        if (hasJsonOutput(opts)) {
          defaultRuntime.writeJson({ results });
          return;
        }
        if (results.length === 0) {
          defaultRuntime.log("No ClawHub skills found.");
          return;
        }
        for (const entry of results) {
          const installRef = normalizeOptionalString(entry.installRef);
          const skillRef = formatClawHubSearchText(installRef ?? entry.slug);
          const isExternalSource =
            installRef?.startsWith(CLAWHUB_SKILLS_SH_REF_PREFIX) === true &&
            entry.trustState === CLAWHUB_SKILLS_SH_TRUST_STATE;
          const version = entry.version ? ` v${formatClawHubSearchText(entry.version)}` : "";
          const summary = entry.summary ? `  ${formatClawHubSearchText(entry.summary)}` : "";
          const displayName = formatClawHubSearchText(entry.displayName);
          const trust = isExternalSource ? `  ${CLAWHUB_SKILLS_SH_TRUST_LABEL}` : "";
          defaultRuntime.log(`${skillRef}${version}  ${displayName}${summary}${trust}`);
        }
      } catch (err) {
        defaultRuntime.error(formatErrorMessage(err));
        defaultRuntime.exit(1);
      }
    });

  skills
    .command("install")
    .description("Install a skill from ClawHub, git, or a local directory")
    .argument(
      "<skill-ref>",
      "ClawHub skill ref (@owner/slug or skills-sh:owner/repo/slug), git:<repo>, or local skill directory",
    )
    .option("--version <version>", "Install a specific version")
    .option("--force", "Overwrite an existing workspace skill", false)
    .option(
      "--force-install",
      "Install a pending GitHub-backed skill before ClawHub scan completes",
      false,
    )
    .option(
      "--acknowledge-clawhub-risk",
      "Acknowledge ClawHub release trust warnings without prompting",
      false,
    )
    .option(
      "--acknowledge-install-policy-warning",
      "Acknowledge security.installPolicy warnings without prompting; blocks and failures remain terminal",
      false,
    )
    .option("--global", "Install into the shared managed skills directory", false)
    .option("--agent <id>", "Target agent workspace (defaults to cwd-inferred, then default agent)")
    .option("--as <slug>", "Install a git/local skill under this slug")
    .addHelpText(
      "after",
      "\nExamples:\n  openclaw skills install @owner/weather\n  openclaw skills install skills-sh:owner/repo/weather\n",
    )
    .action(
      async (
        slug: string,
        opts: {
          version?: string;
          force?: boolean;
          forceInstall?: boolean;
          acknowledgeClawhubRisk?: boolean;
          acknowledgeClawHubRisk?: boolean;
          acknowledgeInstallPolicyWarning?: boolean;
          global?: boolean;
          agent?: string;
          as?: string;
        },
        command: Command,
      ) => {
        try {
          const target = resolveClawHubTargetWorkspace(command, opts);
          if (!target) {
            return;
          }
          const { config, workspaceDir } = target;
          if (slug.trim().startsWith("skills-sh/")) {
            defaultRuntime.error(`Invalid skills.sh skill reference: ${slug}`);
            defaultRuntime.exit(1);
            return;
          }
          if (isSkillSourceInstallSpec(slug)) {
            if (opts.version) {
              defaultRuntime.error("--version is only supported for ClawHub skill installs.");
              defaultRuntime.exit(1);
              return;
            }
            const result = await installSkillFromSource({
              workspaceDir,
              spec: slug,
              slug: opts.as,
              force: Boolean(opts.force),
              config,
              ...resolveInstallPolicyWarningAcknowledgementCliOptions({
                acknowledgeInstallPolicyWarning: opts.acknowledgeInstallPolicyWarning,
              }),
              logger: {
                info: (message) => defaultRuntime.log(message),
                warn: (message) => defaultRuntime.log(formatSkillWarning(message)),
              },
            });
            if (!result.ok) {
              defaultRuntime.error(result.error);
              defaultRuntime.exit(1);
              return;
            }
            defaultRuntime.log(
              `Installed ${result.slug} from ${result.source} -> ${result.targetDir}`,
            );
            return;
          }
          if (opts.as) {
            defaultRuntime.error(
              "--as is only supported for git and local directory skill installs.",
            );
            defaultRuntime.exit(1);
            return;
          }
          if (slug.trim().startsWith(CLAWHUB_SKILLS_SH_REF_PREFIX) && opts.version) {
            defaultRuntime.error("--version is not supported for skills-sh references.");
            defaultRuntime.exit(1);
            return;
          }
          const result = await installSkillFromClawHub({
            workspaceDir,
            slug,
            version: opts.version,
            force: Boolean(opts.force),
            config,
            ...resolveInstallPolicyWarningAcknowledgementCliOptions({
              acknowledgeInstallPolicyWarning: opts.acknowledgeInstallPolicyWarning,
            }),
            ...(opts.forceInstall ? { forceInstall: true } : {}),
            ...resolveSkillClawHubRiskOptions(
              opts.acknowledgeClawhubRisk === true || opts.acknowledgeClawHubRisk === true,
              "installing",
            ),
            logger: {
              info: (message) => defaultRuntime.log(message),
              warn: (message) => defaultRuntime.log(formatSkillWarning(message)),
            },
          });
          if (!result.ok) {
            if (!isClawHubSkillBlockedCliFailure(result)) {
              defaultRuntime.error(result.error);
            }
            defaultRuntime.exit(1);
            return;
          }
          defaultRuntime.log(`Installed ${result.slug}@${result.version} -> ${result.targetDir}`);
        } catch (err) {
          defaultRuntime.error(formatErrorMessage(err));
          defaultRuntime.exit(1);
        }
      },
    );

  skills
    .command("update")
    .description("Update ClawHub-installed skills in the active or shared managed directory")
    .argument("[skill-ref]", "Single ClawHub skill ref (@owner/slug)")
    .option("--all", "Update all tracked ClawHub skills", false)
    .option(
      "--force-install",
      "Install a pending GitHub-backed skill before ClawHub scan completes",
      false,
    )
    .option(
      "--acknowledge-clawhub-risk",
      "Acknowledge ClawHub release trust warnings without prompting",
      false,
    )
    .option(
      "--acknowledge-install-policy-warning",
      "Acknowledge security.installPolicy warnings without prompting; blocks and failures remain terminal",
      false,
    )
    .option("--global", "Update skills in the shared managed skills directory", false)
    .option("--agent <id>", "Target agent workspace (defaults to cwd-inferred, then default agent)")
    .action(
      async (
        slug: string | undefined,
        opts: {
          all?: boolean;
          forceInstall?: boolean;
          acknowledgeClawhubRisk?: boolean;
          acknowledgeClawHubRisk?: boolean;
          acknowledgeInstallPolicyWarning?: boolean;
          global?: boolean;
          agent?: string;
        },
        command: Command,
      ) => {
        try {
          if (!slug && !opts.all) {
            defaultRuntime.error("Provide a skill slug or use --all.");
            defaultRuntime.exit(1);
            return;
          }
          if (slug && opts.all) {
            defaultRuntime.error("Use either a skill slug or --all.");
            defaultRuntime.exit(1);
            return;
          }
          const target = resolveClawHubTargetWorkspace(command, opts);
          if (!target) {
            return;
          }
          const tracked = await readTrackedClawHubSkillSlugs(target.workspaceDir);
          if (opts.all && tracked.length === 0) {
            defaultRuntime.log("No tracked ClawHub skills to update.");
            return;
          }
          const results = await updateSkillsFromClawHub({
            workspaceDir: target.workspaceDir,
            slug,
            ...(opts.forceInstall ? { forceInstall: true } : {}),
            ...resolveInstallPolicyWarningAcknowledgementCliOptions({
              acknowledgeInstallPolicyWarning: opts.acknowledgeInstallPolicyWarning,
            }),
            ...resolveSkillClawHubRiskOptions(
              opts.acknowledgeClawhubRisk === true || opts.acknowledgeClawHubRisk === true,
              "updating",
            ),
            logger: {
              info: (message) => defaultRuntime.log(message),
              warn: (message) => defaultRuntime.log(formatSkillWarning(message)),
            },
            config: target.config,
          });
          let failed = false;
          for (const result of results) {
            if (!result.ok) {
              failed = true;
              if (!isClawHubSkillBlockedCliFailure(result)) {
                defaultRuntime.error(result.error);
              }
              continue;
            }
            if (result.changed) {
              defaultRuntime.log(
                `Updated ${result.slug}: ${result.previousVersion ?? "unknown"} -> ${result.version}`,
              );
              continue;
            }
            defaultRuntime.log(`${result.slug} already at ${result.version}`);
          }
          if (failed) {
            defaultRuntime.exit(1);
          }
        } catch (err) {
          defaultRuntime.error(formatErrorMessage(err));
          defaultRuntime.exit(1);
        }
      },
    );

  skills
    .command("verify")
    .description("Verify a ClawHub skill with ClawHub")
    .argument("<skill-ref>", "ClawHub skill ref (@owner/slug)")
    .option("--version <version>", "Verify a specific version")
    .option("--tag <tag>", "Verify a dist tag")
    .option("--card", "Print the generated Skill Card Markdown", false)
    .option("--json", "Output as JSON", false)
    .option(
      "--global",
      "Resolve installed skill metadata from the shared managed skills directory",
      false,
    )
    .option("--agent <id>", "Target agent workspace (defaults to cwd-inferred, then default agent)")
    .addHelpText("after", "\nExamples:\n  openclaw skills verify @owner/weather\n")
    .action(
      async (
        slug: string,
        opts: {
          version?: string;
          tag?: string;
          card?: boolean;
          json?: boolean;
          global?: boolean;
          agent?: string;
        },
        command: Command,
      ) => {
        let exitCode: number | undefined;
        const reportError =
          hasJsonOutput(opts) || opts.card !== true
            ? (message: string) => defaultRuntime.writeJson(formatCliJsonFailure(message))
            : defaultRuntime.error;
        try {
          const workspace = resolveClawHubTargetWorkspace(command, opts, reportError);
          if (!workspace) {
            return;
          }
          const target = await resolveClawHubSkillVerificationTarget({
            workspaceDir: workspace.workspaceDir,
            slug,
            version: opts.version,
            tag: opts.tag,
          });
          if (!target.ok) {
            reportError(target.error);
            exitCode = 1;
          } else {
            const result = await verifySkillWithClawHub({
              slug: target.slug,
              ...(target.ownerHandle ? { ownerHandle: target.ownerHandle } : {}),
              ...(target.requestedReference
                ? { requestedReference: target.requestedReference }
                : {}),
              version: target.version,
              tag: target.tag,
              baseUrl: target.baseUrl,
            });
            if (!result.ok) {
              reportError(result.error);
              exitCode = 1;
            } else if (opts.card && !hasJsonOutput(opts)) {
              const verification = result.value;
              const cardUrl = readVerifiedSkillCardUrl(verification);
              if (!cardUrl.ok) {
                reportError(cardUrl.error);
                exitCode = 1;
              } else {
                const card = await fetchClawHubSkillCard({
                  url: cardUrl.url,
                  baseUrl: target.baseUrl,
                });
                defaultRuntime.writeStdout(card.endsWith("\n") ? card : `${card}\n`);
                exitCode = shouldFailSkillVerification(verification) ? 1 : undefined;
              }
            } else {
              const verification = result.value;
              defaultRuntime.writeJson(buildSkillVerificationOutput(verification, target));
              exitCode = shouldFailSkillVerification(verification) ? 1 : undefined;
            }
          }
        } catch (err) {
          reportError(formatErrorMessage(err));
          defaultRuntime.exit(1);
          return;
        }
        if (exitCode) {
          defaultRuntime.exit(exitCode);
        }
      },
    );

  const curator = skills
    .command("curator")
    .description("Inspect and manage skill lifecycle curation")
    .option("--json", "Output as JSON", false);

  const showCuratorStatus = async (opts: { json?: boolean }, command: Command) => {
    try {
      const status = await loadSkillCuratorStatus();
      if (hasJsonOutput(opts) || inheritOptionFromParent<boolean>(command, "json")) {
        defaultRuntime.writeJson(status);
        return;
      }
      defaultRuntime.writeStdout(formatSkillCuratorStatus(status));
    } catch (err) {
      rethrowExpectedCliError(err);
      defaultRuntime.error(formatErrorMessage(err));
      defaultRuntime.exit(1);
    }
  };

  curator
    .command("status")
    .description("Show curator run and lifecycle status")
    .action(showCuratorStatus);

  for (const action of ["pin", "unpin", "restore"] as const) {
    curator
      .command(action)
      .description(`${action} a curated skill`)
      .argument("<skill>", "Skill name or key")
      .action(async (skill: string, opts: { json?: boolean }, command: Command) => {
        try {
          const result = await runSkillCuratorMutation(action, skill);
          if (hasJsonOutput(opts) || inheritOptionFromParent<boolean>(command, "json")) {
            defaultRuntime.writeJson(result);
            return;
          }
          defaultRuntime.writeStdout(
            `${action[0]?.toUpperCase()}${action.slice(1)} ${result.skillKey}\n`,
          );
        } catch (err) {
          rethrowExpectedCliError(err);
          defaultRuntime.error(formatErrorMessage(err));
          defaultRuntime.exit(1);
        }
      });
  }
  for (const command of curator.commands) {
    command.option("--json", "Output as JSON", false);
  }

  curator.action(() => showCuratorStatus(curator.opts(), curator));

  const workshop = skills
    .command("workshop")
    .description("Manage pending skill proposals")
    .option(
      "--agent <id>",
      "Target agent workspace (defaults to cwd-inferred, then default agent)",
    );

  const runWorkshopAction = async <T>(
    opts: { agent?: string; json?: boolean },
    command: Command,
    action: (resolved: ResolvedSkillsWorkspace) => Promise<T>,
    format: (result: T) => string,
  ): Promise<void> => {
    try {
      const result = await action(resolveSkillsWorkspaceForCommand(command, opts));
      if (hasJsonOutput(opts)) {
        defaultRuntime.writeJson(result);
        return;
      }
      defaultRuntime.writeStdout(format(result));
    } catch (err) {
      rethrowExpectedCliError(err);
      defaultRuntime.error(formatErrorMessage(err));
      defaultRuntime.exit(1);
    }
  };

  const runWorkshopDraftAction = (
    opts: SkillProposalDraftCliOptions,
    command: Command,
    action: (
      input: Omit<Parameters<typeof proposeUpdateSkill>[0], "skillName" | "content"> & {
        content: string;
      },
    ) => Promise<SkillProposalReadResult>,
    format: (proposal: SkillProposalReadResult) => string = (proposal) => `${proposal.record.id}\n`,
  ): Promise<void> =>
    runWorkshopAction(
      opts,
      command,
      async ({ config, workspaceDir, agentId }) => {
        const draft = await readSkillProposalInput(opts);
        return await action({
          workspaceDir,
          agentId,
          eventActor: { type: "system", id: "cli" },
          config,
          content: draft.content,
          supportFiles: draft.supportFiles,
          description: opts.description,
          goal: opts.goal,
          evidence: opts.evidence,
        });
      },
      format,
    );

  workshop
    .command("list")
    .description("List pending and completed skill proposals")
    .option("--json", "Output as JSON", false)
    .action((opts: { json?: boolean; agent?: string }, command: Command) =>
      runWorkshopAction(
        opts,
        command,
        ({ agentId, workspaceDir }) => listSkillProposals({ agentId, workspaceDir }),
        formatSkillProposalList,
      ),
    );

  workshop
    .command("inspect")
    .description("Inspect a skill proposal")
    .argument("<proposal-id>", "Skill proposal id")
    .option("--json", "Output as JSON", false)
    .action(
      async (proposalId: string, opts: { json?: boolean; agent?: string }, command: Command) => {
        try {
          const { agentId, workspaceDir } = resolveSkillsWorkspaceForCommand(command, opts);
          const proposal = await inspectSkillProposal(proposalId, { agentId, workspaceDir });
          if (!proposal) {
            defaultRuntime.error(`Skill proposal not found: ${proposalId}`);
            defaultRuntime.exit(1);
            return;
          }
          if (hasJsonOutput(opts)) {
            defaultRuntime.writeJson(proposal);
            return;
          }
          defaultRuntime.writeStdout(formatSkillProposalInspect(proposal));
        } catch (err) {
          defaultRuntime.error(formatErrorMessage(err));
          defaultRuntime.exit(1);
        }
      },
    );

  workshop
    .command("propose-create")
    .description("Create a pending proposal for a new workspace skill")
    .requiredOption("--name <name>", "Skill name")
    .requiredOption("--description <description>", "Skill description")
    .option("--proposal <path>", "Path to PROPOSAL.md draft content")
    .option(
      "--proposal-dir <path>",
      "Path to proposal directory with PROPOSAL.md and UTF-8 text support files",
    )
    .option("--goal <text>", "Proposal or improvement goal")
    .option("--evidence <text>", "Evidence or notes for the proposal")
    .option("--json", "Output as JSON", false)
    .action(
      (
        opts: SkillProposalDraftCliOptions & { name: string; description: string },
        command: Command,
      ) =>
        runWorkshopDraftAction(opts, command, (input) =>
          proposeCreateSkill({
            ...input,
            name: opts.name,
            description: opts.description,
            createdBy: "cli",
          }),
        ),
    );

  workshop
    .command("propose-update")
    .description("Create a pending proposal for an existing workspace skill")
    .argument("<skill>", "Skill name or key")
    .option("--proposal <path>", "Path to PROPOSAL.md draft content")
    .option(
      "--proposal-dir <path>",
      "Path to proposal directory with PROPOSAL.md and UTF-8 text support files",
    )
    .option("--description <text>", "Concise proposal description")
    .option("--goal <text>", "Proposal or improvement goal")
    .option("--evidence <text>", "Evidence or notes for the proposal")
    .option("--json", "Output as JSON", false)
    .action((skill: string, opts: SkillProposalDraftCliOptions, command: Command) =>
      runWorkshopDraftAction(opts, command, (input) =>
        proposeUpdateSkill({ ...input, skillName: skill, createdBy: "cli" }),
      ),
    );

  workshop
    .command("revise")
    .description("Revise a pending skill proposal")
    .argument("<proposal-id>", "Skill proposal id")
    .option("--proposal <path>", "Path to revised PROPOSAL.md draft content")
    .option(
      "--proposal-dir <path>",
      "Path to revised proposal directory with PROPOSAL.md and UTF-8 text support files",
    )
    .option("--description <description>", "Replacement proposal description")
    .option("--goal <text>", "Replacement research or improvement goal")
    .option("--evidence <text>", "Replacement evidence or notes for the proposal")
    .option("--json", "Output as JSON", false)
    .action((proposalId: string, opts: SkillProposalDraftCliOptions, command: Command) =>
      runWorkshopDraftAction(
        opts,
        command,
        (input) => reviseSkillProposal({ ...input, proposalId }),
        (proposal) => `Revised ${proposal.record.id} ${proposal.record.proposedVersion}\n`,
      ),
    );

  workshop
    .command("evaluate")
    .description("Evaluate the exact current skill proposal through Gateway plugins")
    .argument("<proposal-id>", "Skill proposal id")
    .option("--correlation-id <id>", "External run or experiment correlation id")
    .option("--json", "Output as JSON", false)
    .action(
      (
        proposalId: string,
        opts: { correlationId?: string; json?: boolean; agent?: string },
        command: Command,
      ) =>
        runWorkshopAction(
          opts,
          command,
          (resolved) =>
            runSkillProposalEvaluate(
              resolved,
              proposalId,
              normalizeOptionalString(opts.correlationId),
            ),
          formatSkillProposalEvaluation,
        ),
    );

  workshop
    .command("apply")
    .description("Apply a pending skill proposal")
    .argument("<proposal-id>", "Skill proposal id")
    .option("--json", "Output as JSON", false)
    .action((proposalId: string, opts: { json?: boolean; agent?: string }, command: Command) =>
      runWorkshopAction(
        opts,
        command,
        (resolved) => runSkillProposalApply(resolved, proposalId),
        (applied) => `Applied ${applied.record.id} -> ${applied.targetSkillFile}\n`,
      ),
    );

  for (const [name, description, reasonDescription, verb, action] of [
    [
      "reject",
      "Reject a pending skill proposal",
      "Reason for rejection",
      "Rejected",
      rejectSkillProposal,
    ],
    [
      "quarantine",
      "Quarantine a skill proposal",
      "Reason for quarantine",
      "Quarantined",
      quarantineSkillProposal,
    ],
  ] as const) {
    workshop
      .command(name)
      .description(description)
      .argument("<proposal-id>", "Skill proposal id")
      .option("--reason <text>", reasonDescription)
      .option("--json", "Output as JSON", false)
      .action(
        (
          proposalId: string,
          opts: { reason?: string; json?: boolean; agent?: string },
          command: Command,
        ) =>
          runWorkshopAction(
            opts,
            command,
            async ({ agentId, workspaceDir }) => {
              const reviewed =
                name === "reject"
                  ? await inspectSkillProposal(proposalId, { agentId, workspaceDir })
                  : undefined;
              if (name === "reject" && !reviewed) {
                throw new Error(`Skill proposal not found: ${proposalId}`);
              }
              return action({
                agentId,
                eventActor: { type: "system", id: "cli" },
                workspaceDir,
                proposalId,
                ...(reviewed ? { expectedRevisionHash: reviewed.revisionHash } : {}),
                reason: opts.reason,
              });
            },
            (record) => `${verb} ${record.id}\n`,
          ),
      );
  }

  for (const command of workshop.commands) {
    command.option(
      "--agent <id>",
      "Target agent workspace (defaults to cwd-inferred, then default agent)",
    );
  }
  applyParentDefaultHelpAction(workshop);

  skills
    .command("list")
    .description("List all available skills")
    .option("--json", "Output as JSON", false)
    .option("--eligible", "Show only eligible (ready to use) skills", false)
    .option("-v, --verbose", "Show more details including missing requirements", false)
    .option("--agent <id>", "Target agent workspace (defaults to cwd-inferred, then default agent)")
    .action(
      async (
        opts: { json?: boolean; eligible?: boolean; verbose?: boolean; agent?: string },
        command: Command,
      ) => {
        await runSkillsAction(
          (report) =>
            formatSkillsList(report, {
              ...opts,
              json: hasJsonOutput(opts),
            }),
          {
            agentId: resolveAgentOption(command, opts),
          },
        );
      },
    );

  skills
    .command("info")
    .description("Show detailed information about a skill")
    .argument("<name>", "Skill name")
    .option("--json", "Output as JSON", false)
    .option("--agent <id>", "Target agent workspace (defaults to cwd-inferred, then default agent)")
    .action(async (name: string, opts: { json?: boolean; agent?: string }, command: Command) => {
      let skillFound = false;
      await runSkillsAction(
        (report) => {
          skillFound = resolveSkillStatusEntry(report.skills, name) !== null;
          return formatSkillInfo(report, name, {
            ...opts,
            json: hasJsonOutput(opts),
          });
        },
        {
          agentId: resolveAgentOption(command, opts),
        },
      );
      if (!skillFound) {
        defaultRuntime.exit(1);
      }
    });

  skills
    .command("check")
    .description("Check which skills are ready, visible, or missing requirements")
    .option("--agent <id>", "Target agent workspace (defaults to cwd-inferred, then default agent)")
    .option("--json", "Output as JSON", false)
    .action(async (opts: { json?: boolean; agent?: string }, command: Command) => {
      await runSkillsAction(
        (report) =>
          formatSkillsCheck(report, {
            ...opts,
            json: hasJsonOutput(opts),
          }),
        {
          agentId: resolveAgentOption(command, opts),
        },
      );
    });

  // Default action (no subcommand) - show list
  skills.action(async (opts: { agent?: string; json?: boolean }, command: Command) => {
    await runSkillsAction((report) => formatSkillsList(report, { json: hasJsonOutput(opts) }), {
      agentId: resolveAgentOption(command, opts),
    });
  });
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
