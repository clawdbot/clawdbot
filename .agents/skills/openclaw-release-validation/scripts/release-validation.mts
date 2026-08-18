#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type GithubRelease = {
  tagName: string;
  isDraft: boolean;
  isPrerelease: boolean;
  publishedAt: string;
};

export type CampaignIssue = {
  number: number;
  url: string;
  body: string;
};

export type FixtureKind = "clean" | "copied";
export type SubsystemStatus =
  | "needs coverage"
  | "in progress"
  | "pass"
  | "fail"
  | "blocked"
  | "skipped"
  | "n/a";

export type ScenarioSummary = {
  id: string;
  title: string;
};

export type Scenario = ScenarioSummary & {
  taxonomyIds: string[];
  docs: string[];
  instructions: Record<FixtureKind, string[]>;
  passEvidence: string[];
  safety: string[];
};

export type ScenarioManifest = {
  schemaVersion: 1;
  title: string;
  subsystems: Scenario[];
};

export type SourceGateway = {
  kind: "ocm" | "plain";
  name: string;
  version: string;
  commit: string;
  wasRunning: boolean;
  stateDir?: string;
};

export type CandidateTarget =
  | { kind: "published"; version: string }
  | {
      kind: "source";
      ref: string;
      repoRoot: string;
      originUrl: string;
      checkout: string;
      runtimeName: string;
    };

export type FixturePlanStep = {
  operation: string;
  command?: string;
  args?: string[];
  cwd?: string;
  source?: string;
  destination?: string;
  checks?: Array<{ command: string; args: string[] }>;
};

const OPENCLAW_BETA_TAG = /^v(\d{4})\.(\d+)\.(\d+)-beta\.(\d+)$/u;

function betaVersionParts(tag: string): number[] | undefined {
  const match = OPENCLAW_BETA_TAG.exec(tag);
  if (!match) {
    return undefined;
  }
  return match.slice(1).map(Number);
}

export function selectLatestBetaRelease(releases: GithubRelease[]): string {
  const candidates = releases
    .filter((release) => release.isPrerelease && !release.isDraft)
    .flatMap((release) => {
      const parts = betaVersionParts(release.tagName);
      return parts ? [{ tag: release.tagName, parts }] : [];
    })
    .toSorted((left, right) => {
      for (let index = 0; index < left.parts.length; index += 1) {
        const difference = (right.parts[index] ?? 0) - (left.parts[index] ?? 0);
        if (difference !== 0) {
          return difference;
        }
      }
      return 0;
    });

  const latest = candidates[0];
  if (!latest) {
    throw new Error("no published OpenClaw beta release was found");
  }
  return latest.tag;
}

export function campaignMarker(releaseTag: string): string {
  return `<!-- openclaw-release-validation:${releaseTag} -->`;
}

export async function getOrCreateCampaignIssue({
  releaseTag,
  listIssues,
  createIssue,
}: {
  releaseTag: string;
  listIssues: () => Promise<CampaignIssue[]>;
  createIssue: (input: { title: string; body: string }) => Promise<CampaignIssue>;
}): Promise<{ number: number; url: string; created: boolean }> {
  const marker = campaignMarker(releaseTag);
  const matches = (await listIssues()).filter((issue) => issue.body.includes(marker));
  if (matches.length > 1) {
    throw new Error(`multiple release-validation issues contain ${marker}`);
  }
  const existing = matches[0];
  if (existing) {
    return { number: existing.number, url: existing.url, created: false };
  }

  const created = await createIssue({
    title: `Release validation: ${releaseTag}`,
    body: `${marker}\n\nShared human validation ledger for ${releaseTag}.\n`,
  });
  return { number: created.number, url: created.url, created: true };
}

export function createRunState({
  runId,
  candidateTag,
  candidateSha,
  fixture,
  issueNumber,
  envName,
  sourceGateway,
  scenarios,
}: {
  runId: string;
  candidateTag: string;
  candidateSha: string;
  fixture: FixtureKind;
  issueNumber: number;
  envName: string;
  sourceGateway?: SourceGateway;
  scenarios: ScenarioSummary[];
}) {
  return {
    schemaVersion: 1 as const,
    run: {
      id: runId,
      candidateTag,
      candidateSha,
      fixture,
      issueNumber,
      envName,
      sourceGateway,
      createdAt: new Date().toISOString(),
    },
    subsystems: Object.fromEntries(
      scenarios.map((scenario) => [
        scenario.id,
        {
          title: scenario.title,
          status: "needs coverage" as SubsystemStatus,
          notes: "",
          testedAt: null as string | null,
        },
      ]),
    ),
    promotionVote: null as "yes" | "no" | null,
    github: {
      commentId: null as number | null,
      lastSyncedHash: null as string | null,
    },
  };
}

