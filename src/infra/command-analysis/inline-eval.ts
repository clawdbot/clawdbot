// Interpreter inline-eval detection recognizes flags and positional program
// forms that execute command text without reading a script file.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { normalizeExecutableToken } from "../exec-wrapper-resolution.js";

export type InterpreterInlineEvalHit = {
  executable: string;
  normalizedExecutable: string;
  flag: string;
  argv: string[];
};

type PrefixFlagSpec = {
  label: string;
  prefix: string;
};

type AbbreviatedFlagSpec = {
  label: string;
  full: string;
  min: string;
};

type InterpreterFlagSpec = {
  names: readonly string[];
  exactFlags: ReadonlySet<string>;
  rawExactFlags?: ReadonlyMap<string, string>;
  rawPrefixFlags?: readonly PrefixFlagSpec[];
  abbreviatedFlags?: readonly AbbreviatedFlagSpec[];
  joinedExactFlags?: ReadonlySet<string>;
  joinedRawExactFlags?: ReadonlyMap<string, string>;
  joinedFlagDenyExact?: ReadonlySet<string>;
  joinedFlagDenyPrefixes?: readonly string[];
  prefixFlags?: readonly PrefixFlagSpec[];
  shortClusterFlags?: readonly ShortClusterFlagSpec[];
  scanPastDoubleDash?: boolean;
};

type ShortClusterFlagSpec = {
  label: string;
  flag: string;
  prefixChars: ReadonlySet<string>;
  allowNumericRecordSeparator?: boolean;
  numericValuePrefixChars?: ReadonlySet<string>;
};

type PositionalInterpreterSpec = {
  names: readonly string[];
  fileFlags?: ReadonlySet<string>;
  fileFlagPrefixes?: readonly string[];
  exactValueFlags?: ReadonlySet<string>;
  exactOptionalValueFlags?: ReadonlySet<string>;
  prefixValueFlags?: readonly string[];
  flag: "<command>" | "<program>";
};

const VERSION_SUFFIX_PATTERN = /-?\d+(?:\.\d+)*$/;

