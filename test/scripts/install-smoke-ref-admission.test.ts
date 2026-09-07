import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { createTempDirTracker } from "../helpers/temp-dir.js";

type Step = { name: string; run?: string; if?: string };
const root = process.cwd();
const workflow = parse(readFileSync(".github/workflows/openclaw-release-checks.yml", "utf8")) as {
  jobs: Record<string, { steps?: Step[]; needs?: string[]; if?: string }>;
};
const steps = expectDefined(
  expectDefined(workflow.jobs.resolve_target, "resolve_target job").steps,
  "resolve_target steps",
);
const tempDirs = createTempDirTracker();
let remote: string;
let mainSha: string;
let branchAncestor: string;
let branchHead: string;
let prSha: string;
let orphanSha: string;

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function commit(label: string) {
  writeFileSync(join(remote, "fixture.txt"), label);
  git(remote, "add", "fixture.txt");
  git(remote, "commit", "-qm", label);
  return git(remote, "rev-parse", "HEAD");
}

beforeAll(() => {
  remote = tempDirs.make("installer-admission-remote-");
  git(remote, "init", "-q", "-b", "main");
  git(remote, "config", "user.name", "Test User");
  git(remote, "config", "user.email", "test@example.invalid");
  mainSha = commit("main");
  git(remote, "checkout", "-qb", "feature");
  branchAncestor = commit("branch ancestor");
  branchHead = commit("branch head");
  git(remote, "branch", "ambiguous");
  git(remote, "-c", "tag.gpgSign=false", "tag", "ambiguous");
  git(remote, "checkout", "--detach", mainSha);
  commit("lightweight release only");
  git(remote, "-c", "tag.gpgSign=false", "tag", "v2026.9.1");
  commit("annotated release only");
  git(remote, "-c", "tag.gpgSign=false", "tag", "-am", "release", "v2026.9.2");
  git(remote, "checkout", "--detach", mainSha);
  prSha = commit("PR only");
  git(remote, "update-ref", "refs/pull/123/head", prSha);
  orphanSha = commit("unreferenced");
  git(remote, "checkout", "main");
});

afterAll(() => tempDirs.cleanup());

function output(file: string) {
  return Object.fromEntries(
    readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );
}

function run(script: string, cwd: string, env: Record<string, string>) {
  const file = join(tempDirs.make("installer-admission-output-"), "output");
  writeFileSync(file, "");
  // Git uses a local fixture remote; spawnSync bounds the process on hosts
  // without the GNU timeout executable used by the Ubuntu workflow.
  const portableScript = `
    if ! command -v timeout >/dev/null; then
      timeout() { while [[ "$1" == --* ]]; do shift; done; shift; "$@"; }
    fi
    ${script}`;
  const result = spawnSync("bash", ["--noprofile", "--norc", "-c", portableScript], {
    cwd,
    encoding: "utf8",
    timeout: 15_000,
    env: { ...process.env, GITHUB_OUTPUT: file, ...env },
  });
  return { ...result, outputs: output(file) };
}

function resolveRef(ref: string, expected = "") {
  return run('bash "$RESOLVER" --ref "$REF" --expected-sha "$EXPECTED" --fallback-ok', root, {
    RESOLVER: resolve("scripts/github/resolve-openclaw-ref.sh"),
    OPENCLAW_REF_REMOTE: remote,
    REF: ref,
    EXPECTED: expected,
  });
}

