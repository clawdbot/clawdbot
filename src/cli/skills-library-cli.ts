import { Option, type Command } from "commander";
import type {
  SkillsLibraryActivateResult,
  SkillsLibraryListResult,
  SkillsLibraryReadResult,
  SkillsLibraryReceipt,
} from "../../packages/gateway-protocol/src/index.js";
import { defaultRuntime } from "../runtime.js";
import { runCommandWithRuntime } from "./cli-utils.js";
import { inheritOptionFromParent } from "./command-options.js";
import {
  addGatewayClientOptions,
  callGatewayFromCliWithTransport,
  type GatewayRpcOpts,
} from "./gateway-rpc.js";
import { collectOption } from "./program/helpers.js";
import { applyParentDefaultHelpAction } from "./program/parent-default-help.js";
import { readLibraryInput, uploadLibraryZip } from "./skills-library-input.js";

type LibraryOptions = GatewayRpcOpts & {
  slug?: string;
  expectedRevision?: string;
  revision?: string;
  clawhub?: boolean;
  version?: string;
  scope?: "mine" | "team" | "all";
  deleteFile?: string[];
  session?: string;
};

function rpcOptions(command: Command): GatewayRpcOpts {
  const opts = command.opts<GatewayRpcOpts>();
  const value = <K extends keyof GatewayRpcOpts>(name: K): GatewayRpcOpts[K] =>
    command.getOptionValueSource(name) !== "default" && opts[name] !== undefined
      ? opts[name]
      : (inheritOptionFromParent<GatewayRpcOpts[K]>(command, name) ?? opts[name]);
  return {
    url: value("url"),
    port: value("port"),
    token: value("token"),
    password: value("password"),
    timeout: value("timeout"),
    expectFinal: value("expectFinal"),
    json: value("json"),
  };
}

function receiptText(receipt: SkillsLibraryReceipt): string {
  return `${receipt.state}: ${receipt.entry.slug} (${receipt.target}, owner ${receipt.entry.ownerLabel})\nSkill ID: ${receipt.entry.skillId}\nRevision: ${receipt.entry.revision}\n${receipt.nextAction}\n`;
}