const FLAG_INTERPRETER_INLINE_EVAL_SPECS: readonly InterpreterFlagSpec[] = [
  {
    names: ["python", "python2", "python3", "pypy", "pypy3"],
    exactFlags: new Set(["-c"]),
    shortClusterFlags: [
      {
        label: "-c",
        flag: "c",
        prefixChars: new Set([
          "B",
          "E",
          "I",
          "O",
          "P",
          "R",
          "S",
          "b",
          "d",
          "i",
          "q",
          "s",
          "u",
          "v",
          "x",
        ]),
      },
    ],
  },
  {
    names: ["node", "nodejs", "bun", "deno"],
    exactFlags: new Set(["-e", "--eval", "-p", "--print"]),
  },
  {
    names: ["awk", "gawk", "mawk", "nawk"],
    exactFlags: new Set(["-e", "--source"]),
    prefixFlags: [{ label: "--source", prefix: "--source=" }],
  },
  {
    names: ["ruby"],
    exactFlags: new Set(["-e"]),
    shortClusterFlags: [
      {
        label: "-e",
        flag: "e",
        prefixChars: new Set(["S", "U", "W", "a", "c", "d", "l", "n", "p", "s", "v", "w"]),
        allowNumericRecordSeparator: true,
        numericValuePrefixChars: new Set(["W"]),
      },
    ],
  },
  {
    names: ["perl"],
    exactFlags: new Set(["-e", "-E"]),
    shortClusterFlags: [
      {
        label: "-e",
        flag: "e",
        prefixChars: new Set([
          "S",
          "T",
          "W",
          "X",
          "U",
          "V",
          "a",
          "c",
          "d",
          "f",
          "l",
          "n",
          "p",
          "s",
          "t",
          "u",
          "w",
        ]),
        allowNumericRecordSeparator: true,
        numericValuePrefixChars: new Set(["l"]),
      },
      {
        label: "-e",
        flag: "E",
        prefixChars: new Set([
          "S",
          "T",
          "W",
          "X",
          "U",
          "V",
          "a",
          "c",
          "d",
          "f",
          "l",
          "n",
          "p",
          "s",
          "t",
          "u",
          "w",
        ]),
        allowNumericRecordSeparator: true,
        numericValuePrefixChars: new Set(["l"]),
      },
    ],
  },
  {
    names: ["php"],
    exactFlags: new Set(["-r"]),
    rawExactFlags: new Map([
      ["-B", "-B"],
      ["-E", "-E"],
      ["-R", "-R"],
    ]),
  },
  { names: ["r", "rscript"], exactFlags: new Set(["-e"]) },
  {
    names: ["julia"],
    exactFlags: new Set(["-e", "--eval", "--print"]),
    rawExactFlags: new Map([["-E", "-E"]]),
  },
  {
    names: ["elixir", "iex"],
    exactFlags: new Set(["-e", "--eval", "--rpc-eval"]),
    joinedExactFlags: new Set(),
  },
  { names: ["guile"], exactFlags: new Set(["-c", "-e"]), joinedExactFlags: new Set() },
  {
    names: ["groovy"],
    exactFlags: new Set(["-e"]),
    joinedFlagDenyExact: new Set(["-encoding"]),
    joinedFlagDenyPrefixes: ["-encoding="],
    shortClusterFlags: [
      {
        label: "-e",
        flag: "e",
        prefixChars: new Set(["n", "p"]),
      },
    ],
  },
  {
    names: ["scala", "scala-cli"],
    exactFlags: new Set([
      "-e",
      "--script-snippet",
      "--execute-script",
      "--execute-sc",
      "--execute-scala-script",
      "--scala-snippet",
      "--execute-scala",
      "--java-snippet",
      "--execute-java",
      "--markdown-snippet",
      "--md-snippet",
      "--execute-markdown",
      "--execute-md",
    ]),
    joinedExactFlags: new Set(),
  },
  { names: ["clojure", "clj"], exactFlags: new Set(["-e", "--eval"]), joinedExactFlags: new Set() },
  {
    names: ["raku", "perl6"],
    exactFlags: new Set(["-e"]),
    joinedExactFlags: new Set(["-e"]),
    shortClusterFlags: [
      {
        label: "-e",
        flag: "e",
        prefixChars: new Set(["n", "p"]),
      },
    ],
  },
  { names: ["ghc", "ghci"], exactFlags: new Set(["-e"]), joinedExactFlags: new Set() },
  {
    names: ["erl", "werl"],
    exactFlags: new Set(["-eval", "-run", "-s"]),
    joinedExactFlags: new Set(),
  },
  {
    names: ["gdb"],
    exactFlags: new Set([
      "-ex",
      "-iex",
      "-eiex",
      "-eval-command",
      "--eval-command",
      "-init-eval-command",
      "--init-eval-command",
      "-early-init-eval-command",
      "--early-init-eval-command",
    ]),
    abbreviatedFlags: [
      { label: "-eval-command", full: "-eval-command", min: "-ev" },
      { label: "--eval-command", full: "--eval-command", min: "--ev" },
      { label: "-init-eval-command", full: "-init-eval-command", min: "-init-e" },
      { label: "--init-eval-command", full: "--init-eval-command", min: "--init-e" },
      {
        label: "-early-init-eval-command",
        full: "-early-init-eval-command",
        min: "-early-init-e",
      },
      {
        label: "--early-init-eval-command",
        full: "--early-init-eval-command",
        min: "--early-init-e",
      },
    ],
    prefixFlags: [
      { label: "-ex", prefix: "-ex=" },
      { label: "-iex", prefix: "-iex=" },
      { label: "-eiex", prefix: "-eiex=" },
      { label: "-eval-command", prefix: "-eval-command=" },
      { label: "-init-eval-command", prefix: "-init-eval-command=" },
      { label: "-early-init-eval-command", prefix: "-early-init-eval-command=" },
    ],
  },
  { names: ["expect"], exactFlags: new Set(["-c"]) },
  { names: ["lua"], exactFlags: new Set(["-e"]) },
  { names: ["osascript"], exactFlags: new Set(["-e"]) },
  {
    names: ["find"],
    exactFlags: new Set(["-exec", "-execdir", "-ok", "-okdir"]),
    scanPastDoubleDash: true,
  },
  {
    names: ["make", "gmake"],
    exactFlags: new Set(["-f", "--file", "--makefile", "--eval"]),
    rawExactFlags: new Map([["-E", "-E"]]),
    rawPrefixFlags: [{ label: "-E", prefix: "-E" }],
    prefixFlags: [
      { label: "-f", prefix: "-f" },
      { label: "--file", prefix: "--file=" },
      { label: "--makefile", prefix: "--makefile=" },
      { label: "--eval", prefix: "--eval=" },
    ],
  },
  {
    names: ["sed", "gsed"],
    exactFlags: new Set(),
    rawExactFlags: new Map([["-e", "-e"]]),
    rawPrefixFlags: [{ label: "-e", prefix: "-e" }],
  },
];

