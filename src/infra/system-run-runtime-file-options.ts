/** Rejects runtime options whose file/cwd effects cannot fit one operand binding. */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { parseInlineOptionToken } from "./inline-option-token.js";
import {
  BUN_UNBINDABLE_APPROVAL_OPTIONS,
  DENO_UNBINDABLE_APPROVAL_OPTIONS,
} from "./system-run-mutable-file-options.js";

function hasListedOption(argv: string[], options: ReadonlySet<string>): boolean {
  return argv
    .slice(1)
    .some((token) =>
      options.has(normalizeLowercaseStringOrEmpty(parseInlineOptionToken(token).name)),
    );
}

function hasPhpUnbindableOption(argv: string[]): boolean {
  return argv.slice(1).some((token) => {
    const normalized = token.trim().toLowerCase();
    return (
      normalized === "-c" ||
      normalized.startsWith("-c=") ||
      normalized === "--php-ini" ||
      normalized.startsWith("--php-ini=") ||
      normalized === "-d" ||
      normalized.startsWith("-d")
    );
  });
}

export function hasUnbindableRuntimeApprovalOption(params: {
  argv: string[];
  executable: string;
}): boolean {
  if (params.executable === "bun") {
    return hasListedOption(params.argv, BUN_UNBINDABLE_APPROVAL_OPTIONS);
  }
  if (params.executable === "deno") {
    return hasListedOption(params.argv, DENO_UNBINDABLE_APPROVAL_OPTIONS);
  }
  return params.executable === "php" && hasPhpUnbindableOption(params.argv);
}
