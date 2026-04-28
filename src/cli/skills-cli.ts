import type { Command } from "commander";
import {
  resolveAgentIdByWorkspacePath,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import {
  installSkillFromClawHub,
  readTrackedClawHubSkillSlugs,
  searchSkillsFromClawHub,
  updateSkillsFromClawHub,
} from "../agents/skills-clawhub.js";
import { getRuntimeConfig } from "../config/config.js";
import { defaultRuntime } from "../runtime.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";
import { resolveOptionFromCommand } from "./cli-utils.js";
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

type ResolveSkillsWorkspaceOptions = {
  agentId?: string;
  cwd?: string;
};

function resolveSkillsWorkspace(options?: ResolveSkillsWorkspaceOptions): {
  config: ReturnType<typeof getRuntimeConfig>;
  workspaceDir: string;
} {
  const config = getRuntimeConfig();
  const explicitAgentId = normalizeOptionalString(options?.agentId);
  const inferredAgentId = explicitAgentId
    ? undefined
    : resolveAgentIdByWorkspacePath(config, options?.cwd ?? process.cwd());
  const agentId = explicitAgentId ?? inferredAgentId ?? resolveDefaultAgentId(config);
  return {
    config,
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
  const { config, workspaceDir } = resolveSkillsWorkspace(options);
  const { buildWorkspaceSkillStatus } = await import("../agents/skills-status.js");
  return buildWorkspaceSkillStatus(workspaceDir, { config });
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
    .option("--limit <n>", "Max results", (value) => Number.parseInt(value, 10))
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
    .description("Install a skill from ClawHub into the active workspace")
    .argument("<slug>", "ClawHub skill slug")
    .option("--version <version>", "Install a specific version")
    .option("--force", "Overwrite an existing workspace skill", false)
    .option("--agent <id>", "Target agent workspace (defaults to cwd-inferred, then default agent)")
    .action(
      async (
        slug: string,
        opts: { version?: string; force?: boolean; agent?: string },
        command: Command,
      ) => {
        try {
          const workspaceDir = resolveActiveWorkspaceDir({
            agentId: resolveAgentOption(command, opts),
          });
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
    .description("Update ClawHub-installed skills in the active workspace")
    .argument("[slug]", "Single skill slug")
    .option("--all", "Update all tracked ClawHub skills", false)
    .option("--agent <id>", "Target agent workspace (defaults to cwd-inferred, then default agent)")
    .action(
      async (
        slug: string | undefined,
        opts: { all?: boolean; agent?: string },
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
          const workspaceDir = resolveActiveWorkspaceDir({
            agentId: resolveAgentOption(command, opts),
          });
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
    .description("Check which skills are ready vs missing requirements")
    .option("--json", "Output as JSON", false)
    .option("--agent <id>", "Target agent workspace (defaults to cwd-inferred, then default agent)")
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
