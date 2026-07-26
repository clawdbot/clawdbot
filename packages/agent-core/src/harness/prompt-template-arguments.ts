export interface PromptTemplate {
  name: string;
  description?: string;
  content: string;
}

/** Parse an argument string using simple shell-style single and double quotes. */
export function parseCommandArgs(argsString: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuote: string | null = null;
  let hasToken = false;

  for (const char of argsString) {
    if (inQuote) {
      if (char === inQuote) {
        inQuote = null;
      } else {
        hasToken = true;
        current += char;
      }
    } else if (char === '"' || char === "'") {
      hasToken = true;
      inQuote = char;
    } else if (/\s/.test(char)) {
      if (hasToken) {
        args.push(current);
        current = "";
        hasToken = false;
      }
    } else {
      hasToken = true;
      current += char;
    }
  }
  if (hasToken) {
    args.push(current);
  }
  return args;
}

function parseSafeNonNegativeInteger(raw: string): number | undefined {
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * Substitute prompt template placeholders (`$1`, `$@`, `$ARGUMENTS`, `${@:N}`, `${@:N:L}`) with command arguments.
 *
 * Unsafe integer placeholders resolve to empty text instead of throwing, so malformed templates cannot abort prompt
 * loading or invocation.
 */
export function substituteArgs(content: string, args: string[]): string {
  let result = content;
  result = result.replace(/\$(\d+)/g, (_, num: string) => {
    const parsed = parseSafeNonNegativeInteger(num);
    if (parsed === undefined || parsed <= 0) {
      return "";
    }
    return args[parsed - 1] ?? "";
  });
  result = result.replace(
    /\$\{@:(\d+)(?::(\d+))?\}/g,
    (_, startStr: string, lengthStr?: string) => {
      const parsedStart = parseSafeNonNegativeInteger(startStr);
      if (parsedStart === undefined) {
        return "";
      }
      // Keep shell-style `${@:0:...}` compatibility: start 0 includes `$0` in shell, but
      // prompt templates have no command name, so it maps to the first provided argument.
      let start = parsedStart - 1;
      if (start < 0) {
        start = 0;
      }
      if (lengthStr) {
        const length = parseSafeNonNegativeInteger(lengthStr);
        if (length === undefined) {
          return "";
        }
        return args.slice(start, start + length).join(" ");
      }
      return args.slice(start).join(" ");
    },
  );
  const allArgs = args.join(" ");
  result = result.replace(/\$ARGUMENTS/g, allArgs);
  result = result.replace(/\$@/g, allArgs);
  return result;
}
