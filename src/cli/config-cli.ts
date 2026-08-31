// Config CLI command implementation for get/set/unset/patch/validate and secret refs.
import type { Command } from "commander";
import { formatDocsLink } from "../../packages/terminal-core/src/links.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { readConfigFileSnapshotWithPluginMetadata } from "../config/config.js";
import { formatConfigIssueLines, normalizeConfigIssues } from "../config/issue-format.js";
import { renderConfigValidationIssueLines } from "../config/issue-location.js";
import { CONFIG_PATH, resolveConfigPath } from "../config/paths.js";
import { redactConfigObject } from "../config/redact-snapshot.js";
import {
  buildRuntimeConfigSchemaFromRegistry,
  readBestEffortRuntimeConfigSchema,
} from "../config/runtime-schema.js";
import { danger, success, warn } from "../globals.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  ExitError,
  type RuntimeEnv,
  defaultRuntime,
  writeRuntimeJson,
  writeRuntimeStdout,
} from "../runtime.js";
import { parseConcreteConfigPathTokens } from "../shared/dot-path.js";
import { shortenHomePath } from "../utils.js";
import { formatCliCommand } from "./command-format.js";
import {
  buildConfigSetOperations,
  buildUnsetOperation,
  configPatchModeError,
  readConfigPatchOperations,
  type ConfigPatchOptions,
  type ConfigUnsetOptions,
} from "./config-cli-input.js";
import { getAtPath, isConfigSchemaPath, parseConfigSetPath } from "./config-cli-path.js";
import { handleConfigMutationError, runConfigOperations } from "./config-cli-runner.js";
import {
  ensureValidConfigSnapshotForCli,
  formatInvalidConfigRepairHint,
  strictlyValidateConfigSnapshotForCli,
} from "./config-cli-validation.js";
import { isConfigMachineOutput, isConfigSetJsonParseOnly } from "./config-output-mode.js";
import type { ConfigSetOptions } from "./config-set-input.js";
import { formatCliJsonFailure } from "./failure-output.js";
import { exitCliAfterOutput } from "./one-shot-exit.js";
import { setCommandJsonMode } from "./program/json-mode.js";
import { quoteCliArg } from "./quote-cli-arg.js";

export { parseConfigSetPath } from "./config-cli-path.js";

const CONFIG_SET_DESCRIPTION = [
  "Set config values by path (value mode, ref/provider builder mode, or batch JSON mode).",
  "Examples:",
  formatCliCommand("openclaw config set gateway.port 19001 --strict-json"),
  formatCliCommand(
    "openclaw config set channels.discord.token --ref-provider default --ref-source env --ref-id DISCORD_BOT_TOKEN",
  ),
  formatCliCommand(
    "openclaw config set secrets.providers.vault --provider-source file --provider-path /etc/openclaw/secrets.json --provider-mode json",
  ),
  formatCliCommand("openclaw config set --batch-file ./config-set.batch.json --dry-run"),
].join("\n");

const CONFIG_PATCH_DESCRIPTION = [
  "Patch config from a JSON5 object in one validated write.",
  "Objects merge recursively, arrays/scalars replace, and null deletes a path.",
  "Examples:",
  formatCliCommand("openclaw config patch --file ./openclaw.patch.json5 --dry-run"),
  formatCliCommand("openclaw config patch --stdin"),
].join("\n");

export async function runConfigSet(opts: {
  path?: string;
  value?: string;
  cliOptions: ConfigSetOptions;
  runtime?: RuntimeEnv;
}) {
  const runtime = opts.runtime ?? defaultRuntime;
  try {
    await runConfigOperations({
      runtime,
      operations: buildConfigSetOperations({
        path: opts.path,
        value: opts.value,
        opts: opts.cliOptions,
      }),
      options: opts.cliOptions,
      successMode: "set",
    });
  } catch (err) {
    handleConfigMutationError({ err, runtime, options: opts.cliOptions });
  }
}

export async function runConfigPatch(opts: {
  cliOptions: ConfigPatchOptions;
  runtime?: RuntimeEnv;
}) {
  const runtime = opts.runtime ?? defaultRuntime;
  try {
    if (opts.cliOptions.allowExec && !opts.cliOptions.dryRun) {
      throw configPatchModeError("--allow-exec requires --dry-run.");
    }
    if (opts.cliOptions.json && !opts.cliOptions.dryRun) {
      throw configPatchModeError("--json requires --dry-run.");
    }
    await runConfigOperations({
      runtime,
      operations: await readConfigPatchOperations(opts.cliOptions),
      options: opts.cliOptions,
      successMode: "patch",
    });
  } catch (err) {
    handleConfigMutationError({ err, runtime, options: opts.cliOptions });
  }
}

