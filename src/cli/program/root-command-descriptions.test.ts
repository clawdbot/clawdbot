// Root help renders catalog placeholders while command help and completion use
// registered Commander commands. Keep those user-facing descriptions aligned.
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cliCommandCatalog } from "../command-catalog.js";
import { isReservedNonPluginCommandRoot } from "../command-registration-policy.js";
import { collectShellCompletionCommandTree } from "../completion-command-tree.js";
import { getCoreCliCommandNames, registerCoreCliByName } from "./command-registry-core.js";
import { createProgramContext } from "./context.js";
import { getCoreCliCommandDescriptors } from "./core-command-descriptors.js";
import { registerSubCliByName, registerSubCliCommands } from "./register.subclis.js";
import { getSubCliEntriesCore } from "./subcli-descriptors.js";

const RESERVED_CATALOG_ROOTS = {
  tool: "reserved so plugin registration cannot claim this unregistered root",
  tools: "reserved so plugin registration cannot claim this unregistered root",
} as const;

const PLUGIN_CATALOG_PATHS = {
  "browser extension native-host": "registered and covered by the browser plugin",
  memory: "registered and covered by the memory-core plugin",
  "memory search": "registered and covered by the memory-core plugin",
  "memory status": "registered and covered by the memory-core plugin",
} as const;

const JSON_NOT_APPLICABLE = {
  namespaces: {
    reason: "command group only; reporting subcommands declare JSON output individually",
    commands: [
      "backup",
      "backup git",
      "backup sqlite",
      "database",
      "database ownership",
      "message",
      "message thread",
      "message emoji",
      "message sticker",
      "message role",
      "message channel",
      "message member",
      "message voice",
      "message event",
      "mcp",
      "transcripts",
      "gateway restart-handoff",
      "gateway diagnostics",
      "system",
      "system heartbeat",
      "promos",
      "telemetry",
      "infer",
      "infer model",
      "infer model auth",
      "infer image",
      "infer audio",
      "infer tts",
      "infer video",
      "infer web",
      "infer embedding",
      "approvals",
      "approvals allowlist",
      "approvals grants",
      "exec-policy",
      "nodes",
      "nodes camera",
      "nodes screen",
      "nodes location",
      "devices",
      "users",
      "node",
      "sandbox",
      "fleet",
      "worktrees",
      "cron",
      "dns",
      "proxy",
      "webhooks",
      "webhooks gmail",
      "clawbot",
      "pairing",
      "plugins",
      "plugins marketplace",
      "channels",
      "channels dead-letters",
      "directory",
      "directory peers",
      "directory groups",
      "security",
      "secrets",
      "secrets store",
      "models aliases",
      "models fallbacks",
      "models image-fallbacks",
      "models auth",
      "models auth order",
      "skills workshop",
    ],
  },
  interactive: {
    reason: "interactive wizard, login, or terminal session has no single report document",
    commands: [
      "configure",
      "config",
      "acp client",
      "gateway auth-token",
      "promos claim",
      "infer model auth login",
      "models auth add",
      "models auth login",
      "models auth setup-token",
      "models auth paste-token",
      "models auth paste-api-key",
      "models auth login-github-copilot",
      "mcp configure",
      "mcp login",
      "attach",
      "tui",
      "resume",
      "update wizard",
    ],
  },
  longRunning: {
    reason: "long-running server, worker, or live stream does not terminate with one JSON document",
    commands: [
      "acp",
      "gateway",
      "gateway run",
      "mcp serve",
      "node worker",
      "node run",
      "connect",
      "worker",
      "fleet logs",
      "proxy start",
      "proxy run",
      "webhooks gmail run",
      "hooks relay",
      "sessions tail",
    ],
  },
  mutations: {
    reason: "pure side-effect command has no meaningful report payload",
    commands: [
      "reset",
      "uninstall",
      "backup enable",
      "backup disable",
      "telemetry on",
      "telemetry off",
      "config set",
      "mcp add",
      "mcp set",
      "mcp tools",
      "mcp logout",
      "mcp reload",
      "mcp unset",
      "onboard recommendations acknowledge",
      "onboard recommendations refresh",
      "tasks notify",
      "tasks cancel",
      "tasks retry",
      "tasks dismiss",
      "tasks flow cancel",
      "models set",
      "models set-image",
      "models aliases add",
      "models aliases remove",
      "models fallbacks add",
      "models fallbacks remove",
      "models fallbacks clear",
      "models image-fallbacks add",
      "models image-fallbacks remove",
      "models image-fallbacks clear",
      "models auth logout",
      "models auth order set",
      "models auth order clear",
      "hooks enable",
      "hooks disable",
      "hooks install",
      "hooks update",
      "skills install",
      "skills update",
      "sandbox recreate",
      "fleet start",
      "fleet stop",
      "fleet restart",
      "fleet upgrade",
      "fleet rm",
      "dns setup",
      "proxy purge",
      "pairing approve",
      "plugins enable",
      "plugins disable",
      "plugins uninstall",
      "plugins install",
      "plugins update",
      "plugins build",
      "plugins init",
      "channels add",
      "channels remove",
      "channels login",
      "channels logout",
      "secrets store set",
      "secrets store rm",
      "secrets store import",
    ],
  },
  rawArtifacts: {
    reason: "command streams a raw artifact whose bytes are already the machine contract",
    commands: ["proxy blob"],
  },
  shellIntegration: {
    reason: "shell integration output must remain executable shell source",
    commands: ["completion"],
  },
} as const;

