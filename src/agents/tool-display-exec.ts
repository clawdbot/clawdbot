import {
  binaryName,
  firstPositional,
  optionValue,
  positionalArgs,
  splitShellWords,
  splitTopLevelPipes,
  splitTopLevelStages,
  stripOuterQuotes,
  stripShellPreamble,
  trimLeadingEnv,
  unwrapShellWrapper,
} from "./tool-display-exec-shell.js";
import { asRecord } from "./tool-display-record.js";

function summarizeKnownExec(words: string[]): string {
  if (words.length === 0) {
    return "run command";
  }

  const bin = binaryName(words[0]) ?? "command";

  if (bin === "git") {
    const globalWithValue = new Set([
      "-C",
      "-c",
      "--git-dir",
      "--work-tree",
      "--namespace",
      "--config-env",
    ]);

    const gitCwd = optionValue(words, ["-C"]);

    let sub: string | undefined;
    for (let i = 1; i < words.length; i += 1) {
      const token = words[i];
      if (!token) {
        continue;
      }
      if (token === "--") {
        sub = firstPositional(words, i + 1);
        break;
      }
      if (token.startsWith("--")) {
        if (token.includes("=")) {
          continue;
        }
        if (globalWithValue.has(token)) {
          i += 1;
        }
        continue;
      }
      if (token.startsWith("-")) {
        if (globalWithValue.has(token)) {
          i += 1;
        }
        continue;
      }
      sub = token;
      break;
    }

    const map: Record<string, string> = {
      status: "check git status",
      diff: "check git diff",
      log: "view git history",
      show: "show git object",
      branch: "list git branches",
      checkout: "switch git branch",
      switch: "switch git branch",
      commit: "create git commit",
      pull: "pull git changes",
      push: "push git changes",
      fetch: "fetch git changes",
      merge: "merge git changes",
      rebase: "rebase git branch",
      add: "stage git changes",
      restore: "restore git files",
      reset: "reset git state",
      stash: "stash git changes",
    };

    if (sub && map[sub]) {
      return map[sub];
    }
    if (!sub || sub.startsWith("/") || sub.startsWith("~") || sub.includes("/")) {
      return gitCwd ? `run git command in ${gitCwd}` : "run git command";
    }
    return `run git ${sub}`;
  }

  if (bin === "grep" || bin === "rg" || bin === "ripgrep") {
    const positional = positionalArgs(words, 1, [
      "-e",
      "--regexp",
      "-f",
      "--file",
      "-m",
      "--max-count",
      "-A",
      "--after-context",
      "-B",
      "--before-context",
      "-C",
      "--context",
    ]);
    const pattern = optionValue(words, ["-e", "--regexp"]) ?? positional[0];
    const target = positional.length > 1 ? positional.at(-1) : undefined;
    if (pattern) {
      return target ? `search "${pattern}" in ${target}` : `search "${pattern}"`;
    }
    return "search text";
  }

  if (bin === "find") {
    const path = words[1] && !words[1].startsWith("-") ? words[1] : ".";
    const name = optionValue(words, ["-name", "-iname"]);
    return name ? `find files named "${name}" in ${path}` : `find files in ${path}`;
  }

  if (bin === "ls") {
    const target = firstPositional(words, 1);
    return target ? `list files in ${target}` : "list files";
  }

  if (bin === "head" || bin === "tail") {
    const lines =
      optionValue(words, ["-n", "--lines"]) ??
      words
        .slice(1)
        .find((token) => /^-\d+$/.test(token))
        ?.slice(1);
    const positional = positionalArgs(words, 1, ["-n", "--lines"]);
    let target = positional.at(-1);
    if (target && /^\d+$/.test(target) && positional.length === 1) {
      target = undefined;
    }
    const side = bin === "head" ? "first" : "last";
    const unit = lines === "1" ? "line" : "lines";
    if (lines && target) {
      return `show ${side} ${lines} ${unit} of ${target}`;
    }
    if (lines) {
      return `show ${side} ${lines} ${unit}`;
    }
    if (target) {
      return `show ${target}`;
    }
    return `show ${bin} output`;
  }

  if (bin === "cat") {
    const target = firstPositional(words, 1);
    return target ? `show ${target}` : "show output";
  }

  if (bin === "sed") {
    const expression = optionValue(words, ["-e", "--expression"]);
    const positional = positionalArgs(words, 1, ["-e", "--expression", "-f", "--file"]);
    const script = expression ?? positional[0];
    const target = expression ? positional[0] : positional[1];

    if (script) {
      const compact = (stripOuterQuotes(script) ?? script).replace(/\s+/g, "");
      const range = compact.match(/^([0-9]+),([0-9]+)p$/);
      if (range) {
        return target
          ? `print lines ${range[1]}-${range[2]} from ${target}`
          : `print lines ${range[1]}-${range[2]}`;
      }
      const single = compact.match(/^([0-9]+)p$/);
      if (single) {
        return target ? `print line ${single[1]} from ${target}` : `print line ${single[1]}`;
      }
    }

    return target ? `run sed on ${target}` : "run sed transform";
  }

  if (bin === "printf" || bin === "echo") {
    return "print text";
  }

  if (bin === "cp" || bin === "mv") {
    const positional = positionalArgs(words, 1, ["-t", "--target-directory", "-S", "--suffix"]);
    const src = positional[0];
    const dst = positional[1];
    const action = bin === "cp" ? "copy" : "move";
    if (src && dst) {
      return `${action} ${src} to ${dst}`;
    }
    if (src) {
      return `${action} ${src}`;
    }
    return `${action} files`;
  }

  if (bin === "rm") {
    const target = firstPositional(words, 1);
    return target ? `remove ${target}` : "remove files";
  }

  if (bin === "mkdir") {
    const target = firstPositional(words, 1);
    return target ? `create folder ${target}` : "create folder";
  }

  if (bin === "touch") {
    const target = firstPositional(words, 1);
    return target ? `create file ${target}` : "create file";
  }

  if (bin === "curl" || bin === "wget") {
    const url = words.find((token) => /^https?:\/\//i.test(token));
    return url ? `fetch ${url}` : "fetch url";
  }

  if (bin === "npm" || bin === "pnpm" || bin === "yarn" || bin === "bun") {
    const positional = positionalArgs(words, 1, ["--prefix", "-C", "--cwd", "--config"]);
    const sub = positional[0] ?? "command";
    const map: Record<string, string> = {
      install: "install dependencies",
      test: "run tests",
      build: "run build",
      start: "start app",
      lint: "run lint",
      run: positional[1] ? `run ${positional[1]}` : "run script",
    };
    return map[sub] ?? `run ${bin} ${sub}`;
  }

  if (bin === "node" || bin === "python" || bin === "python3" || bin === "ruby" || bin === "php") {
    const heredoc = words.slice(1).find((token) => token.startsWith("<<"));
    if (heredoc) {
      return `run ${bin} inline script (heredoc)`;
    }

    const inline =
      bin === "node"
        ? optionValue(words, ["-e", "--eval"])
        : bin === "python" || bin === "python3"
          ? optionValue(words, ["-c"])
          : undefined;
    if (inline !== undefined) {
      return `run ${bin} inline script`;
    }

    const nodeOptsWithValue = ["-e", "--eval", "-m"];
    const otherOptsWithValue = ["-c", "-e", "--eval", "-m"];
    const script = firstPositional(
      words,
      1,
      bin === "node" ? nodeOptsWithValue : otherOptsWithValue,
    );
    if (!script) {
      return `run ${bin}`;
    }

    if (bin === "node") {
      const mode =
        words.includes("--check") || words.includes("-c")
          ? "check js syntax for"
          : "run node script";
      return `${mode} ${script}`;
    }

    return `run ${bin} ${script}`;
  }

  if (bin === "openclaw") {
    const sub = firstPositional(words, 1);
    return sub ? `run openclaw ${sub}` : "run openclaw";
  }

  const arg = firstPositional(words, 1);
  if (!arg || arg.length > 48) {
    return `run ${bin}`;
  }
  return /^[A-Za-z0-9._/-]+$/.test(arg) ? `run ${bin} ${arg}` : `run ${bin}`;
}

function summarizePipeline(stage: string): string {
  const pipeline = splitTopLevelPipes(stage);
  if (pipeline.length > 1) {
    const first = summarizeKnownExec(trimLeadingEnv(splitShellWords(pipeline[0])));
    const last = summarizeKnownExec(trimLeadingEnv(splitShellWords(pipeline[pipeline.length - 1])));
    const extra = pipeline.length > 2 ? ` (+${pipeline.length - 2} steps)` : "";
    return `${first} -> ${last}${extra}`;
  }
  return summarizeKnownExec(trimLeadingEnv(splitShellWords(stage)));
}

type ExecSummary = {
  text: string;
  chdirPath?: string;
  allGeneric?: boolean;
};

function normalizePathForDisplay(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/g, "");
}