export type RunState = ReturnType<typeof createRunState>;

export function recordSubsystemResult(
  state: RunState,
  subsystemId: string,
  result: { status: SubsystemStatus; notes: string },
): RunState {
  const current = state.subsystems[subsystemId];
  if (!current) {
    throw new Error(`unknown subsystem: ${subsystemId}`);
  }
  const notes = result.notes.trim();
  if ((result.status === "fail" || result.status === "blocked") && notes.length === 0) {
    throw new Error(`notes are required when ${subsystemId} is ${result.status}`);
  }
  const next = structuredClone(state);
  next.subsystems[subsystemId] = {
    ...current,
    status: result.status,
    notes,
    testedAt:
      result.status === "needs coverage" || result.status === "in progress"
        ? null
        : new Date().toISOString(),
  };
  return next;
}

export function redactPublicText(value: string): string {
  let redacted = value;
  const home = process.env.HOME;
  if (home) {
    redacted = redacted.replaceAll(home, "~");
  }
  return redacted
    .replace(/\b(gh[pousr]_[A-Za-z0-9_]{20,})\b/gu, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\b(sk-[A-Za-z0-9_-]{16,})\b/gu, "[REDACTED_API_KEY]")
    .replace(/(authorization\s*:\s*bearer\s+)[^\s]+/giu, "$1[REDACTED]")
    .replace(/([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)\s*=\s*)[^\s]+/gu, "$1[REDACTED]");
}

function tableCell(value: string): string {
  return redactPublicText(value)
    .replaceAll("|", "\\|")
    .replace(/\s*\n\s*/gu, " ")
    .trim();
}

export function renderRunComment(state: RunState): string {
  const subsystemRows = Object.values(state.subsystems);
  const completed = subsystemRows.filter(
    (entry) => entry.status !== "needs coverage" && entry.status !== "in progress",
  ).length;
  const source = state.run.sourceGateway;
  const vote =
    state.promotionVote === "yes" ? "Yes" : state.promotionVote === "no" ? "No" : "No verdict";
  const lines = [
    `<!-- openclaw-release-validation-run:${state.run.id} -->`,
    `## Release validation run \`${state.run.id}\``,
    "",
    `**Candidate:** \`${state.run.candidateTag}\` · \`${state.run.candidateSha || "unknown"}\``,
    `**Fixture:** \`${state.run.fixture}\``,
    source
      ? `**Source:** \`${tableCell(source.name)}\` · \`${tableCell(source.version || "unknown")}\` · \`${source.commit || "commit unknown"}\``
      : "**Source:** clean state",
    `**Coverage:** ${completed}/${subsystemRows.length}`,
    "",
    "| Subsystem | Result | Notes |",
    "| --- | --- | --- |",
    ...subsystemRows.map(
      (entry) =>
        `| ${tableCell(entry.title)} | ${entry.status} | ${tableCell(entry.notes) || "—"} |`,
    ),
    "",
    `**Polished enough to promote?** ${vote}`,
    "",
    "_Generated by the OpenClaw release-validation maintainer skill. Successful rows omit raw logs; failures and blockers should contain only bounded, redacted evidence._",
  ];
  return `${lines.join("\n")}\n`;
}