// Route-first parsing accepts JSON before Commander registration is reached.
const JSON_OUTPUT_ROUTE_FIRST = new Set(["agents"]);

async function registerAllBuiltInCommands(): Promise<Command> {
  const program = new Command().name("openclaw");
  const ctx = createProgramContext();
  const argv = ["node", "openclaw", "completion"];

  for (const name of getCoreCliCommandNames()) {
    await registerCoreCliByName(program, ctx, name, argv);
  }
  for (const entry of getSubCliEntriesCore()) {
    await registerSubCliByName(program, entry.name, argv, { purpose: "completion" });
  }
  return program;
}

function hasOwnJsonOption(command: Command): boolean {
  return command.options.some((option) => option.long === "--json");
}

function supportsJsonOutput(path: string, command: Command): boolean {
  // `config set --json` is a legacy strict-input parser alias. Only its
  // `--dry-run --json` combination reports JSON, so the mutation stays N/A.
  if (path === "config set") {
    return false;
  }
  return hasOwnJsonOption(command) || JSON_OUTPUT_ROUTE_FIRST.has(path);
}

function requiredCommandArgs(command: Command): string[] {
  const args = command.registeredArguments.flatMap((argument) => {
    if (!argument.required) {
      return [];
    }
    return ["guard-value"];
  });
  for (const option of command.options) {
    if (!option.mandatory) {
      continue;
    }
    const flag = option.long ?? option.short;
    if (!flag) {
      continue;
    }
    args.push(flag);
    if (option.required || option.optional) {
      args.push(option.argChoices?.[0] ?? "guard-value");
    }
  }
  return args;
}

function collectRegisteredCommandPaths(...programs: Command[]): Set<string> {
  return new Set(
    programs.flatMap((program) =>
      collectShellCompletionCommandTree(program).descendants.flatMap((context) =>
        context.pathVariants.map((path) => path.join(" ")),
      ),
    ),
  );
}