function classifyWorkspacePath(
  path: string,
): "agent" | "repo" | "sandbox" | "workspace" | undefined {
  const normalized = normalizePathForDisplay(path);
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0) {
    return undefined;
  }

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!segment) {
      continue;
    }
    if (segment === ".openclaw" && segments[index + 1] === "workspace") {
      return "agent";
    }
    if (segment === ".openclaw" && segments[index + 1] === "sandboxes") {
      return "sandbox";
    }
    if (/[-_]workspace$/i.test(segment) && segment.toLowerCase() !== "workspace") {
      return "agent";
    }
    if (/^workspace[-_]/i.test(segment)) {
      return "agent";
    }
  }

  if (segments.includes("Projects") || segments.includes("projects")) {
    return "repo";
  }

  if (segments.at(-1)?.toLowerCase() === "workspace") {
    return "workspace";
  }

  return undefined;
}

function formatCwdSuffix(cwd: string): string {
  const workspace = classifyWorkspacePath(cwd);
  return workspace ? `(${workspace})` : `(in ${cwd})`;
}

function summarizeExecCommand(command: string): ExecSummary | undefined {
  const { command: cleaned, chdirPath } = stripShellPreamble(command);
  if (!cleaned) {
    return chdirPath ? { text: "", chdirPath } : undefined;
  }

  const stages = splitTopLevelStages(cleaned);
  if (stages.length === 0) {
    return undefined;
  }

  const summaries = stages.map((stage) => summarizePipeline(stage));
  const text = summaries.length === 1 ? summaries[0] : summaries.join(" → ");
  const allGeneric = summaries.every((summary) => isGenericSummary(summary));

  return { text, chdirPath, allGeneric };
}

