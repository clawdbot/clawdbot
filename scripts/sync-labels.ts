import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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
const labelNames = [
  ...new Set([...extractLabelNames(readFileSync(configPath, "utf8")), ...EXTRA_LABELS]),
];

if (!labelNames.length) {
  throw new Error("labeler.yml must declare at least one label.");
}

const repo = resolveRepo();
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
  execFileSync("gh", args, { stdio: "inherit" });
  console.log(`Created label: ${label}`);
}

function extractLabelNames(contents: string): string[] {
  const labels: string[] = [];
  for (const line of contents.split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) {
      continue;
    }
    if (/^\s/.test(line)) {
      continue;
    }
    const match = line.match(/^(["'])(.+)\1\s*:/) ?? line.match(/^([^:]+):/);
    if (match) {
      const name = (match[2] ?? match[1] ?? "").trim();
      if (name) {
        labels.push(name);
      }
    }
  }
  return labels;
}

function resolveLabelMetadata(label: string): { color: string; description?: string } {
  const extraMetadata = EXTRA_LABEL_METADATA.get(label);
  if (extraMetadata) {
    return extraMetadata;
  }
  const prefix = label.includes(":") ? label.split(":", 1)[0].trim() : label.trim();
  return { color: COLOR_BY_PREFIX.get(prefix) ?? "ededed" };
}

function resolveRepo(): string {
  const remote = execFileSync("git", ["config", "--get", "remote.origin.url"], {
    encoding: "utf8",
  }).trim();

  if (!remote) {
    throw new Error("Unable to determine repository from git remote.");
  }

  if (remote.startsWith("git@github.com:")) {
    return remote.replace("git@github.com:", "").replace(/\.git$/, "");
  }

  if (remote.startsWith("https://github.com/")) {
    return remote.replace("https://github.com/", "").replace(/\.git$/, "");
  }

  throw new Error(`Unsupported GitHub remote: ${remote}`);
}

function fetchExistingLabels(repoLocal: string): Map<string, RepoLabel> {
  const raw = execFileSync("gh", ["api", `repos/${repoLocal}/labels?per_page=100`, "--paginate"], {
    encoding: "utf8",
  });
  const labels = JSON.parse(raw) as RepoLabel[];
  return new Map(labels.map((label) => [label.name, label]));
}