describe("root command descriptions", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_ENABLE_PRIVATE_QA_CLI", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps catalog placeholders and registered commands in sync", async () => {
    const program = await registerAllBuiltInCommands();

    const registeredCommands = new Map<string, { command: Command; registeredAsAlias: boolean }>();
    for (const command of program.commands) {
      registeredCommands.set(command.name(), { command, registeredAsAlias: false });
      for (const alias of command.aliases()) {
        registeredCommands.set(alias, { command, registeredAsAlias: true });
      }
    }

    const descriptors = [...getCoreCliCommandDescriptors(), ...getSubCliEntriesCore()];
    const missing: string[] = [];
    const mismatches: string[] = [];
    for (const descriptor of descriptors) {
      const registered = registeredCommands.get(descriptor.name);
      if (!registered) {
        missing.push(descriptor.name);
        continue;
      }
      if (
        !registered.registeredAsAlias &&
        registered.command.description() !== descriptor.description
      ) {
        mismatches.push(
          `${descriptor.name}\n  catalog:    ${descriptor.description}\n  registered: ${registered.command.description()}`,
        );
      }
    }

    expect(missing, "catalog entries with no registered command or alias").toEqual([]);
    expect(mismatches, "root help vs registered command description drift").toEqual([]);
  });

  it("keeps startup policy catalog paths registered or explicitly reserved", async () => {
    vi.stubEnv("OPENCLAW_EXPERIMENTAL_CLAWS", "1");
    const program = await registerAllBuiltInCommands();

    // Private QA is a lazy source-checkout command. Its root placeholder proves
    // registration without importing the private build omitted from normal dist.
    vi.stubEnv("OPENCLAW_ENABLE_PRIVATE_QA_CLI", "1");
    const lazyProgram = new Command().name("openclaw");
    registerSubCliCommands(lazyProgram, ["node", "openclaw", "--help"]);

    const registeredPaths = collectRegisteredCommandPaths(program, lazyProgram);
    const catalogPaths = new Set(cliCommandCatalog.map((entry) => entry.commandPath.join(" ")));
    const reservedPaths = new Set(Object.keys(RESERVED_CATALOG_ROOTS));
    const pluginPaths = new Set(Object.keys(PLUGIN_CATALOG_PATHS));

    expect(
      Object.entries({ ...RESERVED_CATALOG_ROOTS, ...PLUGIN_CATALOG_PATHS }).filter(
        ([, reason]) => reason.trim().length === 0,
      ),
      "every catalog exception must document why core has no command",
    ).toEqual([]);

    const missing = [...catalogPaths].filter(
      (path) => !registeredPaths.has(path) && !reservedPaths.has(path) && !pluginPaths.has(path),
    );
    expect(missing, "catalog entries with no registered command or reserved-root decision").toEqual(
      [],
    );

    const staleReservedRoots = [...reservedPaths].filter(
      (path) => !catalogPaths.has(path) || !isReservedNonPluginCommandRoot(path),
    );
    expect(
      staleReservedRoots,
      "reserved catalog roots must remain cataloged and blocked from plugin registration",
    ).toEqual([]);

    const stalePluginPaths = [...pluginPaths].filter(
      (path) => !catalogPaths.has(path) || registeredPaths.has(path),
    );
    expect(stalePluginPaths, "plugin catalog paths must remain plugin-owned").toEqual([]);

    const reservedRootsThatNowRegister = [...reservedPaths].filter((path) =>
      registeredPaths.has(path),
    );
    expect(
      reservedRootsThatNowRegister,
      "registered commands must leave the reserved-root exception list",
    ).toEqual([]);
  });

  it("classifies every built-in command as JSON output or explicitly not applicable", async () => {
    const program = await registerAllBuiltInCommands();
    const contexts = collectShellCompletionCommandTree(program).descendants;
    const registered = new Map(
      contexts.map((context) => [context.pathVariants[0]?.join(" ") ?? "", context.command]),
    );
    const notApplicableEntries = Object.values(JSON_NOT_APPLICABLE).flatMap((category) =>
      category.commands.map((command) => ({ command, reason: category.reason })),
    );
    const notApplicable = new Map<string, string>(
      notApplicableEntries.map(({ command, reason }) => [command, reason]),
    );

    expect(notApplicable.size, "a command must not appear in more than one JSON N/A category").toBe(
      notApplicableEntries.length,
    );
    expect(
      notApplicableEntries.filter(({ reason }) => reason.trim().length === 0),
      "every JSON N/A category must document why JSON is meaningless",
    ).toEqual([]);

    const unclassified = [...registered]
      .filter(([path, command]) => !supportsJsonOutput(path, command) && !notApplicable.has(path))
      .map(([path]) => path);
    expect(unclassified, "commands missing a deliberate JSON output decision").toEqual([]);

    const staleExceptions = [...notApplicable]
      .filter(([path]) => !registered.has(path))
      .map(([path]) => path);
    expect(staleExceptions, "JSON N/A entries for commands that no longer exist").toEqual([]);

    const exceptionsThatNowSupportJson = [...notApplicable]
      .filter(([path]) => {
        const command = registered.get(path);
        return command ? supportsJsonOutput(path, command) : false;
      })
      .map(([path]) => path);
    expect(
      exceptionsThatNowSupportJson,
      "remove stale JSON N/A entries after adding output support",
    ).toEqual([]);

    const staleRouteFirstSupport = [...JSON_OUTPUT_ROUTE_FIRST].filter((path) => {
      const command = registered.get(path);
      return !command || hasOwnJsonOption(command);
    });
    expect(
      staleRouteFirstSupport,
      "route-first JSON entries must exist and remain absent from Commander options",
    ).toEqual([]);
  });

  it("accepts declared JSON output options through the registered command parsers", async () => {
    const program = await registerAllBuiltInCommands();
    const contexts = collectShellCompletionCommandTree(program).descendants.filter((context) => {
      const path = context.pathVariants[0]?.join(" ") ?? "";
      return supportsJsonOutput(path, context.command) && hasOwnJsonOption(context.command);
    });

    expect(contexts.length).toBeGreaterThan(0);
    for (const context of contexts) {
      const path = context.pathVariants[0]?.join(" ") ?? "";
      const failure = new Error(`synthetic failure for ${path}`);
      context.command.action(async () => {
        throw failure;
      });
      const args = [...requiredCommandArgs(context.command), "--json"];

      await expect(context.command.parseAsync(args, { from: "user" }), path).rejects.toBe(failure);
    }
  });
});
