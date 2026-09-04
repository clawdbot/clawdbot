import type { Command } from "commander";
import { formatDocsLink } from "../../packages/terminal-core/src/links.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { ENV_SECRET_REF_ID_RE } from "../config/types.secrets.js";
import { danger } from "../globals.js";
import { formatErrorMessage } from "../infra/errors.js";
import { defaultRuntime } from "../runtime.js";
import { isSensitiveEnvName } from "../secrets/secret-env-name.js";
import type {
  SecretStoreEntryMetadata,
  SecretStoreValidationError,
} from "../secrets/store/secret-store.js";
import { runSecretsCommand } from "./secrets-cli-output.js";

type OutputOptions = { json?: boolean; plain?: boolean; scope?: string };
type SetOptions = {
  value?: string;
  valueFile?: string;
  kind?: string;
  scope?: string;
  dryRun?: boolean;
  allowHost?: string[];
  clearAllowedHosts?: boolean;
};
type RemoveOptions = { scope?: string; dryRun?: boolean; yes?: boolean };
type ImportOptions = RemoveOptions & { from?: string; kind?: string };
type StoreKind = "secret" | "env";

class SecretStoreCliFailure extends Error {
  constructor(
    readonly exitCode: 1 | 2 | 3,
    message: string,
  ) {
    super(message);
    this.name = "SecretStoreCliFailure";
  }
}

function teamScope(scope: string | undefined): { kind: "team" } {
  if (!scope || scope === "team") {
    return { kind: "team" };
  }
  if (scope === "me") {
    throw new SecretStoreCliFailure(2, "Identity scope is not supported yet; use --scope team.");
  }
  throw new SecretStoreCliFailure(2, `Invalid scope "${scope}"; only "team" is supported.`);
}

function storeKind(kind: string | undefined, name: string): StoreKind {
  if (!kind) {
    return isSensitiveEnvName(name) ? "secret" : "env";
  }
  if (kind === "secret" || kind === "env") {
    return kind;
  }
  throw new SecretStoreCliFailure(2, `Invalid kind "${kind}"; use "secret" or "env".`);
}

function assertStoreName(name: string): void {
  if (!ENV_SECRET_REF_ID_RE.test(name)) {
    throw new SecretStoreCliFailure(2, `Name must match ${String(ENV_SECRET_REF_ID_RE)}.`);
  }
}

function assertOutputMode(options: OutputOptions): void {
  if (options.json && options.plain) {
    throw new SecretStoreCliFailure(2, "Choose either --json or --plain, not both.");
  }
}

function mapStoreError(error: unknown): SecretStoreCliFailure {
  if (error instanceof SecretStoreCliFailure) {
    return error;
  }
  const validation = error as Partial<SecretStoreValidationError>;
  if (
    validation?.name === "SecretStoreValidationError" &&
    (validation.code === "SECRET_STORE_INVALID_NAME" ||
      validation.code === "SECRET_STORE_VALUE_TOO_LARGE" ||
      validation.code === "SECRET_STORE_VALUE_EMPTY" ||
      validation.code === "SECRET_STORE_INVALID_ALLOWED_HOST")
  ) {
    return new SecretStoreCliFailure(2, validation.message ?? "Invalid secret store input.");
  }
  return new SecretStoreCliFailure(1, formatErrorMessage(error));
}

async function runStoreAction<T>(
  action: () => Promise<T>,
  json?: boolean,
  renderHumanSuccess?: (result: T) => void,
): Promise<void> {
  const result = await runSecretsCommand(
    json,
    action,
    (error) => defaultRuntime.error(danger(formatErrorMessage(error))),
    (error) => {
      const failure = mapStoreError(error);
      return { error: failure, exitCode: failure.exitCode };
    },
  );
  if (!json) {
    renderHumanSuccess?.(result);
  }
}

function renderList(entries: SecretStoreEntryMetadata[], options: OutputOptions): void {
  if (options.plain) {
    for (const entry of entries) {
      defaultRuntime.writeStdout(
        [
          entry.name,
          entry.kind,
          entry.kind === "env" ? (entry.valuePreview ?? "") : "",
          entry.kind === "secret" ? (entry.allowedHosts ?? []).join(",") : "",
        ].join("\t"),
      );
    }
    return;
  }
  if (entries.length === 0) {
    defaultRuntime.log("No team secret store entries.");
    return;
  }
  for (const entry of entries) {
    const value = entry.kind === "env" ? ` = ${entry.valuePreview ?? ""}` : " (write-only)";
    const hosts =
      entry.kind === "secret"
        ? `; allowed hosts: ${(entry.allowedHosts ?? []).join(", ") || "none"}`
        : "";
    defaultRuntime.log(`${entry.name} [${entry.kind}]${value}${hosts}`);
  }
}

