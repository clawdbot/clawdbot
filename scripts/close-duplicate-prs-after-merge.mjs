import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const DEFAULT_LABELS = ["duplicate", "close:duplicate", "dedupe:child"];

function usage() {
  return `Usage: node scripts/close-duplicate-prs-after-merge.mjs --landed-pr <number> --duplicates <numbers> [--repo owner/repo] [--apply]

Closes explicit duplicate PRs after a landed PR, after verifying the landed PR is merged and
each duplicate has either a shared referenced issue or overlapping changed hunks. Defaults to dry-run.`;
}

export function parsePrNumberList(value) {
  return [
    ...new Set(
      String(value ?? "")
        .split(/[\s,]+/u)
        .map((part) => part.trim().replace(/^#/u, ""))
        .filter(Boolean)
        .map((part) => {
          if (!/^\d+$/u.test(part)) {
            throw new Error(`Invalid PR number: ${part}`);
          }
          return Number(part);
        }),
    ),
  ];
}

export function parseArgs(argv, env = process.env) {
  const args = {
    apply: false,
    duplicates: [],
    labels: DEFAULT_LABELS,
    landedPr: undefined,
    repo: env.GITHUB_REPOSITORY || "openclaw/openclaw",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) {
        throw new Error(`Missing value for ${arg}`);
      }
      return argv[index];
    };

    if (arg === "--apply") {
      args.apply = true;
    } else if (arg === "--dry-run") {
      args.apply = false;
    } else if (arg === "--repo") {
      args.repo = next();
    } else if (arg === "--landed-pr") {
      args.landedPr = parsePrNumberList(next())[0];
    } else if (arg === "--duplicates") {
      args.duplicates = parsePrNumberList(next());
    } else if (arg === "--labels") {
      args.labels = next()
        .split(/[\s,]+/u)
        .map((label) => label.trim())
        .filter(Boolean);
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.help && !args.landedPr) {
    throw new Error("--landed-pr is required");
  }
  if (!args.help && args.duplicates.length === 0) {
    throw new Error("--duplicates is required");
  }

  return args;
}

function ghJson(args, runGh) {
  return JSON.parse(runGh(args));
}

function defaultRunGh(args, options = {}) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    stdio: options.input ? ["pipe", "pipe", "inherit"] : ["ignore", "pipe", "inherit"],
    ...(options.input ? { input: options.input } : {}),
  });
}

function issueRefsFromPr(pr) {
  const refs = new Set();
  for (const issue of pr.closingIssuesReferences ?? []) {
    if (typeof issue?.number === "number") {
      refs.add(issue.number);
    }
  }

  const text = `${pr.title ?? ""}\n${pr.body ?? ""}`;
  for (const match of text.matchAll(/(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/giu)) {
    refs.add(Number(match[1]));
  }
  return refs;
}

function intersectSets(left, right) {
  return [...left].filter((value) => right.has(value));
}

export function parseUnifiedDiffRanges(diffText) {
  const ranges = new Map();
  let currentPath = null;

  for (const line of String(diffText ?? "").split("\n")) {
    const pathMatch = /^diff --git a\/.+ b\/(.+)$/u.exec(line);
    if (pathMatch) {
      currentPath = pathMatch[1];
      if (!ranges.has(currentPath)) {
        ranges.set(currentPath, []);
      }
      continue;
    }

    const hunkMatch = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/u.exec(line);
    if (!hunkMatch || !currentPath) {
      continue;
    }
    const start = Number(hunkMatch[1]);
    const length = hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2]);
    const end = Math.max(start, start + Math.max(length, 1) - 1);
    ranges.get(currentPath).push({ start, end });
  }

  return ranges;
}

export function hasOverlappingHunks(leftRanges, rightRanges) {
  for (const [path, left] of leftRanges) {
    const right = rightRanges.get(path) ?? [];
    for (const leftRange of left) {
      for (const rightRange of right) {
        if (leftRange.start <= rightRange.end && rightRange.start <= leftRange.end) {
          return true;
        }
      }
    }
  }
  return false;
}

function filePaths(pr) {
  return new Set((pr.files ?? []).map((file) => file.path).filter(Boolean));
}

