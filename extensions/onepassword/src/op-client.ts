import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
import { runExec } from "openclaw/plugin-sdk/process-runtime";
import { tryReadSecretFileSync } from "openclaw/plugin-sdk/secret-file-runtime";
import { OnePasswordError } from "./errors.js";

const MAX_STDOUT_BYTES = 1024 * 1024;

type OpProcessResult = {
  stdout: string;
  stderr: string;
};

type OpProcessOptions = {
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxBufferBytes: number;
};

type OpProcessRunner = (
  file: string,
  args: string[],
  options: OpProcessOptions,
) => Promise<OpProcessResult>;

export type ResolvedSecret = {
  value: string;
  itemTitle: string;
  fieldLabel: string;
};

type OpClientOptions = {
  opBin?: string;
  tokenFile: string;
  timeoutMs: number;
  runner?: OpProcessRunner;
  home?: string;
  pathEnv?: string;
  warn?: (message: string) => void;
};

type OpField = {
  id?: unknown;
  label?: unknown;
  value?: unknown;
};

async function defaultRunner(
  file: string,
  args: string[],
  options: OpProcessOptions,
): Promise<OpProcessResult> {
  return await runExec(file, args, {
    baseEnv: {},
    env: options.env,
    logOutput: false,
    maxBuffer: options.maxBufferBytes,
    timeoutMs: options.timeoutMs,
  });
}

function isExecutable(filePath: string): boolean {
  try {
    fsSync.accessSync(filePath, fsSync.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveOpBinary(configuredPath: string | undefined, pathEnv: string): string | undefined {
  if (configuredPath) {
    return isExecutable(configuredPath) ? configuredPath : undefined;
  }
  const executable = process.platform === "win32" ? "op.exe" : "op";
  for (const directory of pathEnv.split(path.delimiter)) {
    if (!directory) {
      continue;
    }
    const candidate = path.resolve(directory, executable);
    if (isExecutable(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function errorRecord(error: unknown): Record<string, unknown> {
  return error && typeof error === "object" ? (error as Record<string, unknown>) : {};
}

function classifyOpError(error: unknown): OnePasswordError {
  if (error instanceof OnePasswordError) {
    return error;
  }
  const record = errorRecord(error);
  const stderr = typeof record.stderr === "string" ? record.stderr : "";
  const normalized = stderr.toLowerCase();
  if (record.code === "ENOENT") {
    return new OnePasswordError("OP_NOT_FOUND", "1Password CLI executable was not found");
  }
  if (
    record.killed === true ||
    record.timedOut === true ||
    record.code === "ETIMEDOUT" ||
    record.signal === "SIGTERM"
  ) {
    return new OnePasswordError("TIMEOUT", "1Password CLI request timed out");
  }
  if (
    /item.+(is not found|isn't found|not found|does not exist)|could not find.+item|isn't an item\b/u.test(
      normalized,
    )
  ) {
    return new OnePasswordError("ITEM_NOT_FOUND", "1Password item was not found");
  }
  if (
    /isn't a field\b|field.+(?:is not found|isn't found|not found|does not exist)/u.test(normalized)
  ) {
    return new OnePasswordError("FIELD_NOT_FOUND", "1Password field was not found");
  }
  if (
    /unauthorized|authentication|not signed in|invalid service account|permission denied/u.test(
      normalized,
    )
  ) {
    return new OnePasswordError("AUTH_FAILED", "1Password service account authentication failed");
  }
  if (/\b429\b|rate[ -]?limit|too many requests/u.test(normalized)) {
    return new OnePasswordError("RATE_LIMITED", "1Password rate limit reached");
  }
  return new OnePasswordError("OP_ERROR", "1Password CLI request failed");
}

function parseField(stdout: string, requestedField: string, itemTitle: string): ResolvedSecret {
  let field: OpField;
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("field response is not an object");
    }
    field = parsed as OpField;
  } catch (error) {
    throw new OnePasswordError("OP_ERROR", "1Password CLI returned invalid JSON", {
      cause: error,
    });
  }
  if (
    (field.label !== requestedField && field.id !== requestedField) ||
    typeof field.value !== "string"
  ) {
    throw new OnePasswordError(
      "FIELD_NOT_FOUND",
      `1Password field ${requestedField} was not found`,
    );
  }
  return {
    value: field.value,
    itemTitle,
    fieldLabel: typeof field.label === "string" ? field.label : requestedField,
  };
}

export class OpClient {
  readonly opBin: string | undefined;
  readonly tokenFile: string;
  private readonly timeoutMs: number;
  private readonly runner: OpProcessRunner;
  private readonly home: string;
  private readonly warn: (message: string) => void;
  private permissionWarningEmitted = false;

  constructor(options: OpClientOptions) {
    this.opBin = resolveOpBinary(options.opBin, options.pathEnv ?? process.env.PATH ?? "");
    this.tokenFile = options.tokenFile;
    this.timeoutMs = options.timeoutMs;
    this.runner = options.runner ?? defaultRunner;
    this.home = options.home ?? os.homedir();
    this.warn = options.warn ?? (() => undefined);
  }

  async tokenFilePresent(): Promise<boolean> {
    try {
      await fs.access(this.tokenFile, fsSync.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  private async readToken(): Promise<string> {
    let contents: string | undefined;
    try {
      contents = tryReadSecretFileSync(this.tokenFile, "1Password service account token", {
        rejectHardlinks: false,
      });
      const stat = await fs.stat(this.tokenFile);
      if (
        !this.permissionWarningEmitted &&
        process.platform !== "win32" &&
        (stat.mode & 0o077) !== 0
      ) {
        this.permissionWarningEmitted = true;
        this.warn("1Password service account token file permissions are broader than 0600");
      }
    } catch (error) {
      const message =
        error instanceof Error && extractErrorCode(error) === "too-large"
          ? error.message
          : "1Password service account token file is missing";
      throw new OnePasswordError("TOKEN_MISSING", message, { cause: error });
    }
    if (!contents) {
      throw new OnePasswordError("TOKEN_MISSING", "1Password service account token file is empty");
    }
    return contents;
  }

  async getItem(params: { item: string; vault: string; field: string }): Promise<ResolvedSecret> {
    if (!this.opBin) {
      throw new OnePasswordError("OP_NOT_FOUND", "1Password CLI executable was not found");
    }
    const token = await this.readToken();
    const args = [
      "item",
      "get",
      params.item,
      "--vault",
      params.vault,
      "--fields",
      params.field,
      "--format",
      "json",
      "--cache=false",
    ];
    try {
      const result = await this.runner(this.opBin, args, {
        env: {
          OP_SERVICE_ACCOUNT_TOKEN: token,
          HOME: this.home,
        },
        timeoutMs: this.timeoutMs,
        maxBufferBytes: MAX_STDOUT_BYTES,
      });
      return parseField(result.stdout, params.field, params.item);
    } catch (error) {
      throw classifyOpError(error);
    }
  }
}