export function registerSkillsLibraryCli(skills: Command): void {
  const library = addGatewayClientOptions(
    skills.command("library").description("Manage authenticated personal and team skill libraries"),
  )
    .option("--json", "Output as JSON", false)
    .addHelpText(
      "after",
      "\nCreate: openclaw skills library create ./my-skill --slug my-skill\nRead:   openclaw skills library read <skill-id> --json\nUpdate: openclaw skills library update <skill-id> ./SKILL.md --expected-revision <hash>\nPersonal libraries require a signed-in Gateway profile. Workspace installs remain under skills install.\n",
    );
  const leaf = (name: string, description: string) =>
    addGatewayClientOptions(library.command(name).description(description)).option(
      "--json",
      "Output as JSON",
      false,
    );
  const execute = <T>(
    command: Command,
    action: (opts: GatewayRpcOpts) => Promise<T>,
    format: (result: T) => string,
  ) =>
    runCommandWithRuntime(defaultRuntime, async () => {
      const opts = rpcOptions(command);
      const result = await action(opts);
      if (opts.json) {
        defaultRuntime.writeJson(result);
      } else {
        defaultRuntime.writeStdout(format(result));
      }
    });
  leaf("list", "List your own and visible shared skills")
    .addOption(
      new Option("--scope <scope>", "Library scope")
        .choices(["mine", "team", "all"])
        .default("all"),
    )
    .option("--session <key>", "Include this session’s selected revisions and attachable skills")
    .action((opts: LibraryOptions, command: Command) =>
      execute(
        command,
        (rpc) =>
          callGatewayFromCliWithTransport<SkillsLibraryListResult>("skills.library.list", rpc, {
            scope: opts.scope,
            ...(opts.session ? { sessionKey: opts.session } : {}),
          }),
        (result) =>
          [
            `Default target: ${result.defaultTarget}`,
            `New-session default selection limit: ${result.defaultSelectionLimit}`,
            ...(result.defaultSelectionNotice ? [result.defaultSelectionNotice] : []),
            ...(result.session
              ? [
                  `Session: ${result.session.sessionKey}`,
                  ...result.session.selections.map(
                    (selection) =>
                      `Selected: ${selection.skillId}  ${selection.slug}  owner=${selection.ownerLabel}  ${selection.revision}  ${selection.name}`,
                  ),
                  ...result.session.attachable.map(
                    (entry) =>
                      `Attachable: ${entry.skillId}  ${entry.slug}  owner=${entry.ownerLabel}`,
                  ),
                ]
              : []),
            ...result.entries.map(
              (entry) =>
                `${entry.skillId}  ${entry.slug}  owner=${entry.ownerLabel}  ${entry.enabled ? "enabled" : "disabled"}${entry.shared ? " shared" : ""}  ${entry.revision}`,
            ),
            ...(!result.profileId
              ? [
                  "Sign in with a durable Gateway profile to create personal skills. Administrators can use skills install for workspace skills.",
                ]
              : []),
            "",
          ].join("\n"),
      ),
    );

  leaf("read", "Read the complete SKILL.md, supporting files, and revision history")
    .argument("<skill-id>", "Stable library skill ID")
    .option("--revision <hash>", "Read a retained revision")
    .option("--session <key>", "Read an exact session pin (requires --revision)")
    .action((skillId: string, opts: LibraryOptions, command: Command) =>
      execute(
        command,
        (rpc) => {
          if (opts.session && !opts.revision) {
            throw new Error("--session requires --revision to read an exact selected pin.");
          }
          return callGatewayFromCliWithTransport<SkillsLibraryReadResult>(
            "skills.library.read",
            rpc,
            {
              skillId,
              ...(opts.revision ? { revision: opts.revision } : {}),
              ...(opts.session ? { sessionKey: opts.session } : {}),
            },
          );
        },
        (result) =>
          [
            `${result.entry.slug} (${result.entry.ownerLabel})`,
            `Skill ID: ${result.entry.skillId}`,
            `Revision: ${result.entry.revision}`,
            `Command: ${result.entry.name}`,
            "--- SKILL.md ---",
            result.content,
            ...result.files.flatMap((file) => [
              `--- ${file.path} (${file.encoding ?? "utf8"}${file.executable ? ", executable" : ""}) ---`,
              file.content,
            ]),
            "Retained revisions:",
            ...result.revisions.map(
              (revision) => `${revision.revision}  ${new Date(revision.createdAt).toISOString()}`,
            ),
            "",
          ].join("\n"),
      ),
    );

  leaf("create", "Save a private skill from SKILL.md or a complete local directory")
    .argument("<path>", "Local SKILL.md or skill directory")
    .requiredOption("--slug <slug>", "Library name (lowercase letters, digits, hyphens)")
    .action((input: string, opts: LibraryOptions & { slug: string }, command: Command) =>
      execute(
        command,
        async (rpc) =>
          callGatewayFromCliWithTransport<SkillsLibraryReceipt>("skills.library.save", rpc, {
            slug: opts.slug,
            expectedRevision: null,
            ...(await readLibraryInput(input)),
          }),
        receiptText,
      ),
    );

  leaf(
    "update",
    "Save a revision; a single SKILL.md preserves supporting files, a directory replaces the bundle",
  )
    .argument("<skill-id>", "Stable library skill ID")
    .argument("<path>", "Local SKILL.md or complete replacement directory")
    .requiredOption(
      "--expected-revision <hash>",
      "Current revision from library read; conflicts never overwrite",
    )
    .option("--slug <slug>", "Change the library name")
    .option(
      "--delete-file <path>",
      "Explicitly remove a supporting file (repeatable)",
      collectOption,
    )
    .action((skillId: string, input: string, opts: LibraryOptions, command: Command) =>
      execute(
        command,
        async (rpc) => {
          const current = await callGatewayFromCliWithTransport<SkillsLibraryReadResult>(
            "skills.library.read",
            rpc,
            { skillId },
          );
          const bundle = await readLibraryInput(input);
          const files = bundle.files ?? current.files;
          for (const deleted of opts.deleteFile ?? []) {
            if (!files.some((file) => file.path === deleted)) {
              throw new Error(`Supporting file not found: ${deleted}`);
            }
          }
          return callGatewayFromCliWithTransport<SkillsLibraryReceipt>("skills.library.save", rpc, {
            skillId,
            expectedRevision: opts.expectedRevision,
            slug: opts.slug ?? current.entry.slug,
            content: bundle.content,
            files: files.filter((file) => !opts.deleteFile?.includes(file.path)),
          });
        },
        receiptText,
      ),
    );

  leaf("import", "Privately import a local bundle, ZIP, or ClawHub skill")
    .argument("<source>", "Local path or ClawHub reference with --clawhub")
    .requiredOption("--slug <slug>", "Destination name in your personal library")
    .option("--clawhub", "Read source from ClawHub; never publishes your files", false)
    .option("--version <version>", "ClawHub version")
    .action((source: string, opts: LibraryOptions & { slug: string }, command: Command) =>
      execute(
        command,
        async (rpc) => {
          if (opts.version && !opts.clawhub) {
            throw new Error("--version requires --clawhub.");
          }
          if (opts.clawhub) {
            return callGatewayFromCliWithTransport<SkillsLibraryReceipt>(
              "skills.library.import",
              rpc,
              {
                slug: opts.slug,
                source: {
                  kind: "clawhub",
                  slug: source,
                  ...(opts.version ? { version: opts.version } : {}),
                },
              },
            );
          }
          if (source.toLowerCase().endsWith(".zip")) {
            return uploadLibraryZip(source, opts.slug, rpc);
          }
          return callGatewayFromCliWithTransport<SkillsLibraryReceipt>("skills.library.save", rpc, {
            slug: opts.slug,
            expectedRevision: null,
            ...(await readLibraryInput(source)),
          });
        },
        receiptText,
      ),
    );

  for (const action of [
    "remove",
    "share",
    "unshare",
    "transfer",
    "enable",
    "disable",
    "rollback",
  ] as const) {
    const command = leaf(
      action,
      action === "transfer"
        ? "Transfer ownership to the team (administrator only)"
        : `${action.charAt(0).toUpperCase()}${action.slice(1)} a managed skill`,
    )
      .argument("<skill-id>", "Stable library skill ID")
      .requiredOption("--expected-revision <hash>", "Current revision from library read");
    if (action === "rollback") {
      command.requiredOption("--revision <hash>", "Retained revision to restore");
    }
    command.action(
      (skillId: string, opts: LibraryOptions & { expectedRevision: string }, cmd: Command) =>
        execute(
          cmd,
          (rpc) =>
            callGatewayFromCliWithTransport<SkillsLibraryReceipt>("skills.library.mutate", rpc, {
              skillId,
              action,
              expectedRevision: opts.expectedRevision,
              ...(opts.revision ? { revision: opts.revision } : {}),
            }),
          receiptText,
        ),
    );
  }
  for (const action of ["attach", "detach", "refresh"] as const) {
    const command = leaf(
      action,
      `${action.charAt(0).toUpperCase()}${action.slice(1)} managed selections explicitly for the next session turn`,
    ).requiredOption("--session <key>", "Exact target session key");
    if (action === "refresh") {
      command.option("--skill-id <id>", "Refresh only this selected skill; omit to refresh all");
    } else {
      command.requiredOption("--skill-id <id>", "Stable library skill ID");
    }
    if (action === "attach") {
      command.option("--revision <hash>", "Retained revision to select");
    }
    command.action((opts: LibraryOptions & { session: string; skillId?: string }, cmd: Command) =>
      execute(
        cmd,
        (rpc) =>
          callGatewayFromCliWithTransport<SkillsLibraryActivateResult>(
            "skills.library.activate",
            rpc,
            {
              action,
              sessionKey: opts.session,
              ...(opts.skillId ? { skillId: opts.skillId } : {}),
              ...(opts.revision ? { revision: opts.revision } : {}),
            },
          ),
        (result) =>
          `Queued for next turn: ${result.sessionKey}\n${result.selections.map((selection) => `${selection.skillId}  ${selection.name}  ${selection.revision}`).join("\n")}\n`,
      ),
    );
  }
  applyParentDefaultHelpAction(library);
}
