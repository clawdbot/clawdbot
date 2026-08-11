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

type OutputOptions = { json?: boolean; plain?: boolean; scope?: string };
type SetOptions = {
  value?: string;
  valueFile?: string;
  kind?: string;
  scope?: string;
  dryRun?: boolean;
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
      validation.code === "SECRET_STORE_VALUE_EMPTY")
  ) {
    return new SecretStoreCliFailure(2, validation.message ?? "Invalid secret store input.");
  }
  return new SecretStoreCliFailure(1, formatErrorMessage(error));
}

async function runStoreAction(action: () => Promise<void>): Promise<void> {
  let failure: SecretStoreCliFailure | undefined;
  try {
    await action();
  } catch (error) {
    failure = mapStoreError(error);
  }
  if (!failure) {
    return;
  }
  defaultRuntime.error(danger(failure.message));
  defaultRuntime.exit(failure.exitCode);
}

function renderList(entries: SecretStoreEntryMetadata[], options: OutputOptions): void {
  if (options.json) {
    defaultRuntime.writeJson(entries);
    return;
  }
  if (options.plain) {
    for (const entry of entries) {
      defaultRuntime.writeStdout(
        [entry.name, entry.kind, entry.kind === "env" ? (entry.valuePreview ?? "") : ""].join("\t"),
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
    defaultRuntime.log(`${entry.name} [${entry.kind}]${value}`);
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
      runStoreAction(async () => {
        assertOutputMode(options);
        const scope = teamScope(options.scope);
        const { listSecretStoreEntries } = await import("../secrets/store/secret-store.js");
        renderList(listSecretStoreEntries({ scope }), options);
      }),
    );

  store
    .command("set <NAME>")
    .description("Create or update one store entry")
    .option("--value <value>", "Literal value (env kind only)")
    .option("--value-file <path>", "Read value from a file; use - for stdin")
    .option("--kind <secret|env>", "Entry kind (defaults from NAME)")
    .option("--scope <team>", "Store scope", "team")
    .option("--dry-run", "Validate without writing", false)
    .action((name: string, options: SetOptions) =>
      runStoreAction(async () => {
        assertStoreName(name);
        const scope = teamScope(options.scope);
        const kind = storeKind(options.kind, name);
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
        const value =
          options.value !== undefined
            ? options.value
            : await (
                await import("./secrets-store-input.js")
              ).readSecretStoreInput({
                valueFile: options.valueFile,
              });
        const storeModule = await import("../secrets/store/secret-store.js");
        if (Buffer.byteLength(value, "utf8") > storeModule.SECRET_STORE_VALUE_MAX_BYTES) {
          throw new SecretStoreCliFailure(
            2,
            `Value exceeds ${storeModule.SECRET_STORE_VALUE_MAX_BYTES} UTF-8 bytes.`,
          );
        }
        if (options.dryRun) {
          defaultRuntime.log(`Would ${kind === "secret" ? "write" : "set"} ${name} (${kind}).`);
          return;
        }
        storeModule.writeSecretStoreEntry({ scope, name, value, kind, updatedBy: "cli" });
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
      runStoreAction(async () => {
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
        if (options.json) {
          defaultRuntime.writeJson({ name, kind: metadata.kind, value: result.value });
        } else if (options.plain) {
          defaultRuntime.writeStdout(result.value);
        } else {
          defaultRuntime.log(`${name}=${result.value}`);
        }
      }),
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
          if (Buffer.byteLength(entry.value, "utf8") > storeModule.SECRET_STORE_VALUE_MAX_BYTES) {
            throw new SecretStoreCliFailure(
              2,
              `${entry.name} exceeds ${storeModule.SECRET_STORE_VALUE_MAX_BYTES} UTF-8 bytes.`,
            );
          }
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
