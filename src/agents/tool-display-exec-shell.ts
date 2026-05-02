import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";

type PreambleResult = {
  command: string;
  chdirPath?: string;
};

export function stripOuterQuotes(value: string | undefined): string | undefined {
  if (!value) {
    return value;
  }
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function splitShellWords(input: string | undefined, maxWords = 48): string[] {
  if (!input) {
    return [];
  }

  const words: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let escaped = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (!current) {
        continue;
      }
      words.push(current);
      if (words.length >= maxWords) {
        return words;
      }
      current = "";
      continue;
    }

    current += char;
  }

  if (current) {
    words.push(current);
  }
  return words;
}

export function binaryName(token: string | undefined): string | undefined {
  if (!token) {
    return undefined;
  }
  const cleaned = stripOuterQuotes(token) ?? token;
  const segment = cleaned.split(/[/]/).at(-1) ?? cleaned;
  return normalizeLowercaseStringOrEmpty(segment);
}

export function optionValue(words: string[], names: string[]): string | undefined {
  const lookup = new Set(names);

  for (let i = 0; i < words.length; i += 1) {
    const token = words[i];
    if (!token) {
      continue;
    }

    if (lookup.has(token)) {
      const value = words[i + 1];
      if (value && !value.startsWith("-")) {
        return value;
      }
      continue;
    }

    for (const name of names) {
      if (name.startsWith("--") && token.startsWith(`${name}=`)) {
        return token.slice(name.length + 1);
      }
    }
  }

  return undefined;
}

export function positionalArgs(
  words: string[],
  from = 1,
  optionsWithValue: string[] = [],
): string[] {
  const args: string[] = [];
  const takesValue = new Set(optionsWithValue);

  for (let i = from; i < words.length; i += 1) {
    const token = words[i];
    if (!token) {
      continue;
    }

    if (token === "--") {
      for (let j = i + 1; j < words.length; j += 1) {
        const candidate = words[j];
        if (candidate) {
          args.push(candidate);
        }
      }
      break;
    }

    if (token.startsWith("--")) {
      if (token.includes("=")) {
        continue;
      }
      if (takesValue.has(token)) {
        i += 1;
      }
      continue;
    }

    if (token.startsWith("-")) {
      if (takesValue.has(token)) {
        i += 1;
      }
      continue;
    }

    args.push(token);
  }

  return args;
}

export function firstPositional(
  words: string[],
  from = 1,
  optionsWithValue: string[] = [],
): string | undefined {
  return positionalArgs(words, from, optionsWithValue)[0];
}

export function trimLeadingEnv(words: string[]): string[] {
  if (words.length === 0) {
    return words;
  }

  let index = 0;
  if (binaryName(words[0]) === "env") {
    index = 1;
    while (index < words.length) {
      const token = words[index];
      if (!token) {
        break;
      }
      if (token.startsWith("-")) {
        index += 1;
        continue;
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
        index += 1;
        continue;
      }
      break;
    }
    return words.slice(index);
  }

  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index])) {
    index += 1;
  }
  return words.slice(index);
}

export function unwrapShellWrapper(command: string): string {
  const words = splitShellWords(command, 10);
  if (words.length < 3) {
    return command;
  }

  const bin = binaryName(words[0]);
  if (!(bin === "bash" || bin === "sh" || bin === "zsh" || bin === "fish")) {
    return command;
  }

  const flagIndex = words.findIndex(
    (token, index) => index > 0 && (token === "-c" || token === "-lc" || token === "-ic"),
  );
  if (flagIndex === -1) {
    return command;
  }

  const inner = words
    .slice(flagIndex + 1)
    .join(" ")
    .trim();
  return inner ? (stripOuterQuotes(inner) ?? command) : command;
}

function scanTopLevelChars(
  command: string,
  visit: (char: string, index: number) => boolean | void,
): void {
  let quote: '"' | "'" | undefined;
  let escaped = false;

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (visit(char, i) === false) {
      return;
    }
  }
}

export function splitTopLevelStages(command: string): string[] {
  const parts: string[] = [];
  let start = 0;

  scanTopLevelChars(command, (char, index) => {
    if (char === ";") {
      parts.push(command.slice(start, index));
      start = index + 1;
      return true;
    }
    if ((char === "&" || char === "|") && command[index + 1] === char) {
      parts.push(command.slice(start, index));
      start = index + 2;
      return true;
    }
    return true;
  });

  parts.push(command.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

export function splitTopLevelPipes(command: string): string[] {
  const parts: string[] = [];
  let start = 0;

  scanTopLevelChars(command, (char, index) => {
    if (char === "|" && command[index - 1] !== "|" && command[index + 1] !== "|") {
      parts.push(command.slice(start, index));
      start = index + 1;
    }
    return true;
  });

  parts.push(command.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

function parseChdirTarget(head: string): string | undefined {
  const words = splitShellWords(head, 3);
  const bin = binaryName(words[0]);
  if (bin === "cd" || bin === "pushd") {
    return words[1] || undefined;
  }
  return undefined;
}

function isChdirCommand(head: string): boolean {
  const bin = binaryName(splitShellWords(head, 2)[0]);
  return bin === "cd" || bin === "pushd" || bin === "popd";
}

function isPopdCommand(head: string): boolean {
  return binaryName(splitShellWords(head, 2)[0]) === "popd";
}

export function stripShellPreamble(command: string): PreambleResult {
  let rest = command.trim();
  let chdirPath: string | undefined;

  for (let i = 0; i < 4; i += 1) {
    let first: { index: number; length: number; isOr?: boolean } | undefined;
    scanTopLevelChars(rest, (char, idx) => {
      if (char === "&" && rest[idx + 1] === "&") {
        first = { index: idx, length: 2 };
        return false;
      }
      if (char === "|" && rest[idx + 1] === "|") {
        first = { index: idx, length: 2, isOr: true };
        return false;
      }
      if (char === ";" || char === "\n") {
        first = { index: idx, length: 1 };
        return false;
      }
      return undefined;
    });
    const head = (first ? rest.slice(0, first.index) : rest).trim();
    const isChdir = (first ? !first.isOr : i > 0) && isChdirCommand(head);
    const isPreamble =
      head.startsWith("set ") || head.startsWith("export ") || head.startsWith("unset ") || isChdir;

    if (!isPreamble) {
      break;
    }

    if (isChdir) {
      if (isPopdCommand(head)) {
        chdirPath = undefined;
      } else {
        chdirPath = parseChdirTarget(head) ?? chdirPath;
      }
    }

    rest = first ? rest.slice(first.index + first.length).trimStart() : "";
    if (!rest) {
      break;
    }
  }

  return { command: rest.trim(), chdirPath };
}
