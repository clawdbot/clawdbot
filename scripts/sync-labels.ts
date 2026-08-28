// Sync Labels script supports OpenClaw repository automation.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { resolveGitHubRepoFromOrigin } from "./lib/github-repo.ts";

const SYNC_LABELS_TIMEOUT_MS = 120_000;

type RepoLabel = {
  name: string;
  color?: string;
  description?: string;
};

const COLOR_BY_PREFIX = new Map<string, string>([
  ["channel", "0969DA"],
  ["app", "6E7781"],
  ["extensions", "6E7781"],
  ["plugin", "6E7781"],
  ["docs", "0A3069"],
  ["cli", "0A3069"],
  ["gateway", "57606A"],
  ["commands", "0A3069"],
  ["scripts", "57606A"],
  ["docker", "D6E3DA"],
  ["size", "8C959F"],
]);

const EXTRA_LABEL_METADATA = new Map<
  string,
  {
    color: string;
    description?: string;
  }
>([
  [
    "beta-blocker",
    {
      color: "D93F0B",
      description: "Plugin beta-release blocker pending stable cutoff triage",
    },
  ],
]);

const configPath = resolve(".github/labeler.yml");
const EXTRA_LABELS = [
  "size: XS",
  "size: S",
  "size: M",
  "size: L",
  "size: XL",
  "beta-blocker",
] as const;
const labelerConfig = parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
const labelNames = [...new Set([...Object.keys(labelerConfig), ...EXTRA_LABELS])];

const repo = resolveGitHubRepoFromOrigin();
const existing = fetchExistingLabels(repo);

const missing = labelNames.filter((label) => !existing.has(label));
if (!missing.length) {
  console.log("All labeler labels already exist.");
  process.exit(0);
}

for (const label of missing) {
  const metadata = resolveLabelMetadata(label);
  const args = [
    "api",
    "-X",
    "POST",
    `repos/${repo}/labels`,
    "-f",
    `name=${label}`,
    "-f",
    `color=${metadata.color}`,
  ];
  if (metadata.description) {
    args.push("-f", `description=${metadata.description}`);
  }
  execFileSync("gh", args, {
    stdio: "inherit",
    timeout: SYNC_LABELS_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  console.log(`Created label: ${label}`);
}

function resolveLabelMetadata(label: string): { color: string; description?: string } {
  const extraMetadata = EXTRA_LABEL_METADATA.get(label);
  if (extraMetadata) {
    return extraMetadata;
  }
  const prefix = label.includes(":") ? label.slice(0, label.indexOf(":")).trim() : label.trim();
  return { color: COLOR_BY_PREFIX.get(prefix) ?? "ededed" };
}

function fetchExistingLabels(repoLocal: string): Map<string, RepoLabel> {
  const raw = execFileSync("gh", ["api", `repos/${repoLocal}/labels?per_page=100`, "--paginate"], {
    encoding: "utf8",
    timeout: SYNC_LABELS_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  const labels = JSON.parse(raw) as RepoLabel[];
  return new Map(labels.map((label) => [label.name, label]));
}
