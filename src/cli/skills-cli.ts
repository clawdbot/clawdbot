import type { Command } from "commander";
import {
  resolveAgentIdByWorkspacePath,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import {
  installSkillFromClawHub,
  readTrackedClawHubSkillSlugs,
  resolveClawHubSkillVerificationTarget,
  searchSkillsFromClawHub,
  updateSkillsFromClawHub,
} from "../agents/skills-clawhub.js";
import {
  installSkillFromSource,
  isSkillSourceInstallSpec,
} from "../agents/skills-source-install.js";
import { getRuntimeConfig } from "../config/config.js";
import {
  fetchClawHubSkillCard,
  fetchClawHubSkillVerification,
  type ClawHubSkillVerificationResponse,
} from "../infra/clawhub.js";
import { defaultRuntime } from "../runtime.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";
import { CONFIG_DIR } from "../utils.js";
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
  ReturnType<(typeof import("../agents/skills-status.js"))["buildWorkspaceSkillStatus"]>
>;
type ResolvedClawHubSkillVerificationTarget = Extract<
  Awaited<ReturnType<typeof resolveClawHubSkillVerificationTarget>>,
  { ok: true }
>;

type ResolveSkillsWorkspaceOptions = {
  agentId?: string;
  cwd?: string;
};

function resolveSkillsWorkspace(options?: ResolveSkillsWorkspaceOptions): {
  config: ReturnType<typeof getRuntimeConfig>;
  workspaceDir: string;
  agentId: string;
} {
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

async function loadSkillsStatusReport(
  options?: ResolveSkillsWorkspaceOptions,
): Promise<SkillStatusReport> {
  const { config, workspaceDir, agentId } = resolveSkillsWorkspace(options);
  const { buildWorkspaceSkillStatus } = await import("../agents/skills-status.js");
  return buildWorkspaceSkillStatus(workspaceDir, { config, agentId });
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

function resolveActiveWorkspaceDir(options?: ResolveSkillsWorkspaceOptions): string {
  return resolveSkillsWorkspace(options).workspaceDir;
}

function resolveClawHubTargetWorkspaceDir(
  command: Command | undefined,
  opts: { agent?: string; global?: boolean },
): string | undefined {
  const agentId = resolveAgentOption(command, opts);
  if (opts.global && normalizeOptionalString(agentId)) {
    defaultRuntime.error("Use either --global or --agent, not both.");
    defaultRuntime.exit(1);
    return undefined;
  }
  if (opts.global) {
    return CONFIG_DIR;
  }
  return resolveActiveWorkspaceDir({ agentId });
}

function shouldFailSkillVerification(result: ClawHubSkillVerificationResponse): boolean {
  const envelope = result as { ok: unknown; decision: unknown };
  return envelope.ok !== true || envelope.decision !== "pass";
}

function buildSkillVerificationOutput(
  result: ClawHubSkillVerificationResponse,
  target: ResolvedClawHubSkillVerificationTarget,
): Record<string, unknown> {
  return {
    ...result,
    openclaw: {
      resolution: {
        source: target.resolution.source,
        selector: target.resolution.selector,
        registry: target.resolution.registry,
        installedVersion: target.resolution.installedVersion,
      },
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
          const version = entry.version ? ` v${entry.version}` : "";
          const summary = entry.summary ? `  ${entry.summary}` : "";
          defaultRuntime.log(`${entry.slug}${version}  ${entry.displayName}${summary}`);
        }
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  skills
    .command("install")
    .description("Install a skill from ClawHub, git, or a local directory")
    .argument("<slug>", "ClawHub skill slug, git:<repo>, or local skill directory")
    .option("--version <version>", "Install a specific version")
    .option("--force", "Overwrite an existing workspace skill", false)
    .option("--global", "Install into the shared managed skills directory", false)
    .option("--agent <id>", "Target agent workspace (defaults to cwd-inferred, then default agent)")
    .option("--as <slug>", "Install a git/local skill under this slug")
    .action(
      async (
        slug: string,
        opts: {
          version?: string;
          force?: boolean;
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
                warn: (message) => defaultRuntime.log(theme.warn(message)),
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
          const result = await installSkillFromClawHub({
            workspaceDir,
            slug,
            version: opts.version,
            force: Boolean(opts.force),
            logger: {
              info: (message) => defaultRuntime.log(message),
            },
          });
          if (!result.ok) {
            defaultRuntime.error(result.error);
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
    .argument("[slug]", "Single skill slug")
    .option("--all", "Update all tracked ClawHub skills", false)
    .option("--global", "Update skills in the shared managed skills directory", false)
    .option("--agent <id>", "Target agent workspace (defaults to cwd-inferred, then default agent)")
    .action(
      async (
        slug: string | undefined,
        opts: { all?: boolean; global?: boolean; agent?: string },
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
          const workspaceDir = resolveClawHubTargetWorkspaceDir(command, opts);
          if (!workspaceDir) {
            return;
          }
          const tracked = await readTrackedClawHubSkillSlugs(workspaceDir);
          if (opts.all && tracked.length === 0) {
            defaultRuntime.log("No tracked ClawHub skills to update.");
            return;
          }
          const results = await updateSkillsFromClawHub({
            workspaceDir,
            slug,
            logger: {
              info: (message) => defaultRuntime.log(message),
            },
          });
          for (const result of results) {
            if (!result.ok) {
              defaultRuntime.error(result.error);
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
        } catch (err) {
          defaultRuntime.error(String(err));
          defaultRuntime.exit(1);
        }
      },
    );

  skills
    .command("verify")
    .description("Verify a ClawHub skill with ClawHub")
    .argument("<slug>", "ClawHub skill slug")
    .option("--version <version>", "Verify a specific version")
    .option("--tag <tag>", "Verify a dist tag")
    .option("--card", "Print the generated Skill Card Markdown", false)
    .option(
      "--global",
      "Resolve installed skill metadata from the shared managed skills directory",
      false,
    )
    .option("--agent <id>", "Target agent workspace (defaults to cwd-inferred, then default agent)")
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