function admit(ref: string, expected = "", afterResolution?: () => void) {
  const resolved = resolveRef(ref, expected);
  if (resolved.status !== 0) {
    return resolved;
  }
  const refKind = expectDefined(resolved.outputs.ref_kind, "resolved ref kind");
  const resolvedSha =
    refKind === "unknown" ? "" : expectDefined(resolved.outputs.sha, "resolved immutable SHA");
  afterResolution?.();
  const source = tempDirs.make("installer-admission-source-");
  git(source, "init", "-q");
  git(source, "remote", "add", "origin", remote);
  // Mirror checkout's immutable selection, including the legacy fallback path.
  const selection = refKind === "unknown" ? ref : resolvedSha;
  try {
    git(source, "fetch", "--quiet", "--no-tags", "origin", selection);
    git(source, "checkout", "--quiet", "--detach", "FETCH_HEAD");
  } catch {
    return { ...resolved, status: 1, stderr: "candidate checkout failed", outputs: {} };
  }
  const finalize = expectDefined(
    steps.find((step) => step.name === "Finalize resolved SHA"),
    "finalize resolved SHA step",
  );
  const finalized = run(expectDefined(finalize.run, "finalize run body"), source, {
    RESOLVED_SHA: resolvedSha,
    EXPECTED_SHA: expected,
  });
  if (finalized.status !== 0) {
    return finalized;
  }
  const selectedSha = expectDefined(finalized.outputs.sha, "finalized SHA");
  const admission = expectDefined(
    steps.find((step) => step.name === "Validate selected ref belongs to this repository"),
    "ref admission step",
  );
  if (
    admission.if === "steps.fast_ref.outputs.fallback == 'true'" &&
    resolved.outputs.fallback !== "true"
  ) {
    return { ...resolved, outputs: { admitted: "true" } };
  }
  return run(expectDefined(admission.run, "ref admission run body"), source, {
    RELEASE_REF: ref,
    SELECTED_SHA: selectedSha,
    GITHUB_TOKEN: "",
  });
}

function plan(admitted: string, overrides: Record<string, string> = {}) {
  const capture = expectDefined(
    steps.find((step) => step.name === "Capture selected inputs"),
    "capture selected inputs step",
  );
  const captured = run(expectDefined(capture.run, "capture selected inputs run body"), root, {
    CANDIDATE_ARTIFACT_JSON_INPUT: "",
    RELEASE_ALLOW_UNRELEASED_CHANGELOG_INPUT: "false",
    RELEASE_CODEX_PLUGIN_SPEC_INPUT: "",
    RELEASE_CROSS_OS_SUITE_FILTER_INPUT: "",
    RELEASE_FAIL_FAST_INPUT: "false",
    RELEASE_FILTER_VALIDATOR: resolve("scripts/github/validate-release-suite-filters.sh"),
    RELEASE_LIVE_SUITE_FILTER_INPUT: "",
    RELEASE_MODE_INPUT: "both",
    RELEASE_PHASE_INPUT: "all",
    RELEASE_PACKAGE_ACCEPTANCE_PACKAGE_SPEC_INPUT: "",
    RELEASE_PACKAGE_SPEC_INPUT: "",
    RELEASE_PROFILE_INPUT: "beta",
    RELEASE_PROVIDER_INPUT: "openai",
    RELEASE_QA_DISCORD_LIVE_CI_ENABLED: "false",
    RELEASE_QA_SLACK_LIVE_CI_ENABLED: "false",
    RELEASE_QA_WHATSAPP_LIVE_CI_ENABLED: "false",
    RELEASE_REF_INPUT: prSha,
    RELEASE_RERUN_GROUP_INPUT: "install-smoke",
    RELEASE_RUN_MATURITY_SCORECARD_INPUT: "false",
    RELEASE_RUN_RELEASE_SOAK_INPUT: "false",
    RELEASE_SKIP_PACKAGE_TELEGRAM_E2E_INPUT: "false",
    TELEGRAM_WAIVER: "",
    ...overrides,
  });
  if (captured.status !== 0) {
    return captured;
  }
  const guard = expectDefined(
    steps.find((step) => step.name === "Enforce selected ref execution boundary"),
    "ref execution boundary step",
  );
  const guarded = run(expectDefined(guard.run, "ref execution boundary run body"), root, {
    SELECTED_REF_ADMITTED: admitted,
    ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS: "false",
    ...Object.fromEntries(
      Object.entries(captured.outputs).map(([key, value]) => [key.toUpperCase(), value]),
    ),
  });
  return { ...guarded, plan: captured.outputs };
}