const POSITIONAL_INTERPRETER_INLINE_EVAL_SPECS: readonly PositionalInterpreterSpec[] = [
  {
    names: ["awk", "gawk", "mawk", "nawk"],
    fileFlags: new Set(["-f", "--file"]),
    fileFlagPrefixes: ["-f", "--file="],
    exactValueFlags: new Set([
      "-f",
      "--file",
      "-F",
      "--field-separator",
      "-v",
      "--assign",
      "-i",
      "--include",
      "-l",
      "--load",
      "-W",
    ]),
    prefixValueFlags: ["-F", "--field-separator=", "-v", "--assign=", "--include=", "--load="],
    flag: "<program>",
  },
  {
    names: ["xargs"],
    exactValueFlags: new Set([
      "-a",
      "--arg-file",
      "-d",
      "--delimiter",
      "-E",
      "-I",
      "-L",
      "--max-lines",
      "-n",
      "--max-args",
      "-P",
      "--max-procs",
      "-s",
      "--max-chars",
    ]),
    exactOptionalValueFlags: new Set(["--eof", "--replace"]),
    prefixValueFlags: [
      "-a",
      "--arg-file=",
      "-d",
      "--delimiter=",
      "-E",
      "--eof=",
      "-I",
      "--replace=",
      "-i",
      "-L",
      "--max-lines=",
      "-l",
      "-n",
      "--max-args=",
      "-P",
      "--max-procs=",
      "-s",
      "--max-chars=",
    ],
    flag: "<command>",
  },
  {
    names: ["sed", "gsed"],
    fileFlags: new Set(["-f", "--file"]),
    fileFlagPrefixes: ["-f", "--file="],
    exactValueFlags: new Set(["-f", "--file", "-l", "--line-length"]),
    exactOptionalValueFlags: new Set(["-i", "--in-place"]),
    prefixValueFlags: ["-f", "--file=", "--in-place=", "--line-length="],
    flag: "<program>",
  },
];

const INTERPRETER_ALLOWLIST_NAMES = new Set(
  FLAG_INTERPRETER_INLINE_EVAL_SPECS.flatMap((entry) => entry.names).concat(
    POSITIONAL_INTERPRETER_INLINE_EVAL_SPECS.flatMap((entry) => entry.names),
  ),
);

function stripInterpreterVersionSuffix(value: string): string {
  const stripped = value.replace(VERSION_SUFFIX_PATTERN, "");
  return stripped.length > 0 ? stripped : value;
}

function interpreterNameVariants(value: string): readonly string[] {
  const stripped = stripInterpreterVersionSuffix(value);
  // Do not synthesize one-letter interpreter names: commands like r2 can use
  // their own eval flags and must not be mistaken for R inline execution.
  return stripped === value || stripped.length < 2 ? [value] : [value, stripped];
}

function specNamesInclude(names: readonly string[], normalizedExecutable: string): boolean {
  return interpreterNameVariants(normalizedExecutable).some((candidate) =>
    names.includes(candidate),
  );
}

function findInterpreterSpec(executable: string): InterpreterFlagSpec | null {
  const normalized = normalizeExecutableToken(executable);
  for (const spec of FLAG_INTERPRETER_INLINE_EVAL_SPECS) {
    if (specNamesInclude(spec.names, normalized)) {
      return spec;
    }
  }
  return null;
}

