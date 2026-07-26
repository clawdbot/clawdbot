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
  resolveAgentIdByWorkspacePath,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import { getRuntimeConfig } from "../config/config.js";
import { CLAWHUB_TRUST_ERROR_CODE } from "../infra/clawhub-install-trust.js";
import {
  CLAWHUB_SKILLS_SH_TRUST_LABEL,
  CLAWHUB_SKILLS_SH_TRUST_STATE,
  fetchClawHubSkillCard,
  fetchClawHubSkillVerification,
  type ClawHubSkillVerificationResponse,
} from "../infra/clawhub.js";
import { defaultRuntime } from "../runtime.js";
import {
  installSkillFromClawHub,
  readVerifiedClawHubSkillSourceUrl,
  readTrackedClawHubSkillSlugs,
  resolveClawHubSkillVerificationTarget,
  searchSkillsFromClawHub,
  updateSkillsFromClawHub,
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
  SkillProposalManifest,
  SkillProposalReadResult,
  SkillProposalSupportFileInput,
} from "../skills/workshop/types.js";
import { CONFIG_DIR } from "../utils.js";
import { resolveClawHubRiskAcknowledgementCliOptions } from "./clawhub-risk-acknowledgement.js";
import { resolveOptionFromCommand } from "./cli-utils.js";
import { parseStrictPositiveIntOption } from "./program/helpers.js";
import { formatSkillInfo, formatSkillsCheck, formatSkillsList } from "./skills-cli.format.js";

export type {
  SkillInfoOptions,
  SkillsCheckOptions,
  SkillsListOptions,
} from "./skills-cli.format.js";
export { formatSkillInfo, formatSkillsCheck, formatSkillsList } from "./skills-cli.format.js";

type SkillStatusReport = Awaited<
  ReturnType<(typeof import("../skills/discovery/status.js"))["buildWorkspaceSkillStatus"]>
>;
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
};

type ResolvedSkillsWorkspace = ReturnType<typeof resolveSkillsWorkspace>;

const GATEWAY_SKILLS_STATUS_TIMEOUT_MS = 1_500;

function resolveSkillsWorkspace(options?: ResolveSkillsWorkspaceOptions): {
  config: ReturnType<typeof getRuntimeConfig>;
  workspaceDir: string;
  agentId: string;
} {
  // Prefer explicit --agent, then infer from cwd, then fall back to configured default agent.
  const config = getRuntimeConfig();
  const explicitAgentId = normalizeOptionalString(options?.agentId);
  const inferredAgentId = explicitAgentId
    ? undefined
    : resolveAgentIdByWorkspacePath(config, options?.cwd ?? process.cwd());
  const agentId = explicitAgentId ?? inferredAgentId ?? resolveDefaultAgentId(config);
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
  const resolved = resolveSkillsWorkspace(options);
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
    defaultRuntime.error(String(err));
    defaultRuntime.exit(1);
  }
}

function resolveSkillsWorkspaceForCommand(
  command: Command | null | undefined,
  opts?: { agent?: string },
): ReturnType<typeof resolveSkillsWorkspace> {
  return resolveSkillsWorkspace({ agentId: resolveAgentOption(command ?? undefined, opts) });
}

function resolveClawHubTargetWorkspaceDir(
  command: Command | undefined,
  opts: { agent?: string; global?: boolean },
): string | undefined {
  return resolveClawHubTargetWorkspace(command, opts)?.workspaceDir;
}