describe("installer ref admission", () => {
  it.each(["main", "feature", "v2026.9.1", "v2026.9.2"])(
    "admits repository branch history and release tag %s",
    (ref) => {
      const result = admit(ref);
      expect(result.status, result.stderr).toBe(0);
      expect(result.outputs.admitted).toBe("true");
    },
  );

  it("admits branch ancestors selected by immutable SHA", () => {
    const result = admit(branchAncestor);
    expect(result.status, result.stderr).toBe(0);
    expect(result.outputs.admitted).toBe("true");
  });

  it.each(["PR ref", "PR SHA", "unreferenced SHA"])(
    "resolves %s without granting host execution authority",
    (kind) => {
      const ref = kind === "PR ref" ? "refs/pull/123/head" : kind === "PR SHA" ? prSha : orphanSha;
      const result = admit(ref);
      expect(result.status, result.stderr).toBe(0);
      const admitted = expectDefined(result.outputs.admitted, "ref admission output");
      expect(admitted).toBe("false");
      expect(plan(admitted).status).toBe(0);
      expect(plan(admitted, { RELEASE_RERUN_GROUP_INPUT: "all" }).status).not.toBe(0);
    },
  );

  it("does not follow a ref that moves after resolution", () => {
    const result = admit("refs/pull/123/head", prSha, () =>
      git(remote, "update-ref", "refs/pull/123/head", mainSha),
    );
    git(remote, "update-ref", "refs/pull/123/head", prSha);
    expect(result.status, result.stderr).toBe(0);
    expect(result.outputs.admitted).toBe("false");
  });

  it.each(["ambiguous", "missing-ref"])("rejects %s", (ref) => {
    expect(admit(ref).status).not.toBe(0);
  });

  it("rejects expected-SHA mismatch", () => {
    expect(admit("feature", mainSha).status).not.toBe(0);
  });

  it("accepts uppercase exact identity without changing the selected commit", () => {
    const result = admit(branchHead.toUpperCase(), branchHead.toUpperCase());
    expect(result.status, result.stderr).toBe(0);
    expect(result.outputs.admitted).toBe("true");
  });

  it("does not let always-running consumers bypass failed admission", () => {
    for (const [name, job] of Object.entries(workflow.jobs)) {
      if (
        name === "summary" ||
        !job.needs?.includes("resolve_target") ||
        !job.if?.includes("always()")
      ) {
        continue;
      }
      expect(job.if, name).toContain("needs.resolve_target.result == 'success'");
    }
  });

  const incompatibleSelections: Array<Record<string, string>> = [
    { RELEASE_RERUN_GROUP_INPUT: "all" },
    { RELEASE_RERUN_GROUP_INPUT: "qa" },
    { RELEASE_RERUN_GROUP_INPUT: "live-e2e" },
    { RELEASE_RERUN_GROUP_INPUT: "cross-os" },
    { RELEASE_RERUN_GROUP_INPUT: "package" },
    { RELEASE_PHASE_INPUT: "candidate" },
    { RELEASE_RUN_MATURITY_SCORECARD_INPUT: "true" },
    { RELEASE_RUN_RELEASE_SOAK_INPUT: "true" },
    { RELEASE_PROFILE_INPUT: "stable" },
    { RELEASE_PACKAGE_SPEC_INPUT: "openclaw@2026.9.1" },
    { RELEASE_PACKAGE_ACCEPTANCE_PACKAGE_SPEC_INPUT: "openclaw@2026.9.1" },
    { RELEASE_LIVE_SUITE_FILTER_INPUT: "qa-live-matrix" },
    { RELEASE_CROSS_OS_SUITE_FILTER_INPUT: "ubuntu" },
  ];
  it.each(incompatibleSelections)("rejects unadmitted incompatible plan %j", (selection) => {
    expect(plan("false", selection).status).not.toBe(0);
  });

  it.each(["all", "independent"])("retains isolated installer work in phase %s", (phase) => {
    const result = plan("false", { RELEASE_PHASE_INPUT: phase });
    expect(result.status, result.stderr).toBe(0);
    expect("plan" in result && result.plan).toMatchObject({
      install_smoke_scheduled: "true",
      cross_os_scheduled: "false",
      package_acceptance_scheduled: "false",
      live_e2e_scheduled: "false",
      qa_parity_scheduled: "false",
      qa_live_scheduled: "false",
      run_maturity_scorecard: "false",
    });
  });

  it("preserves admitted full release plans", () => {
    expect(plan("true", { RELEASE_RERUN_GROUP_INPUT: "all" }).status).toBe(0);
  });
});