function findPositionalInterpreterSpec(executable: string): PositionalInterpreterSpec | null {
  const normalized = normalizeExecutableToken(executable);
  for (const spec of POSITIONAL_INTERPRETER_INLINE_EVAL_SPECS) {
    if (specNamesInclude(spec.names, normalized)) {
      return spec;
    }
  }
  return null;
}

function createInlineEvalHit(
  executable: string,
  argv: string[],
  flag: string,
): InterpreterInlineEvalHit {
  return {
    executable,
    normalizedExecutable: normalizeExecutableToken(executable),
    flag,
    argv,
  };
}

function matchAbbreviatedFlag(spec: InterpreterFlagSpec, lower: string): string | null {
  const optionName = lower.split("=", 1)[0] ?? lower;
  for (const flag of spec.abbreviatedFlags ?? []) {
    if (
      optionName.length >= flag.min.length &&
      flag.full.startsWith(optionName) &&
      flag.min.startsWith(optionName.slice(0, flag.min.length))
    ) {
      return flag.label;
    }
  }
  return null;
}

function matchJoinedExactFlag(
  spec: InterpreterFlagSpec,
  token: string,
  lower: string,
): string | null {
  if (
    spec.joinedFlagDenyExact?.has(lower) === true ||
    spec.joinedFlagDenyPrefixes?.some((prefix) => lower.startsWith(prefix)) === true
  ) {
    return null;
  }
  for (const flag of spec.exactFlags) {
    if (flag.startsWith("--")) {
      const prefix = `${flag}=`;
      if (lower.startsWith(prefix) && lower.length > prefix.length) {
        return flag;
      }
    }
  }
  for (const flag of spec.joinedExactFlags ?? spec.exactFlags) {
    if (/^-[A-Za-z]$/.test(flag) && token.startsWith(flag) && token.length > flag.length) {
      return normalizeLowercaseStringOrEmpty(flag);
    }
  }
  return null;
}

function matchJoinedRawExactFlag(spec: InterpreterFlagSpec, token: string): string | null {
  for (const [flag, label] of spec.joinedRawExactFlags ?? spec.rawExactFlags ?? []) {
    if (/^-[A-Za-z]$/.test(flag) && token.startsWith(flag) && token.length > flag.length) {
      return label;
    }
  }
  return null;
}

function matchShortClusterFlag(spec: InterpreterFlagSpec, token: string): string | null {
  if (!token.startsWith("-") || token.startsWith("--")) {
    return null;
  }
  for (const clusterFlag of spec.shortClusterFlags ?? []) {
    const index = token.indexOf(clusterFlag.flag, 2);
    if (index < 2) {
      continue;
    }
    const prefix = token.slice(1, index);
    if (isShortClusterPrefixAllowed(clusterFlag, prefix)) {
      return clusterFlag.label;
    }
  }
  return null;
}

function isShortClusterPrefixAllowed(clusterFlag: ShortClusterFlagSpec, prefix: string): boolean {
  for (let index = 0; index < prefix.length; index += 1) {
    const char = prefix[index] ?? "";
    if (clusterFlag.prefixChars.has(char)) {
      if (clusterFlag.numericValuePrefixChars?.has(char) === true) {
        while (/^[0-9]$/.test(prefix[index + 1] ?? "")) {
          index += 1;
        }
      }
      continue;
    }
    if (clusterFlag.allowNumericRecordSeparator === true && char === "0") {
      while (/^[0-9]$/.test(prefix[index + 1] ?? "")) {
        index += 1;
      }
      continue;
    }
    return false;
  }
  return true;
}