function formatEvidence(evidence) {
  const parts = [];
  if (evidence.sharedIssues.length > 0) {
    parts.push(`shared issue(s): ${evidence.sharedIssues.map((issue) => `#${issue}`).join(", ")}`);
  }
  if (evidence.overlappingHunks) {
    parts.push("overlapping changed hunks");
  }
  if (evidence.sharedFiles.length > 0) {
    parts.push(`shared file(s): ${evidence.sharedFiles.join(", ")}`);
  }
  return parts.join("; ");
}

function buildCloseComment({ candidate, evidence, landed, repo }) {
  const [owner, name] = repo.split("/");
  const commit = landed.mergeCommit?.oid;
  const commitRef =
    commit && owner && name
      ? `https://github.com/${owner}/${name}/commit/${commit}`
      : "the merge commit";
  return `Thanks for the fix. This is now covered by the landed #${landed.number} / commit ${commitRef}.

Evidence: ${formatEvidence(evidence)}.

Closing #${candidate.number} as a duplicate.`;
}

export function buildDuplicateClosePlan({ candidates, diffs, landed, repo }) {
  if (landed.state !== "MERGED" || !landed.mergedAt) {
    throw new Error(`#${landed.number} is not merged`);
  }

  const landedIssues = issueRefsFromPr(landed);
  const landedFiles = filePaths(landed);
  const landedRanges = parseUnifiedDiffRanges(diffs.get(landed.number) ?? "");

  return candidates.map((candidate) => {
    if (candidate.state !== "OPEN") {
      return {
        action: "skip",
        candidate,
        reason: `#${candidate.number} is ${candidate.state}`,
      };
    }

    const sharedFiles = intersectSets(landedFiles, filePaths(candidate)).toSorted((left, right) =>
      left.localeCompare(right),
    );
    const sharedIssues = intersectSets(landedIssues, issueRefsFromPr(candidate)).toSorted(
      (left, right) => left - right,
    );
    const overlappingHunks = hasOverlappingHunks(
      landedRanges,
      parseUnifiedDiffRanges(diffs.get(candidate.number) ?? ""),
    );
    const evidence = { overlappingHunks, sharedFiles, sharedIssues };

    if (sharedIssues.length === 0 && !overlappingHunks) {
      throw new Error(
        `Refusing to close #${candidate.number}: no shared issue and no overlapping changed hunks with #${landed.number}`,
      );
    }

    return {
      action: "close",
      candidate,
      comment: buildCloseComment({ candidate, evidence, landed, repo }),
      evidence,
    };
  });
}

function loadPr(repo, number, runGh) {
  return ghJson(
    [
      "pr",
      "view",
      String(number),
      "--repo",
      repo,
      "--json",
      "number,title,body,state,mergedAt,mergeCommit,closingIssuesReferences,files,url",
    ],
    runGh,
  );
}

function loadDiff(repo, number, runGh) {
  return runGh(["pr", "diff", String(number), "--repo", repo, "--color=never"]);
}

export function applyClosePlan({ labels = DEFAULT_LABELS, plan, repo, runGh }) {
  for (const item of plan) {
    if (item.action !== "close") {
      continue;
    }
    const number = String(item.candidate.number);
    const labelArgs = labels.flatMap((label) => ["--add-label", label]);
    if (labelArgs.length > 0) {
      runGh(["pr", "edit", number, "--repo", repo, ...labelArgs]);
    }
    runGh(["pr", "comment", number, "--repo", repo, "--body", item.comment]);
    runGh(["pr", "close", number, "--repo", repo]);
  }
}

export function runDuplicateCloseWorkflow(args, runGh = defaultRunGh) {
  const landed = loadPr(args.repo, args.landedPr, runGh);
  const candidates = args.duplicates.map((number) => loadPr(args.repo, number, runGh));
  const diffs = new Map([[landed.number, loadDiff(args.repo, landed.number, runGh)]]);
  for (const candidate of candidates) {
    diffs.set(candidate.number, loadDiff(args.repo, candidate.number, runGh));
  }

  const plan = buildDuplicateClosePlan({ candidates, diffs, landed, repo: args.repo });
  for (const item of plan) {
    if (item.action === "skip") {
      console.log(`skip #${item.candidate.number}: ${item.reason}`);
    } else {
      console.log(`close #${item.candidate.number}: ${formatEvidence(item.evidence)}`);
    }
  }

  if (!args.apply) {
    console.log("dry-run only; pass --apply to label/comment/close duplicate PRs");
    return plan;
  }

  applyClosePlan({ labels: args.labels, plan, repo: args.repo, runGh });
  return plan;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log(usage());
      process.exit(0);
    }
    runDuplicateCloseWorkflow(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage());
    process.exit(1);
  }
}