export function buildFixturePlan({
  fixture,
  candidate,
  envName,
  runRoot,
  sourceGateway,
}: {
  fixture: FixtureKind;
  candidate: CandidateTarget;
  envName: string;
  runRoot: string;
  sourceGateway?: SourceGateway;
}): FixturePlanStep[] {
  if (candidate.kind !== "published") {
    throw new Error("source candidate preparation requires an isolated runtime plan");
  }
  if (fixture === "clean") {
    return [
      {
        operation: "onboard-clean",
        command: "ocm",
        args: ["start", envName, "--version", candidate.version, "--onboard"],
      },
      {
        operation: "verify-clean",
        checks: [
          { command: "ocm", args: ["service", "status", envName, "--json"] },
          { command: "ocm", args: [`@${envName}`, "--", "--version"] },
          { command: "ocm", args: ["logs", envName, "--tail", "100", "--json"] },
        ],
      },
    ];
  }
  if (!sourceGateway?.stateDir) {
    throw new Error("copied fixture requires a source gateway state directory");
  }

  const copiedState = `${runRoot}/source-state`;
  const importedRoot = `${runRoot}/env`;
  const steps: FixturePlanStep[] = [];
  if (sourceGateway.wasRunning) {
    if (sourceGateway.kind !== "ocm") {
      throw new Error("a running plain source gateway must be stopped before copying");
    }
    steps.push({
      operation: "stop-source",
      command: "ocm",
      args: ["service", "stop", sourceGateway.name],
    });
  }
  steps.push(
    {
      operation: "copy-state",
      source: sourceGateway.stateDir,
      destination: copiedState,
    },
    {
      operation: "adopt-copy",
      command: "ocm",
      args: ["adopt", "import", "--name", envName, "--root", importedRoot, copiedState, "--json"],
    },
    {
      operation: "upgrade-copy",
      command: "ocm",
      args: ["upgrade", envName, "--version", candidate.version, "--json"],
    },
    {
      operation: "start-copy",
      command: "ocm",
      args: ["service", "start", envName],
    },
    {
      operation: "verify-copy",
      checks: [
        { command: "ocm", args: ["service", "status", envName, "--json"] },
        { command: "ocm", args: [`@${envName}`, "--", "--version"] },
        { command: "ocm", args: ["logs", envName, "--tail", "100", "--json"] },
      ],
    },
  );
  return steps;
}

export function buildIsolatedRuntimePlan({
  ref,
  repoRoot,
  originUrl,
  checkout,
  runtimeName,
}: {
  ref: string;
  repoRoot: string;
  originUrl: string;
  checkout: string;
  runtimeName: string;
}): FixturePlanStep[] {
  return [
    {
      operation: "clone-isolated",
      command: "git",
      args: [
        "clone",
        "--no-checkout",
        "--dissociate",
        "--reference-if-able",
        repoRoot,
        originUrl,
        checkout,
      ],
    },
    {
      operation: "fetch-candidate",
      command: "git",
      args: ["-C", checkout, "fetch", "--no-tags", "origin", ref],
    },
    {
      operation: "checkout-detached",
      command: "git",
      args: ["-C", checkout, "checkout", "--detach", ref],
    },
    {
      operation: "install-dependencies",
      command: "pnpm",
      args: ["install", "--frozen-lockfile"],
      cwd: checkout,
    },
    { operation: "check-source", command: "pnpm", args: ["check"], cwd: checkout },
    { operation: "build-source", command: "pnpm", args: ["build"], cwd: checkout },
    {
      operation: "build-runtime",
      command: "ocm",
      args: ["runtime", "build-local", runtimeName, "--repo", checkout, "--force"],
    },
    {
      operation: "verify-runtime",
      command: "ocm",
      args: ["runtime", "verify", runtimeName],
    },
  ];
}

const DEFAULT_SCENARIO_MANIFEST = fileURLToPath(
  new URL("../references/subsystem-checklist.json", import.meta.url),
);

export function loadScenarioManifest(path = DEFAULT_SCENARIO_MANIFEST): ScenarioManifest {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("scenario manifest must be an object");
  }
  const candidate = parsed as Partial<ScenarioManifest>;
  if (candidate.schemaVersion !== 1 || !Array.isArray(candidate.subsystems)) {
    throw new Error("scenario manifest has an unsupported schema");
  }
  const seen = new Set<string>();
  for (const subsystem of candidate.subsystems) {
    if (
      !subsystem ||
      typeof subsystem.id !== "string" ||
      typeof subsystem.title !== "string" ||
      !Array.isArray(subsystem.taxonomyIds) ||
      subsystem.taxonomyIds.length === 0 ||
      !Array.isArray(subsystem.instructions?.clean) ||
      subsystem.instructions.clean.length === 0 ||
      !Array.isArray(subsystem.instructions?.copied) ||
      subsystem.instructions.copied.length === 0 ||
      !Array.isArray(subsystem.passEvidence) ||
      subsystem.passEvidence.length === 0
    ) {
      throw new Error(`scenario manifest entry is incomplete: ${subsystem?.id ?? "unknown"}`);
    }
    if (seen.has(subsystem.id)) {
      throw new Error(`scenario manifest contains duplicate id: ${subsystem.id}`);
    }
    seen.add(subsystem.id);
  }
  return candidate as ScenarioManifest;
}
