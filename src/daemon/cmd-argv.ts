/** Windows cmd argument quoting and parser mirror used by service tests. */
import { splitArgsPreservingQuotes } from "./arg-split.js";
import { assertNoCmdLineBreak } from "./cmd-set.js";

export function quoteCmdScriptArg(
  value: string,
  options: { delayedExpansion?: boolean } = {},
): string {
  assertNoCmdLineBreak(value, "Command argument");
  if (!value) {
    return '""';
  }
  const quoted = value.replace(/(\\*)"/g, (_match, slashes: string) => `${slashes}${slashes}\\"`);
  const expanded = quoted.replace(/%/g, "%%");
  const escaped = options.delayedExpansion === false ? expanded : expanded.replace(/!/g, "^!");
  if (!/[ \t"&|<>^()%!]/g.test(value)) {
    return escaped;
  }
  // A trailing backslash would otherwise escape the wrapper quote (`\"`).
  return `"${escaped.replace(/(\\+)$/, (slashes) => slashes + slashes)}"`;
}

function unescapeCmdScriptArg(value: string): string {
  return value.replace(/\^!/g, "!").replace(/%%/g, "%");
}

export function parseCmdScriptCommandLine(value: string): string[] {
  // Script renderer uses CommandLineToArgvW quote rules plus cmd expansions
  // (`%%`, `^!`). Drive and UNC backslashes stay literal unless they precede ".
  return splitArgsPreservingQuotes(value, { escapeMode: "windows-cmd" }).map(unescapeCmdScriptArg);
}
