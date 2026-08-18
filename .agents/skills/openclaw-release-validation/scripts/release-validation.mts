#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);

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
  desiredRunning: boolean;
  wasListening: boolean;
  health: "healthy" | "unhealthy" | "unknown";
  observedAt: string;
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

export type StagedStateReceipt = {
  source: string;
  destination: string;
  configPathReplacements: number;
  copiedSockets: 0;
};

export type PluginPathViolation = {
  pluginId: string;
  field: "installPath" | "sourcePath" | "rootDir" | "source" | "manifestPath";
  path: string;
};

export type PluginIsolationReceipt = {
  ok: boolean;
  allowedRoots: string[];
  checkedPathCount: number;
  violations: PluginPathViolation[];
};

export type RunIssueComment = {
  id: number;
  body: string | null;
};

export const EXIT_PHRASE = "finish validation";

export function renderExitInstruction(): string {
  return `Reply exactly \`${EXIT_PHRASE}\` to end the run.`;
}

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
  let matches = (await listIssues()).filter((issue) => issue.body.includes(marker));
  if (matches.length === 0) {
    // Newly created issues can take a moment to appear in GitHub's list API.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    matches = (await listIssues()).filter((issue) => issue.body.includes(marker));
  }
  if (matches.length > 1) {
    throw new Error(`multiple release-validation issues contain ${marker}`);
  }
  const existing = matches[0];
  if (existing) {
    return { number: existing.number, url: existing.url, created: false };
  }

  const created = await createIssue({
    title: `Release validation: ${releaseTag}`,
    body: [
      marker,
      "",
      `# OpenClaw ${releaseTag} validation`,
      "",
      "Shared ledger for clean-state and copied-state upgrade journeys.",
      "",
      "Each tester should add one comment containing the exact candidate commit, fixture type, source gateway version/commit when applicable, subsystem results and notes, and a yes/no promotion vote.",
      "",
      "Failures and blockers count as useful completed coverage. Redact credentials, pairing codes, private endpoints, and secret-bearing logs.",
      "",
    ].join("\n"),
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
    finalFeedback: "",
    releaseIssues: [] as string[],
    operationalFindings: [] as string[],
    cleanup: {
      fixtureStopped: false,
      sourceRestoration: (sourceGateway ? "pending" : "not required") as
        | "pending"
        | "restored"
        | "blocked"
        | "not required",
      sourceRestorationNote: "",
      retainedArtifacts: [] as string[],
    },
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
    .replace(
      /((?:[A-Z][A-Z0-9_]*_)?(?:TOKEN|SECRET|PASSWORD|API_KEY)\s*=\s*)[^\s]+/gu,
      "$1[REDACTED]",
    );
}

export function redactLocalPaths(value: string): string {
  return value
    .replace(
      /(["'`])(?:~\/|\/(?:Users|home|tmp|private|var|Volumes)\/|[A-Za-z]:\\Users\\).*?\1/gu,
      "[LOCAL_PATH]",
    )
    .replace(
      /(?:~\/|\/(?:Users|home|tmp|private|var|Volumes)\/|[A-Za-z]:\\Users\\)[^\s|)\]}>;,"']*/gu,
      "[LOCAL_PATH]",
    )
    .replace(/(?:^|(?<=[\s("'`]))\.(?:openclaw|ocm)(?:[/\\][^\s|)\]}>;,"']*)?/gmu, "[LOCAL_PATH]");
}

function publicText(value: string): string {
  return redactLocalPaths(redactPublicText(value));
}

function listText(value: string): string {
  return publicText(value)
    .replaceAll("|", "\\|")
    .replace(/\s*\n\s*/gu, " ")
    .trim();
}

export function renderRunComment(state: RunState): string {
  const testedSubsystems = Object.values(state.subsystems).filter(
    (entry) => entry.status !== "needs coverage" && entry.status !== "in progress",
  );
  const source = state.run.sourceGateway;
  const vote =
    state.promotionVote === "yes" ? "Yes" : state.promotionVote === "no" ? "No" : "No verdict";
  const releaseIssues = state.releaseIssues ?? [];
  const finalFeedback = state.finalFeedback?.trim() ?? "";
  const lines = [
    `<!-- openclaw-release-validation-run:${state.run.id} -->`,
    "## Release validation feedback",
    "",
    `**Candidate:** \`${state.run.candidateTag}\` · \`${state.run.candidateSha || "unknown"}\``,
    `**Journey:** ${state.run.fixture === "copied" ? "Existing-user upgrade" : "New-user clean state"}`,
    source
      ? `**Upgrade source:** \`${listText(source.version || "unknown")}\` · \`${listText(source.commit || "commit unknown")}\``
      : "**Upgrade source:** Not applicable",
    "",
    "### Subsystems tested",
    ...(testedSubsystems.length > 0
      ? testedSubsystems.map(
          (entry) =>
            `- **${listText(entry.title)} — ${entry.status}**${entry.notes ? `: ${listText(entry.notes)}` : ""}`,
        )
      : ["- None completed."]),
    "",
    "### Release feedback",
    "**Issues found during upgrade:**",
    ...(releaseIssues.length > 0
      ? releaseIssues.map((issue) => `- ${listText(issue)}`)
      : ["- None reported."]),
    "",
    "**Tester feedback:**",
    finalFeedback ? publicText(finalFeedback) : "No additional feedback.",
    "",
    `**Polished enough to promote?** ${vote}`,
  ];
  return `${lines.join("\n")}\n`;
}

export async function upsertRunComment({
  state,
  listComments,
  createComment,
  updateComment,
}: {
  state: RunState;
  listComments: () => Promise<RunIssueComment[]>;
  createComment: (body: string) => Promise<RunIssueComment>;
  updateComment: (commentId: number, body: string) => Promise<RunIssueComment>;
}): Promise<{ commentId: number; created: boolean }> {
  const marker = `<!-- openclaw-release-validation-run:${state.run.id} -->`;
  const matches = (await listComments()).filter((comment) => comment.body?.includes(marker));
  if (matches.length > 1) {
    throw new Error(`multiple release-validation comments contain ${marker}`);
  }
  const existing = matches[0];
  if (existing && state.github.commentId !== null && existing.id !== state.github.commentId) {
    throw new Error(
      `run comment id mismatch: ledger=${state.github.commentId}, marker=${existing.id}`,
    );
  }
  if (!existing && state.github.commentId !== null) {
    throw new Error(
      `ledger comment ${state.github.commentId} is missing its run marker; refusing to create a duplicate`,
    );
  }

  const body = renderRunComment(state);
  const comment = existing ? await updateComment(existing.id, body) : await createComment(body);
  return { commentId: comment.id, created: !existing };
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
  const runtimeName = candidate.version.replace(/^v/u, "");
  if (fixture === "clean") {
    return [
      {
        operation: "onboard-clean",
        command: "ocm",
        args: ["start", envName, "--runtime", runtimeName, "--onboard"],
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
      operation: "stage-copy",
      command: "node",
      args: [
        SCRIPT_PATH,
        "stage-copy",
        "--source",
        sourceGateway.stateDir,
        "--destination",
        copiedState,
      ],
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
      args: ["upgrade", envName, "--runtime", runtimeName, "--json"],
    },
    {
      operation: "normalize-local-gateway",
      command: "ocm",
      args: [`@${envName}`, "--", "config", "set", "gateway.mode", "local"],
    },
    {
      operation: "preflight-copy",
      checks: [
        { command: "ocm", args: [`@${envName}`, "--", "plugins", "list", "--json"] },
        { command: "ocm", args: [`@${envName}`, "--", "plugins", "registry", "--json"] },
      ],
    },
    { operation: "enforce-plugin-isolation" },
    {
      operation: "preview-plugin-updates-after-isolation",
      checks: [
        {
          command: "ocm",
          args: [`@${envName}`, "--", "plugins", "update", "--all", "--dry-run"],
        },
      ],
    },
    {
      operation: "enforce-single-channel-owner",
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
        { command: "ocm", args: [`@${envName}`, "--", "gateway", "probe", "--json"] },
        { command: "ocm", args: ["logs", envName, "--tail", "100", "--json"] },
      ],
    },
  );
  return steps;
}

function countOccurrences(value: string, search: string): number {
  return value.split(search).length - 1;
}

export function stageCopiedState(source: string, destination: string): StagedStateReceipt {
  if (!path.isAbsolute(source) || !path.isAbsolute(destination)) {
    throw new Error("stage-copy requires absolute --source and --destination paths");
  }
  const inputSource = path.resolve(source);
  const resolvedSource = realpathSync(source);
  const resolvedDestination = path.resolve(destination);
  const relativeDestination = path.relative(resolvedSource, resolvedDestination);
  if (
    relativeDestination === "" ||
    (!relativeDestination.startsWith(`..${path.sep}`) && relativeDestination !== "..")
  ) {
    throw new Error("stage-copy destination must be outside the source tree");
  }
  if (existsSync(resolvedDestination)) {
    throw new Error(`stage-copy destination already exists: ${resolvedDestination}`);
  }

  mkdirSync(resolvedDestination);
  execFileSync(
    "rsync",
    ["-a", "--exclude=*.sock", `${resolvedSource}${path.sep}`, `${resolvedDestination}${path.sep}`],
    { stdio: "inherit" },
  );

  const remaining = execFileSync(
    "rsync",
    [
      "-ani",
      "--delete",
      "--exclude=*.sock",
      "--exclude=openclaw.json",
      `${resolvedSource}${path.sep}`,
      `${resolvedDestination}${path.sep}`,
    ],
    { encoding: "utf8" },
  ).trim();
  if (remaining.length > 0) {
    throw new Error(`stage-copy verification found uncopied state:\n${remaining}`);
  }

  const configPath = path.join(resolvedDestination, "openclaw.json");
  const sourceConfigPath = path.join(resolvedSource, "openclaw.json");
  let configPathReplacements = 0;
  if (existsSync(sourceConfigPath) && !existsSync(configPath)) {
    throw new Error("stage-copy verification did not find the copied openclaw.json");
  }
  if (existsSync(configPath)) {
    const original = readFileSync(configPath, "utf8");
    const sourcePrefixes = [...new Set([inputSource, resolvedSource])];
    let normalized = original;
    for (const sourcePrefix of sourcePrefixes) {
      configPathReplacements += countOccurrences(normalized, sourcePrefix);
      normalized = normalized.replaceAll(sourcePrefix, resolvedDestination);
    }
    if (configPathReplacements > 0) {
      const temporaryPath = `${configPath}.release-validation.tmp`;
      writeFileSync(temporaryPath, normalized, "utf8");
      chmodSync(temporaryPath, statSync(configPath).mode);
      renameSync(temporaryPath, configPath);
    }
  }

  const copiedSocket = execFileSync(
    "find",
    [resolvedDestination, "-type", "s", "-print", "-quit"],
    { encoding: "utf8" },
  ).trim();
  if (copiedSocket.length > 0) {
    throw new Error(`stage-copy unexpectedly copied a Unix socket: ${copiedSocket}`);
  }

  return {
    source: resolvedSource,
    destination: resolvedDestination,
    configPathReplacements,
    copiedSockets: 0,
  };
}

function resolvePathForIsolation(candidate: string): string {
  const resolved = path.resolve(candidate);
  let ancestor = resolved;
  const suffix: string[] = [];
  while (!existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) {
      return resolved;
    }
    suffix.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  return path.join(realpathSync(ancestor), ...suffix);
}

function pathIsWithin(candidate: string, allowedRoot: string): boolean {
  const relative = path.relative(allowedRoot, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

export function checkPluginRegistryIsolation(
  rawRegistry: unknown,
  allowedRoots: string[],
): PluginIsolationReceipt {
  if (allowedRoots.length === 0 || allowedRoots.some((root) => !path.isAbsolute(root))) {
    throw new Error("plugin isolation requires at least one absolute --allowed-root");
  }
  if (!rawRegistry || typeof rawRegistry !== "object" || Array.isArray(rawRegistry)) {
    throw new Error("plugin registry receipt must be an object");
  }

  const payload = rawRegistry as Record<string, unknown>;
  const indexes: unknown[] = [];
  if (
    payload.registry &&
    typeof payload.registry === "object" &&
    !Array.isArray(payload.registry)
  ) {
    indexes.push(payload.registry);
  }
  for (const key of ["persisted", "current"] as const) {
    const value = payload[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      indexes.push(value);
    }
  }
  if (indexes.length === 0) {
    throw new Error("plugin registry receipt has no registry, persisted, or current index");
  }

  const resolvedRoots = allowedRoots.map(resolvePathForIsolation);
  const violations = new Map<string, PluginPathViolation>();
  let checkedPathCount = 0;
  const inspectPath = (pluginId: string, field: PluginPathViolation["field"], value: unknown) => {
    if (typeof value !== "string" || !path.isAbsolute(value)) {
      return;
    }
    checkedPathCount += 1;
    const resolved = resolvePathForIsolation(value);
    if (resolvedRoots.some((root) => pathIsWithin(resolved, root))) {
      return;
    }
    const violation = { pluginId, field, path: resolved } satisfies PluginPathViolation;
    violations.set(`${pluginId}\0${field}\0${resolved}`, violation);
  };

  for (const indexValue of indexes) {
    const index = indexValue as Record<string, unknown>;
    const installRecords = index.installRecords;
    if (installRecords && typeof installRecords === "object" && !Array.isArray(installRecords)) {
      for (const [pluginId, recordValue] of Object.entries(installRecords)) {
        if (!recordValue || typeof recordValue !== "object" || Array.isArray(recordValue)) {
          continue;
        }
        const record = recordValue as Record<string, unknown>;
        inspectPath(pluginId, "installPath", record.installPath);
        inspectPath(pluginId, "sourcePath", record.sourcePath);
      }
    }

    if (!Array.isArray(index.plugins)) {
      continue;
    }
    for (const pluginValue of index.plugins) {
      if (!pluginValue || typeof pluginValue !== "object" || Array.isArray(pluginValue)) {
        continue;
      }
      const plugin = pluginValue as Record<string, unknown>;
      if (plugin.enabled !== true || typeof plugin.pluginId !== "string") {
        continue;
      }
      inspectPath(plugin.pluginId, "rootDir", plugin.rootDir);
      inspectPath(plugin.pluginId, "source", plugin.source);
      inspectPath(plugin.pluginId, "manifestPath", plugin.manifestPath);
    }
  }

  return {
    ok: violations.size === 0,
    allowedRoots: resolvedRoots,
    checkedPathCount,
    violations: [...violations.values()].toSorted((left, right) =>
      `${left.pluginId}\0${left.field}\0${left.path}`.localeCompare(
        `${right.pluginId}\0${right.field}\0${right.path}`,
      ),
    ),
  };
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

const GITHUB_REPOSITORY = "openclaw/openclaw";

function ghJson<T>(args: string[]): T {
  return JSON.parse(
    execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }),
  ) as T;
}

async function runCampaignCommand(version?: string): Promise<void> {
  const releaseTag =
    version ??
    selectLatestBetaRelease(
      ghJson<GithubRelease[]>([
        "release",
        "list",
        "--repo",
        GITHUB_REPOSITORY,
        "--limit",
        "100",
        "--json",
        "tagName,isDraft,isPrerelease,publishedAt",
      ]),
    );
  if (!OPENCLAW_BETA_TAG.test(releaseTag)) {
    throw new Error(`expected an OpenClaw beta tag, got ${releaseTag}`);
  }

  const result = await getOrCreateCampaignIssue({
    releaseTag,
    listIssues: async () => {
      const listed = ghJson<CampaignIssue[]>([
        "issue",
        "list",
        "--repo",
        GITHUB_REPOSITORY,
        "--state",
        "all",
        "--limit",
        "200",
        "--json",
        "number,url,body",
      ]);
      return listed
        .filter((issue) => issue.body.includes(campaignMarker(releaseTag)))
        .map((issue) => {
          const current = ghJson<{ number: number; html_url: string; body: string }>([
            "api",
            `repos/${GITHUB_REPOSITORY}/issues/${issue.number}`,
          ]);
          return { number: current.number, url: current.html_url, body: current.body };
        });
    },
    createIssue: async ({ title, body }) => {
      const url = execFileSync(
        "gh",
        ["issue", "create", "--repo", GITHUB_REPOSITORY, "--title", title, "--body", body],
        { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
      ).trim();
      const issueNumber = url.split("/").at(-1);
      if (!issueNumber || !/^\d+$/u.test(issueNumber)) {
        throw new Error(`gh issue create returned an unexpected URL: ${url}`);
      }
      return ghJson<CampaignIssue>([
        "issue",
        "view",
        issueNumber,
        "--repo",
        GITHUB_REPOSITORY,
        "--json",
        "number,url,body",
      ]);
    },
  });
  process.stdout.write(`${JSON.stringify({ releaseTag, ...result }, null, 2)}\n`);
}

async function runCommentCommand(runPath: string | undefined): Promise<void> {
  if (!runPath) {
    throw new Error("comment requires --run <run.json>");
  }
  const state = JSON.parse(readFileSync(runPath, "utf8")) as RunState;
  if (!state.run?.id || !Number.isInteger(state.run.issueNumber) || !state.github) {
    throw new Error("run ledger is missing run id, issue number, or GitHub state");
  }
  const result = await upsertRunComment({
    state,
    listComments: async () =>
      ghJson<RunIssueComment[][]>([
        "api",
        "--paginate",
        "--slurp",
        `repos/${GITHUB_REPOSITORY}/issues/${state.run.issueNumber}/comments?per_page=100`,
      ]).flat(),
    createComment: async (body) =>
      ghJson<RunIssueComment>([
        "api",
        "--method",
        "POST",
        `repos/${GITHUB_REPOSITORY}/issues/${state.run.issueNumber}/comments`,
        "-f",
        `body=${body}`,
      ]),
    updateComment: async (commentId, body) =>
      ghJson<RunIssueComment>([
        "api",
        "--method",
        "PATCH",
        `repos/${GITHUB_REPOSITORY}/issues/comments/${commentId}`,
        "-f",
        `body=${body}`,
      ]),
  });
  state.github.commentId = result.commentId;
  state.github.lastSyncedHash = null;
  const temporaryPath = `${runPath}.release-validation.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(temporaryPath, runPath);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

export function renderMissionOverview(manifest: ScenarioManifest, fixture: FixtureKind): string {
  const lines = [
    "# Available OpenClaw release-validation tests",
    "",
    `Fixture: ${fixture}`,
    "",
    "Choose one number or name. After it finishes, choose the next one or finish validation. No mission starts until you confirm.",
    renderExitInstruction(),
    "",
    ...manifest.subsystems.map(
      (scenario, index) => `${index + 1}. ${scenario.title} — ${scenario.passEvidence.join(" ")}`,
    ),
  ];
  return `${lines.join("\n")}\n`;
}

export function renderMissionDetails(
  manifest: ScenarioManifest,
  fixture: FixtureKind,
  subsystemId: string,
): string {
  const scenario = manifest.subsystems.find((entry) => entry.id === subsystemId);
  if (!scenario) {
    throw new Error(`unknown subsystem: ${subsystemId}`);
  }
  const lines = [
    `# ${scenario.title}`,
    "",
    ...scenario.instructions[fixture].map((instruction) => `- ${instruction}`),
    `- Pass when: ${scenario.passEvidence.join(" ")}`,
    ...scenario.safety.map((item) => `- Safety: ${item}`),
    ...(scenario.docs.length > 0 ? [`- Docs: ${scenario.docs.join(", ")}`] : []),
    "",
    renderExitInstruction(),
  ];
  return `${lines.join("\n")}\n`;
}

function runBoardCommand(fixture: FixtureKind): void {
  const manifest = loadScenarioManifest();
  process.stdout.write(renderMissionOverview(manifest, fixture));
}

function runMissionCommand(fixture: FixtureKind, subsystemId: string | undefined): void {
  if (!subsystemId) {
    throw new Error("mission requires a subsystem id, such as pairing or control-ui");
  }
  process.stdout.write(renderMissionDetails(loadScenarioManifest(), fixture, subsystemId));
}

async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2);
  if (command === "stage-copy") {
    const sourceIndex = args.indexOf("--source");
    const destinationIndex = args.indexOf("--destination");
    const source = sourceIndex === -1 ? undefined : args[sourceIndex + 1];
    const destination = destinationIndex === -1 ? undefined : args[destinationIndex + 1];
    if (!source || !destination) {
      throw new Error("stage-copy requires --source <absolute-path> --destination <absolute-path>");
    }
    process.stdout.write(`${JSON.stringify(stageCopiedState(source, destination), null, 2)}\n`);
    return;
  }
  if (command === "check-plugin-isolation") {
    const registryIndex = args.indexOf("--registry");
    const registryPath = registryIndex === -1 ? undefined : args[registryIndex + 1];
    const allowedRoots = args.flatMap((arg, index) =>
      arg === "--allowed-root" && args[index + 1] ? [args[index + 1]] : [],
    );
    if (!registryPath) {
      throw new Error("check-plugin-isolation requires --registry <json-path>");
    }
    const receipt = checkPluginRegistryIsolation(
      JSON.parse(readFileSync(registryPath, "utf8")) as unknown,
      allowedRoots,
    );
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    if (!receipt.ok) {
      process.exitCode = 1;
    }
    return;
  }
  if (command === "campaign") {
    const versionIndex = args.indexOf("--version");
    await runCampaignCommand(versionIndex === -1 ? undefined : args[versionIndex + 1]);
    return;
  }
  if (command === "comment") {
    const runIndex = args.indexOf("--run");
    await runCommentCommand(runIndex === -1 ? undefined : args[runIndex + 1]);
    return;
  }
  if (command === "board" || command === "mission") {
    const fixtureIndex = args.indexOf("--fixture");
    const fixture = fixtureIndex === -1 ? "clean" : args[fixtureIndex + 1];
    if (fixture !== "clean" && fixture !== "copied") {
      throw new Error("--fixture must be clean or copied");
    }
    if (command === "board") {
      runBoardCommand(fixture);
    } else {
      runMissionCommand(
        fixture,
        args.find((arg) => !arg.startsWith("--") && arg !== fixture),
      );
    }
    return;
  }
  process.stdout.write(
    [
      "OpenClaw release-validation helpers",
      "",
      "  stage-copy --source <path> --destination <path>  Copy state, omit sockets, normalize paths",
      "  check-plugin-isolation --registry <path> --allowed-root <path>  Reject copied plugin paths outside owned roots",
      "  campaign [--version vYYYY.M.D-beta.N]  Get or create the shared release issue",
      "  comment --run <run.json>                Create or update this run's single ledger comment",
      "  board [--fixture clean|copied]          Show the compact test-selection menu",
      "  mission <id> [--fixture clean|copied]   Show details for one selected mission",
      "",
    ].join("\n"),
  );
}

const isDirectInvocation =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === SCRIPT_PATH;
if (isDirectInvocation) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