async function noteGatewayReload(): Promise<void> {
  try {
    const { readActiveGatewayLockIdentity } = await import("../infra/gateway-lock.js");
    if (await readActiveGatewayLockIdentity()) {
      defaultRuntime.log(
        "A gateway is running. Run `openclaw secrets reload` for config-referenced values to take effect.",
      );
    }
  } catch {
    // The store write is authoritative; gateway detection is only an actionable courtesy.
  }
}

async function confirmMutation(message: string, yes: boolean | undefined): Promise<void> {
  if (yes) {
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new SecretStoreCliFailure(2, `${message} Re-run with --yes in non-interactive mode.`);
  }
  const { confirm, isCancel } = await import("@clack/prompts");
  const approved = await confirm({ message, initialValue: false });
  if (isCancel(approved) || !approved) {
    throw new SecretStoreCliFailure(2, "Operation cancelled.");
  }
}

export function registerSecretStoreCli(secrets: Command): void {
  const store = secrets
    .command("store")
    .description("Manage the team-scoped SQLite secret and environment store")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/secrets", "docs.openclaw.ai/cli/secrets")}\n`,
    );

  store
    .command("list")
    .description("List stored names and non-secret metadata")
    .option("--scope <team>", "Store scope", "team")
    .option("--json", "Output JSON", false)
    .option("--plain", "Output tab-separated rows", false)
    .action((options: OutputOptions) =>
      runStoreAction(
        async () => {
          assertOutputMode(options);
          const scope = teamScope(options.scope);
          const { listSecretStoreEntries } = await import("../secrets/store/secret-store.js");
          return listSecretStoreEntries({ scope });
        },
        options.json,
        (entries) => renderList(entries, options),
      ),
    );

  store
    .command("set <NAME>")
    .description("Create or update one store entry")
    .option("--value <value>", "Literal value (env kind only)")
    .option("--value-file <path>", "Read value from a file; use - for stdin")
    .option("--kind <secret|env>", "Entry kind (defaults from NAME)")
    .option(
      "--allow-host <host>",
      "Allow substitution only for this exact host (repeatable)",
      (host: string, hosts: string[]) => [...hosts, host],
      [],
    )
    .option("--clear-allowed-hosts", "Remove all allowed hosts", false)
    .option("--scope <team>", "Store scope", "team")
    .option("--dry-run", "Validate without writing", false)
    .action((name: string, options: SetOptions) =>
      runStoreAction(async () => {
        assertStoreName(name);
        const scope = teamScope(options.scope);
        const storeModule = await import("../secrets/store/secret-store.js");
        const requestedHosts = options.allowHost ?? [];
        const hostPolicyRequested = requestedHosts.length > 0 || options.clearAllowedHosts === true;
        const existingEntry = hostPolicyRequested
          ? storeModule.listSecretStoreEntries({ scope }).find((entry) => entry.name === name)
          : undefined;
        const kind = options.kind
          ? storeKind(options.kind, name)
          : (existingEntry?.kind ?? storeKind(undefined, name));
        if (requestedHosts.length > 0 && options.clearAllowedHosts) {
          throw new SecretStoreCliFailure(
            2,
            "Use either --allow-host or --clear-allowed-hosts, not both.",
          );
        }
        if (kind === "env" && (requestedHosts.length > 0 || options.clearAllowedHosts)) {
          throw new SecretStoreCliFailure(2, "Allowed hosts apply only to secret entries.");
        }
        const allowedHosts =
          requestedHosts.length > 0
            ? storeModule.normalizeSecretAllowedHosts(requestedHosts)
            : options.clearAllowedHosts
              ? []
              : undefined;
        if (options.value !== undefined && options.valueFile !== undefined) {
          throw new SecretStoreCliFailure(2, "Use only one of --value or --value-file.");
        }
        // Secret argv values leak through shell history and process listings.
        if (kind === "secret" && options.value !== undefined) {
          throw new SecretStoreCliFailure(
            2,
            "--value is refused for secret entries. Use a stdin pipe, --value-file, or the interactive no-echo prompt.",
          );
        }
        const policyOnly =
          allowedHosts !== undefined &&
          options.value === undefined &&
          options.valueFile === undefined &&
          existingEntry?.kind === "secret";
        if (policyOnly) {
          if (options.dryRun) {
            defaultRuntime.log(`Would update allowed hosts for ${name}.`);
            return;
          }
          storeModule.updateSecretStoreAllowedHosts({
            scope,
            name,
            allowedHosts,
            updatedBy: "cli",
          });
          defaultRuntime.log(
            allowedHosts.length > 0
              ? `Allowed ${name} for ${allowedHosts.join(", ")}.`
              : `Cleared allowed hosts for ${name}.`,
          );
          return;
        }
        const value =
          options.value !== undefined
            ? options.value
            : await (
                await import("./secrets-store-input.js")
              ).readSecretStoreInput({
                valueFile: options.valueFile,
              });
        storeModule.assertSecretStoreValue(value, kind);
        if (options.dryRun) {
          defaultRuntime.log(`Would ${kind === "secret" ? "write" : "set"} ${name} (${kind}).`);
          return;
        }
        storeModule.writeSecretStoreEntry({
          scope,
          name,
          value,
          kind,
          ...(allowedHosts !== undefined ? { allowedHosts } : {}),
          updatedBy: "cli",
        });
        storeModule.purgeExpiredSecretStoreEntries();
        defaultRuntime.log(`Stored ${name} (${kind}).`);
        await noteGatewayReload();
      }),
    );

  store
    .command("get <NAME>")
    .description("Read an env-kind value; secret-kind values are write-only")
    .option("--scope <team>", "Store scope", "team")
    .option("--json", "Output JSON", false)
    .option("--plain", "Output only the env value", false)
    .action((name: string, options: OutputOptions) =>
      runStoreAction(
        async () => {
          assertOutputMode(options);
          assertStoreName(name);
          const scope = teamScope(options.scope);
          const { listSecretStoreEntries, readSecretStoreValue } =
            await import("../secrets/store/secret-store.js");
          const metadata = listSecretStoreEntries({ scope }).find((entry) => entry.name === name);
          if (!metadata) {
            throw new SecretStoreCliFailure(3, `Secret store entry "${name}" was not found.`);
          }
          if (metadata.kind === "secret") {
            throw new SecretStoreCliFailure(
              2,
              `Secret store entry "${name}" is write-only by design. Reference it from config with a store SecretRef.`,
            );
          }
          const result = readSecretStoreValue({ scope, name });
          if (!result.ok) {
            throw new SecretStoreCliFailure(
              result.error.code === "SECRET_STORE_NOT_FOUND" ? 3 : 1,
              result.error.message,
            );
          }
          return { name, kind: metadata.kind, value: result.value };
        },
        options.json,
        (result) => {
          if (options.plain) {
            defaultRuntime.writeStdout(result.value);
          } else {
            defaultRuntime.log(`${name}=${result.value}`);
          }
        },
      ),
    );

  store
    .command("rm <NAME...>")
    .description("Soft-delete one or more entries")
    .option("--scope <team>", "Store scope", "team")
    .option("--dry-run", "Show what would be removed", false)
    .option("--yes", "Skip confirmation", false)
    .action((names: string[], options: RemoveOptions) =>
      runStoreAction(async () => {
        const scope = teamScope(options.scope);
        for (const name of names) {
          assertStoreName(name);
        }
        if (options.dryRun) {
          defaultRuntime.log(
            `Would remove ${names.length} team store entr${names.length === 1 ? "y" : "ies"}.`,
          );
          return;
        }
        await confirmMutation(
          `Remove ${names.length} team store entr${names.length === 1 ? "y" : "ies"}?`,
          options.yes,
        );
        const { deleteSecretStoreEntry, purgeExpiredSecretStoreEntries } =
          await import("../secrets/store/secret-store.js");
        for (const name of names) {
          deleteSecretStoreEntry({ scope, name });
        }
        purgeExpiredSecretStoreEntries();
        defaultRuntime.log(
          `Removed ${names.length} team store entr${names.length === 1 ? "y" : "ies"}.`,
        );
        await noteGatewayReload();
      }),
    );

  store
    .command("import")
    .description("Import dotenv-formatted entries from a file or stdin")
    .option("--from <file>", "Dotenv file; use - or omit for stdin")
    .option("--kind <secret|env>", "Override the detected kind for all entries")
    .option("--scope <team>", "Store scope", "team")
    .option("--dry-run", "Validate without writing", false)
    .option("--yes", "Skip confirmation", false)
    .action((options: ImportOptions) =>
      runStoreAction(async () => {
        const scope = teamScope(options.scope);
        if (!options.from && process.stdin.isTTY) {
          throw new SecretStoreCliFailure(2, "Import requires --from <file> or piped stdin.");
        }
        const values = await (
          await import("./secrets-store-input.js")
        ).readSecretStoreImport(options.from);
        const entries = Object.entries(values);
        if (entries.length === 0) {
          throw new SecretStoreCliFailure(2, "Import input contains no dotenv assignments.");
        }
        const normalized = entries.map(([name, value]) => {
          assertStoreName(name);
          return { name, value, kind: storeKind(options.kind, name) };
        });
        const storeModule = await import("../secrets/store/secret-store.js");
        for (const entry of normalized) {
          storeModule.assertSecretStoreValue(entry.value, entry.kind);
        }
        if (options.dryRun) {
          defaultRuntime.log(`Would import ${normalized.length} team store entries.`);
          return;
        }
        await confirmMutation(`Import ${normalized.length} team store entries?`, options.yes);
        for (const entry of normalized) {
          storeModule.writeSecretStoreEntry({ scope, ...entry, updatedBy: "cli" });
        }
        storeModule.purgeExpiredSecretStoreEntries();
        defaultRuntime.log(`Imported ${normalized.length} team store entries.`);
        await noteGatewayReload();
      }),
    );
}