export async function runConfigGet(opts: { path: string; json?: boolean; runtime?: RuntimeEnv }) {
  const runtime = opts.runtime ?? defaultRuntime;
  try {
    const parsedPath = parseConfigSetPath(opts.path);
    const read = await readConfigFileSnapshotWithPluginMetadata({ observe: false });
    const { snapshot, pluginMetadataSnapshot } = read;
    ensureValidConfigSnapshotForCli(snapshot, runtime, { json: opts.json });
    if (!pluginMetadataSnapshot) {
      throw new Error("Config plugin metadata unavailable; refusing to display config values.");
    }
    const { schema, uiHints } = buildRuntimeConfigSchemaFromRegistry(
      pluginMetadataSnapshot.manifestRegistry,
    );
    const res = getAtPath(redactConfigObject(snapshot.config, uiHints), parsedPath);
    if (!res.found) {
      const message = isConfigSchemaPath(schema, parsedPath)
        ? `Config path is valid but unset: ${opts.path}. The runtime default applies until you set an authored value with ${formatCliCommand(`openclaw config set ${quoteCliArg(opts.path)} <value>`)}.`
        : `Unknown config path: ${opts.path}. Run ${formatCliCommand("openclaw config schema")} to inspect valid paths.`;
      if (opts.json) {
        writeRuntimeJson(runtime, formatCliJsonFailure(message));
        exitCliAfterOutput(runtime, 1);
      }
      runtime.error(danger(message));
      exitCliAfterOutput(runtime, 1);
    }
    if (opts.json) {
      writeRuntimeJson(runtime, res.value ?? null);
    } else if (
      typeof res.value === "string" ||
      typeof res.value === "number" ||
      typeof res.value === "boolean"
    ) {
      writeRuntimeStdout(runtime, `${String(res.value)}\n`);
    } else {
      writeRuntimeJson(runtime, res.value ?? null);
    }
  } catch (err) {
    if (err instanceof ExitError) {
      throw err;
    }
    if (opts.json) {
      writeRuntimeJson(runtime, formatCliJsonFailure(err));
      exitCliAfterOutput(runtime, 1);
    }
    runtime.error(danger(formatErrorMessage(err)));
    exitCliAfterOutput(runtime, 1);
  }
}

export async function runConfigUnset(opts: {
  path: string;
  cliOptions?: ConfigUnsetOptions;
  runtime?: RuntimeEnv;
}) {
  const runtime = opts.runtime ?? defaultRuntime;
  const cliOptions = opts.cliOptions ?? {};
  try {
    if (cliOptions.allowExec && !cliOptions.dryRun) {
      throw new Error("--allow-exec can only be used with --dry-run.");
    }
    if (cliOptions.json && !cliOptions.dryRun) {
      throw new Error("--json can only be used with --dry-run.");
    }
    const pathTokens = parseConcreteConfigPathTokens(opts.path);
    await runConfigOperations({
      runtime,
      operations: [buildUnsetOperation(pathTokens.map(String), pathTokens)],
      options: cliOptions,
      successMode: "set",
    });
  } catch (err) {
    handleConfigMutationError({ err, runtime, options: cliOptions });
  }
}

async function runConfigFile(opts: { json?: boolean; runtime?: RuntimeEnv }) {
  const runtime = opts.runtime ?? defaultRuntime;
  try {
    const path = resolveConfigPath();
    if (opts.json) {
      writeRuntimeJson(runtime, { path });
      return;
    }
    writeRuntimeStdout(runtime, `${path}\n`);
  } catch (err) {
    runtime.error(danger(formatErrorMessage(err)));
    exitCliAfterOutput(runtime, 1);
  }
}

async function runConfigSchema(opts: { runtime?: RuntimeEnv } = {}) {
  const runtime = opts.runtime ?? defaultRuntime;
  try {
    const schema = structuredClone((await readBestEffortRuntimeConfigSchema()).schema) as {
      properties?: Record<string, unknown>;
    };
    schema.properties = { $schema: { type: "string" }, ...schema.properties };
    writeRuntimeJson(runtime, schema);
  } catch (err) {
    runtime.error(danger(`Config schema error: ${formatErrorMessage(err)}`));
    exitCliAfterOutput(runtime, 1);
  }
}