function resolveClawHubTargetWorkspace(
  command: Command | undefined,
  opts: { agent?: string; global?: boolean },
): Pick<ResolvedSkillsWorkspace, "config" | "workspaceDir"> | undefined {
  const agentId = resolveAgentOption(command, opts);
  if (opts.global && normalizeOptionalString(agentId)) {
    defaultRuntime.error("Use either --global or --agent, not both.");
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
      (entry) => `${entry.id}  ${entry.status}  ${entry.kind}  ${entry.skillKey}  ${entry.title}`,
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
    lines.push(
      `Possible overlap: ${overlap.left} ~ ${overlap.right} — merge via /learn if desired`,
    );
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
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/skills", "docs.openclaw.ai/cli/skills")}\n`,
    );

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
        if (opts.json) {
          defaultRuntime.writeJson({ results });
          return;
        }
        if (results.length === 0) {
          defaultRuntime.log("No ClawHub skills found.");
          return;
        }
        for (const entry of results) {
          const installRef = normalizeOptionalString(entry.installRef);
          const ownerHandle = normalizeOptionalString(entry.ownerHandle);
          const slug = formatClawHubSearchText(entry.slug);
          const skillsShInstallRef =
            installRef?.startsWith("skills-sh:") &&
            entry.trustState === CLAWHUB_SKILLS_SH_TRUST_STATE
              ? installRef
              : undefined;
          const skillRef = skillsShInstallRef
            ? formatClawHubSearchText(skillsShInstallRef)
            : ownerHandle
              ? `@${formatClawHubSearchText(ownerHandle)}/${slug}`
              : slug;
          const version = entry.version ? ` v${formatClawHubSearchText(entry.version)}` : "";
          const summary = entry.summary ? `  ${formatClawHubSearchText(entry.summary)}` : "";
          const displayName = formatClawHubSearchText(entry.displayName);
          const trust = skillsShInstallRef ? `  ${CLAWHUB_SKILLS_SH_TRUST_LABEL}` : "";
          defaultRuntime.log(`${skillRef}${version}  ${displayName}${summary}${trust}`);
        }
      } catch (err) {
        defaultRuntime.error(String(err));
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
          global?: boolean;
          agent?: string;
          as?: string;
        },
        command: Command,
      ) => {
        try {
          const workspaceDir = resolveClawHubTargetWorkspaceDir(command, opts);
          if (!workspaceDir) {
            return;
          }
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
          if (slug.trim().startsWith("skills-sh:") && opts.version) {
            defaultRuntime.error("--version is not supported for skills-sh references.");
            defaultRuntime.exit(1);
            return;
          }
          const result = await installSkillFromClawHub({
            workspaceDir,
            slug,
            version: opts.version,
            force: Boolean(opts.force),
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
          defaultRuntime.error(String(err));
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
          defaultRuntime.error(String(err));
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
        opts: { version?: string; tag?: string; card?: boolean; global?: boolean; agent?: string },
        command: Command,
      ) => {
        let exitCode: number | undefined;
        try {
          const workspaceDir = resolveClawHubTargetWorkspaceDir(command, opts);
          if (!workspaceDir) {
            return;
          }
          const target = await resolveClawHubSkillVerificationTarget({
            workspaceDir,
            slug,
            version: opts.version,
            tag: opts.tag,
          });
          if (!target.ok) {
            defaultRuntime.error(target.error);
            exitCode = 1;
          } else {
            const verification = await fetchClawHubSkillVerification({
              slug: target.slug,
              ...(target.ownerHandle ? { ownerHandle: target.ownerHandle } : {}),
              ...(target.requestedReference
                ? { requestedReference: target.requestedReference }
                : {}),
              version: target.version,
              tag: target.tag,
              baseUrl: target.baseUrl,
            });
            if (opts.card) {
              const cardUrl = readVerifiedSkillCardUrl(verification);
              if (!cardUrl.ok) {
                defaultRuntime.error(cardUrl.error);
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
              defaultRuntime.writeJson(buildSkillVerificationOutput(verification, target));
              exitCode = shouldFailSkillVerification(verification) ? 1 : undefined;
            }
          }
        } catch (err) {
          defaultRuntime.error(String(err));
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

  const showCuratorStatus = async () => {
    try {
      const status = await loadSkillCuratorStatus();
      if (curator.opts<{ json?: boolean }>().json) {
        defaultRuntime.writeJson(status);
        return;
      }
      defaultRuntime.writeStdout(formatSkillCuratorStatus(status));
    } catch (err) {
      defaultRuntime.error(String(err));
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
      .action(async (skill: string) => {
        try {
          const result = await runSkillCuratorMutation(action, skill);
          if (curator.opts<{ json?: boolean }>().json) {
            defaultRuntime.writeJson(result);
            return;
          }
          defaultRuntime.writeStdout(
            `${action[0]?.toUpperCase()}${action.slice(1)} ${result.skillKey}\n`,
          );
        } catch (err) {
          defaultRuntime.error(String(err));
          defaultRuntime.exit(1);
        }
      });
  }

  curator.action(showCuratorStatus);

  const workshop = skills
    .command("workshop")
    .description("Manage pending skill proposals")
    .option(
      "--agent <id>",
      "Target agent workspace (defaults to cwd-inferred, then default agent)",
    );

  workshop
    .command("list")
    .description("List pending and completed skill proposals")
    .option("--json", "Output as JSON", false)
    .action(async (opts: { json?: boolean; agent?: string }) => {
      try {
        const { workspaceDir } = resolveSkillsWorkspaceForCommand(workshop, opts);
        const manifest = await listSkillProposals({ workspaceDir });
        if (opts.json) {
          defaultRuntime.writeJson(manifest);
          return;
        }
        defaultRuntime.writeStdout(formatSkillProposalList(manifest));
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  workshop
    .command("inspect")
    .description("Inspect a skill proposal")
    .argument("<proposal-id>", "Skill proposal id")
    .option("--json", "Output as JSON", false)
    .action(async (proposalId: string, opts: { json?: boolean; agent?: string }) => {
      try {
        const { workspaceDir } = resolveSkillsWorkspaceForCommand(workshop, opts);
        const proposal = await inspectSkillProposal(proposalId, { workspaceDir });
        if (!proposal) {
          defaultRuntime.error(`Skill proposal not found: ${proposalId}`);
          defaultRuntime.exit(1);
          return;
        }
        if (opts.json) {
          defaultRuntime.writeJson(proposal);
          return;
        }
        defaultRuntime.writeStdout(formatSkillProposalInspect(proposal));
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

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
      async (
        opts: {
          name: string;
          description: string;
          proposal?: string;
          proposalDir?: string;
          goal?: string;
          evidence?: string;
          json?: boolean;
          agent?: string;
        },
        command: Command,
      ) => {
        try {
          const { config, workspaceDir } = resolveSkillsWorkspaceForCommand(command.parent, opts);
          const draft = await readSkillProposalInput(opts);
          const proposal = await proposeCreateSkill({
            workspaceDir,
            config,
            name: opts.name,
            description: opts.description,
            content: draft.content,
            supportFiles: draft.supportFiles,
            createdBy: "cli",
            goal: opts.goal,
            evidence: opts.evidence,
          });
          if (opts.json) {
            defaultRuntime.writeJson(proposal);
            return;
          }
          defaultRuntime.writeStdout(`${proposal.record.id}\n`);
        } catch (err) {
          defaultRuntime.error(String(err));
          defaultRuntime.exit(1);
        }
      },
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
    .action(
      async (
        skill: string,
        opts: {
          proposal?: string;
          proposalDir?: string;
          description?: string;
          goal?: string;
          evidence?: string;
          json?: boolean;
          agent?: string;
        },
        command: Command,
      ) => {
        try {
          const { config, workspaceDir, agentId } = resolveSkillsWorkspaceForCommand(
            command.parent,
            opts,
          );
          const draft = await readSkillProposalInput(opts);
          const proposal = await proposeUpdateSkill({
            workspaceDir,
            config,
            agentId,
            skillName: skill,
            description: opts.description,
            content: draft.content,
            supportFiles: draft.supportFiles,
            createdBy: "cli",
            goal: opts.goal,
            evidence: opts.evidence,
          });
          if (opts.json) {
            defaultRuntime.writeJson(proposal);
            return;
          }
          defaultRuntime.writeStdout(`${proposal.record.id}\n`);
        } catch (err) {
          defaultRuntime.error(String(err));
          defaultRuntime.exit(1);
        }
      },
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
    .action(
      async (
        proposalId: string,
        opts: {
          proposal?: string;
          proposalDir?: string;
          description?: string;
          goal?: string;
          evidence?: string;
          json?: boolean;
          agent?: string;
        },
        command: Command,
      ) => {
        try {
          const { config, workspaceDir } = resolveSkillsWorkspaceForCommand(command.parent, opts);
          const draft = await readSkillProposalInput(opts);
          const proposal = await reviseSkillProposal({
            workspaceDir,
            config,
            proposalId,
            content: draft.content,
            supportFiles: draft.supportFiles,
            description: opts.description,
            goal: opts.goal,
            evidence: opts.evidence,
          });
          if (opts.json) {
            defaultRuntime.writeJson(proposal);
            return;
          }
          defaultRuntime.writeStdout(
            `Revised ${proposal.record.id} ${proposal.record.proposedVersion}\n`,
          );
        } catch (err) {
          defaultRuntime.error(String(err));
          defaultRuntime.exit(1);
        }
      },
    );

  workshop
    .command("apply")
    .description("Apply a pending skill proposal")
    .argument("<proposal-id>", "Skill proposal id")
    .option("--json", "Output as JSON", false)
    .action(
      async (proposalId: string, opts: { json?: boolean; agent?: string }, command: Command) => {
        try {
          const { config, workspaceDir } = resolveSkillsWorkspaceForCommand(command.parent, opts);
          const applied = await applySkillProposal({ workspaceDir, config, proposalId });
          if (opts.json) {
            defaultRuntime.writeJson(applied);
            return;
          }
          defaultRuntime.writeStdout(
            `Applied ${applied.record.id} -> ${applied.targetSkillFile}\n`,
          );
        } catch (err) {
          defaultRuntime.error(String(err));
          defaultRuntime.exit(1);
        }
      },
    );

  workshop
    .command("reject")
    .description("Reject a pending skill proposal")
    .argument("<proposal-id>", "Skill proposal id")
    .option("--reason <text>", "Reason for rejection")
    .option("--json", "Output as JSON", false)
    .action(
      async (
        proposalId: string,
        opts: { reason?: string; json?: boolean; agent?: string },
        command: Command,
      ) => {
        try {
          const { workspaceDir } = resolveSkillsWorkspaceForCommand(command.parent, opts);
          const record = await rejectSkillProposal({
            workspaceDir,
            proposalId,
            reason: opts.reason,
          });
          if (opts.json) {
            defaultRuntime.writeJson(record);
            return;
          }
          defaultRuntime.writeStdout(`Rejected ${record.id}\n`);
        } catch (err) {
          defaultRuntime.error(String(err));
          defaultRuntime.exit(1);
        }
      },
    );

  workshop
    .command("quarantine")
    .description("Quarantine a skill proposal")
    .argument("<proposal-id>", "Skill proposal id")
    .option("--reason <text>", "Reason for quarantine")
    .option("--json", "Output as JSON", false)
    .action(
      async (
        proposalId: string,
        opts: { reason?: string; json?: boolean; agent?: string },
        command: Command,
      ) => {
        try {
          const { workspaceDir } = resolveSkillsWorkspaceForCommand(command.parent, opts);
          const record = await quarantineSkillProposal({
            workspaceDir,
            proposalId,
            reason: opts.reason,
          });
          if (opts.json) {
            defaultRuntime.writeJson(record);
            return;
          }
          defaultRuntime.writeStdout(`Quarantined ${record.id}\n`);
        } catch (err) {
          defaultRuntime.error(String(err));
          defaultRuntime.exit(1);
        }
      },
    );

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
        await runSkillsAction((report) => formatSkillsList(report, opts), {
          agentId: resolveAgentOption(command, opts),
        });
      },
    );

  skills
    .command("info")
    .description("Show detailed information about a skill")
    .argument("<name>", "Skill name")
    .option("--json", "Output as JSON", false)
    .option("--agent <id>", "Target agent workspace (defaults to cwd-inferred, then default agent)")
    .action(async (name: string, opts: { json?: boolean; agent?: string }, command: Command) => {
      await runSkillsAction((report) => formatSkillInfo(report, name, opts), {
        agentId: resolveAgentOption(command, opts),
      });
    });

  skills
    .command("check")
    .description("Check which skills are ready, visible, or missing requirements")
    .option("--agent <id>", "Target agent workspace (defaults to cwd-inferred, then default agent)")
    .option("--json", "Output as JSON", false)
    .action(async (opts: { json?: boolean; agent?: string }, command: Command) => {
      await runSkillsAction((report) => formatSkillsCheck(report, opts), {
        agentId: resolveAgentOption(command, opts),
      });
    });

  // Default action (no subcommand) - show list
  skills.action(async (opts: { agent?: string }, command: Command) => {
    await runSkillsAction((report) => formatSkillsList(report, {}), {
      agentId: resolveAgentOption(command, opts),
    });
  });
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