export function detectInterpreterInlineEvalArgv(
  argv: string[] | undefined | null,
): InterpreterInlineEvalHit | null {
  if (!Array.isArray(argv) || argv.length === 0) {
    return null;
  }
  const executable = argv[0]?.trim();
  if (!executable) {
    return null;
  }
  const spec = findInterpreterSpec(executable);
  if (spec) {
    for (let idx = 1; idx < argv.length; idx += 1) {
      const token = argv[idx]?.trim();
      if (!token) {
        continue;
      }
      if (token === "--") {
        if (spec.scanPastDoubleDash) {
          continue;
        }
        break;
      }
      const rawExactFlag = spec.rawExactFlags?.get(token);
      if (rawExactFlag) {
        return createInlineEvalHit(executable, argv, rawExactFlag);
      }
      const joinedRawExactFlag = matchJoinedRawExactFlag(spec, token);
      if (joinedRawExactFlag) {
        return createInlineEvalHit(executable, argv, joinedRawExactFlag);
      }
      const rawPrefixFlag = spec.rawPrefixFlags?.find(
        ({ prefix }) => token.startsWith(prefix) && token.length > prefix.length,
      );
      if (rawPrefixFlag) {
        return createInlineEvalHit(executable, argv, rawPrefixFlag.label);
      }
      const lower = normalizeLowercaseStringOrEmpty(token);
      const abbreviatedFlag = matchAbbreviatedFlag(spec, lower);
      if (abbreviatedFlag) {
        return createInlineEvalHit(executable, argv, abbreviatedFlag);
      }
      if (spec.exactFlags.has(lower)) {
        return createInlineEvalHit(executable, argv, lower);
      }
      const joinedExactFlag = matchJoinedExactFlag(spec, token, lower);
      if (joinedExactFlag) {
        return createInlineEvalHit(executable, argv, joinedExactFlag);
      }
      const shortClusterFlag = matchShortClusterFlag(spec, token);
      if (shortClusterFlag) {
        return createInlineEvalHit(executable, argv, shortClusterFlag);
      }
      const prefixFlag = spec.prefixFlags?.find(
        ({ prefix }) => lower.startsWith(prefix) && lower.length > prefix.length,
      );
      if (prefixFlag) {
        return createInlineEvalHit(executable, argv, prefixFlag.label);
      }
    }
  }

  const positionalSpec = findPositionalInterpreterSpec(executable);
  if (!positionalSpec) {
    return null;
  }

  // These tools can execute user-provided programs once the first non-option token is reached.
  for (let idx = 1; idx < argv.length; idx += 1) {
    const token = argv[idx]?.trim();
    if (!token) {
      continue;
    }
    if (token === "--") {
      const nextToken = argv[idx + 1]?.trim();
      if (!nextToken) {
        return null;
      }
      return createInlineEvalHit(executable, argv, positionalSpec.flag);
    }
    if (positionalSpec.fileFlags?.has(token)) {
      return null;
    }
    if (
      positionalSpec.fileFlagPrefixes?.some(
        (prefix) => token.startsWith(prefix) && token.length > prefix.length,
      )
    ) {
      return null;
    }
    if (positionalSpec.exactValueFlags?.has(token)) {
      idx += 1;
      continue;
    }
    if (positionalSpec.exactOptionalValueFlags?.has(token)) {
      continue;
    }
    if (
      positionalSpec.prefixValueFlags?.some(
        (prefix) => token.startsWith(prefix) && token.length > prefix.length,
      )
    ) {
      continue;
    }
    if (token.startsWith("-")) {
      continue;
    }
    return createInlineEvalHit(executable, argv, positionalSpec.flag);
  }
  return null;
}

export function describeInterpreterInlineEval(hit: InterpreterInlineEvalHit): string {
  if (hit.flag === "<command>") {
    return `${hit.normalizedExecutable} inline command`;
  }
  if (hit.flag === "<program>") {
    return `${hit.normalizedExecutable} inline program`;
  }
  return `${hit.normalizedExecutable} ${hit.flag}`;
}

export function isInterpreterLikeAllowlistPattern(pattern: string | undefined | null): boolean {
  const trimmed = normalizeLowercaseStringOrEmpty(pattern);
  if (!trimmed) {
    return false;
  }
  const normalized = normalizeExecutableToken(trimmed);
  if (
    interpreterNameVariants(normalized).some((candidate) =>
      INTERPRETER_ALLOWLIST_NAMES.has(candidate),
    )
  ) {
    return true;
  }
  const basename = trimmed.replace(/\\/g, "/").split("/").pop() ?? trimmed;
  const withoutExe = basename.endsWith(".exe") ? basename.slice(0, -4) : basename;
  const strippedWildcards = withoutExe.replace(/[*?[\]{}()]/g, "").replace(/[.-]+$/, "");
  return interpreterNameVariants(strippedWildcards).some((candidate) =>
    INTERPRETER_ALLOWLIST_NAMES.has(candidate),
  );
}