const KNOWN_SUMMARY_PREFIXES = [
  "check git",
  "view git",
  "show git",
  "list git",
  "switch git",
  "create git",
  "pull git",
  "push git",
  "fetch git",
  "merge git",
  "rebase git",
  "stage git",
  "restore git",
  "reset git",
  "stash git",
  "search ",
  "find files",
  "list files",
  "show first",
  "show last",
  "print line",
  "print text",
  "copy ",
  "move ",
  "remove ",
  "create folder",
  "create file",
  "fetch http",
  "install dependencies",
  "run tests",
  "run build",
  "start app",
  "run lint",
  "run openclaw",
  "run node script",
  "run node ",
  "run python",
  "run ruby",
  "run php",
  "run sed",
  "run git ",
  "run npm ",
  "run pnpm ",
  "run yarn ",
  "run bun ",
  "check js syntax",
];

function isGenericSummary(summary: string): boolean {
  if (summary === "run command") {
    return true;
  }
  if (summary.startsWith("run ")) {
    return !KNOWN_SUMMARY_PREFIXES.some((prefix) => summary.startsWith(prefix));
  }
  return false;
}

function compactRawCommand(raw: string, maxLength = 120): string {
  const oneLine = raw
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (oneLine.length <= maxLength) {
    return oneLine;
  }
  return `${oneLine.slice(0, Math.max(0, maxLength - 1))}…`;
}

export type ToolDetailMode = "explain" | "raw";

export function resolveExecDetail(
  args: unknown,
  options?: { detailMode?: ToolDetailMode },
): string | undefined {
  const record = asRecord(args);
  if (!record) {
    return undefined;
  }

  const raw = typeof record.command === "string" ? record.command.trim() : undefined;
  if (!raw) {
    return undefined;
  }

  const unwrapped = unwrapShellWrapper(raw);
  const result = summarizeExecCommand(unwrapped) ?? summarizeExecCommand(raw);
  const summary = result?.text || "run command";

  const cwdRaw =
    typeof record.workdir === "string"
      ? record.workdir
      : typeof record.cwd === "string"
        ? record.cwd
        : undefined;
  const cwd = cwdRaw?.trim() || result?.chdirPath || undefined;

  const compact = compactRawCommand(unwrapped);
  if (result?.allGeneric !== false && isGenericSummary(summary)) {
    return cwd ? `${compact} ${formatCwdSuffix(cwd)}` : compact;
  }

  const displaySummary = cwd ? `${summary} ${formatCwdSuffix(cwd)}` : summary;
  if (
    options?.detailMode !== "explain" &&
    compact &&
    compact !== displaySummary &&
    compact !== summary
  ) {
    return `${displaySummary} · \`${compact}\``;
  }

  return displaySummary;
}