async function runConfigValidate(opts: { json?: boolean; runtime?: RuntimeEnv } = {}) {
  const runtime = opts.runtime ?? defaultRuntime;
  let outputPath = CONFIG_PATH ?? "openclaw.json";
  try {
    const read = await readConfigFileSnapshotWithPluginMetadata({ observe: false });
    const snapshot = await strictlyValidateConfigSnapshotForCli(
      read.snapshot,
      read.pluginMetadataSnapshot,
    );
    outputPath = snapshot.path;
    const shortPath = shortenHomePath(outputPath);
    if (!snapshot.exists) {
      if (opts.json) {
        writeRuntimeJson(
          runtime,
          { ...formatCliJsonFailure("file not found"), valid: false, path: outputPath },
          0,
        );
      } else {
        runtime.error(danger(`Config file not found: ${shortPath}`));
        runtime.error(
          `Create one with ${formatCliCommand("openclaw onboard")} or run ${formatCliCommand("openclaw doctor --fix")}.`,
        );
      }
      exitCliAfterOutput(runtime, 1);
    }
    if (!snapshot.valid) {
      const issues = normalizeConfigIssues(snapshot.issues);
      if (opts.json) {
        writeRuntimeJson(runtime, {
          ...formatCliJsonFailure(`OpenClaw config is invalid: ${shortPath}`),
          valid: false,
          path: outputPath,
          issues,
        });
      } else {
        runtime.error(danger(`OpenClaw config is invalid: ${shortPath}`));
        for (const line of renderConfigValidationIssueLines(snapshot, danger("×"))) {
          runtime.error(`  ${line}`);
        }
        runtime.error("");
        runtime.error(
          formatInvalidConfigRepairHint(snapshot, "to repair, or fix the keys above manually."),
        );
        runtime.error(`Inspect with ${formatCliCommand("openclaw config validate")}.`);
      }
      exitCliAfterOutput(runtime, 1);
    }
    const warnings = normalizeConfigIssues(snapshot.warnings);
    if (opts.json) {
      writeRuntimeJson(runtime, { valid: true, path: outputPath, warnings }, 0);
    } else {
      runtime.log(success(`Config valid: ${shortPath}`));
      if (warnings.length > 0) {
        runtime.log(warn(`${warnings.length} warning(s):`));
        for (const line of formatConfigIssueLines(warnings, warn("!"), { normalizeRoot: true })) {
          runtime.log(`  ${line}`);
        }
      }
    }
  } catch (err) {
    if (err instanceof ExitError) {
      throw err;
    }
    if (opts.json) {
      writeRuntimeJson(
        runtime,
        { ...formatCliJsonFailure(err), valid: false, path: outputPath },
        0,
      );
    } else {
      runtime.error(danger(`Config validation error: ${formatErrorMessage(err)}`));
    }
    exitCliAfterOutput(runtime, 1);
  }
}

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function registerConfigCli(program: Command) {
  const cmd = program
    .command("config")
    .description(
      "Non-interactive config helpers (get/set/patch/unset/file/schema/validate). Run without subcommand for guided setup.",
    )
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/config", "docs.openclaw.ai/cli/config")}\n`,
    )
    .option(
      "--section <section>",
      "Configuration sections for guided setup (repeatable). Use with no subcommand.",
      collectOption,
      [] as string[],
    )
    .action(async (opts) => {
      const { configureCommandFromSectionsArg } = await import("../commands/configure.js");
      await configureCommandFromSectionsArg(opts.section, defaultRuntime);
    });
  setCommandJsonMode(cmd, "output", ({ argv }) => isConfigMachineOutput(argv));

  cmd
    .command("get")
    .description("Get a config value by dot path")
    .argument("<path>", "Config path (dot or bracket notation)")
    .option("--json", "Output JSON", false)
    .action(async (path: string, opts) => {
      await runConfigGet({ path, json: Boolean(opts.json) });
    });

  setCommandJsonMode(cmd.command("set"), "parse-only", ({ argv }) => isConfigSetJsonParseOnly(argv))
    .description(CONFIG_SET_DESCRIPTION)
    .argument("[path]", "Config path (dot or bracket notation)")
    .argument("[value]", "Value (JSON/JSON5 or raw string)")
    .option("--strict-json", "Strict JSON parsing (error instead of raw string fallback)", false)
    .option("--json", "Legacy alias for --strict-json", false)
    .option(
      "--dry-run",
      "Validate changes without writing openclaw.json (checks run in builder/json/batch modes; exec SecretRefs are skipped unless --allow-exec is set)",
      false,
    )
    .option(
      "--allow-exec",
      "Dry-run only: allow exec SecretRef resolvability checks (may execute provider commands)",
      false,
    )
    .option("--merge", "Merge object/map values instead of replacing the target path", false)
    .option(
      "--replace",
      "Allow full replacement of protected map/list paths such as agents.defaults.models",
      false,
    )
    .option("--ref-provider <alias>", "SecretRef builder: provider alias")
    .option("--ref-source <source>", "SecretRef builder: source (env|file|exec|store)")
    .option("--ref-id <id>", "SecretRef builder: ref id")
    .option("--provider-source <source>", "Provider builder: source (env|file|exec|store)")
    .option(
      "--provider-allowlist <envVar>",
      "Provider builder (env): allowlist entry (repeatable)",
      collectOption,
      [] as string[],
    )
    .option("--provider-path <path>", "Provider builder (file): path")
    .option("--provider-mode <mode>", "Provider builder (file): mode (singleValue|json)")
    .option("--provider-timeout-ms <ms>", "Provider builder (file|exec): timeout ms")
    .option("--provider-max-bytes <bytes>", "Provider builder (file): max bytes")
    .option("--provider-command <path>", "Provider builder (exec): absolute command path")
    .option(
      "--provider-arg <arg>",
      "Provider builder (exec): command arg (repeatable)",
      collectOption,
      [] as string[],
    )
    .option("--provider-no-output-timeout-ms <ms>", "Provider builder (exec): no-output timeout ms")
    .option("--provider-max-output-bytes <bytes>", "Provider builder (exec): max output bytes")
    .option("--provider-json-only", "Provider builder (exec): require JSON output", false)
    .option(
      "--provider-env <key=value>",
      "Provider builder (exec): env assignment (repeatable)",
      collectOption,
      [] as string[],
    )
    .option(
      "--provider-pass-env <envVar>",
      "Provider builder (exec): pass host env var (repeatable)",
      collectOption,
      [] as string[],
    )
    .option(
      "--provider-trusted-dir <path>",
      "Provider builder (exec): trusted directory (repeatable)",
      collectOption,
      [] as string[],
    )
    .option("--batch-json <json>", "Batch mode: JSON array of set operations")
    .option("--batch-file <path>", "Batch mode: read JSON array of set operations from file")
    .action(async (path: string | undefined, value: string | undefined, opts: ConfigSetOptions) => {
      await runConfigSet({ path, value, cliOptions: opts });
    });

  cmd
    .command("patch")
    .description(CONFIG_PATCH_DESCRIPTION)
    .option("--file <path>", "Read a JSON5 config patch object from file")
    .option("--stdin", "Read a JSON5 config patch object from stdin", false)
    .option(
      "--dry-run",
      "Validate changes without writing openclaw.json (checks schema and SecretRef resolvability; exec SecretRefs are skipped unless --allow-exec is set)",
      false,
    )
    .option(
      "--allow-exec",
      "Dry-run only: allow exec SecretRef resolvability checks (may execute provider commands)",
      false,
    )
    .option("--json", "Output dry-run result as JSON", false)
    .option(
      "--replace-path <path>",
      "Replace the object or array at this dot/bracket path instead of recursively applying it (repeatable)",
      collectOption,
      [] as string[],
    )
    .action(async (opts: ConfigPatchOptions) => {
      await runConfigPatch({ cliOptions: opts });
    });

  cmd
    .command("unset")
    .description("Remove a config value by dot path")
    .argument("<path>", "Config path (dot or bracket notation)")
    .option("--dry-run", "validate the removal without writing the config file")
    .option("--allow-exec", "allow exec SecretRef providers during --dry-run")
    .option("--json", "print dry-run result as JSON")
    .action(async (path: string, options: ConfigUnsetOptions) => {
      await runConfigUnset({ path, cliOptions: options });
    });

  cmd
    .command("file")
    .description("Print the active config file path")
    .option("--json", "Output JSON", false)
    .action((opts: { json?: boolean }) => runConfigFile(opts));
  cmd
    .command("schema")
    .description("Print the JSON schema for openclaw.json")
    .option("--json", "Output JSON", false)
    .action(runConfigSchema);
  cmd
    .command("validate")
    .description("Validate the current config against the schema without starting the gateway")
    .option("--json", "Output validation result as JSON", false)
    .action(async (opts) => {
      await runConfigValidate({ json: Boolean(opts.json) });
    });
}
