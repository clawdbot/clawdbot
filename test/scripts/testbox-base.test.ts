import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { devNull } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();
const workflows = [
  ".github/workflows/ci-check-testbox.yml",
  ".github/workflows/ci-check-arm-testbox.yml",
  ".github/workflows/ci-build-artifacts-testbox.yml",
];

type Step = {
  name: string;
  id?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function runBasePreparation(
  repo: string,
  workflowName: string,
  base: string,
  trace: string,
  eventName: string,
) {
  const workflow = parse(fs.readFileSync(workflowName, "utf8"));
  const job = Object.values(workflow.jobs)[0] as { steps: Step[] };
  const values = new Map([
    ["github.event.pull_request.base.sha", base],
    ["github.event.pull_request.base.ref", "main"],
  ]);
  const interpolate = (value: string): string =>
    value.replace(/\$\{\{\s*(.*?)\s*\}\}/gu, (_match, expression: string) => {
      // These workflows use only a PR-output-or-dispatch-default expression here.
      const [key = ""] = expression
        .replace(/^github.event_name == 'pull_request' && /u, "")
        .split(" || ");
      const defaultRef = expression.match(/\|\| '([^']+)'/u)?.[1];
      const resolved =
        eventName === "workflow_dispatch" && defaultRef ? defaultRef : values.get(key);
      if (resolved === undefined) {
        throw new Error(`Unbound workflow expression: ${expression}`);
      }
      return resolved;
    });
  const renderEnv = (env: Record<string, string> = {}) =>
    Object.fromEntries(Object.entries(env).map(([key, value]) => [key, interpolate(value)]));
  const bin = path.join(createTempDir("openclaw-testbox-tools-"), "bin");
  fs.mkdirSync(bin);
  // System-wide Node links are unrelated to Git preparation and must stay fixture-local.
  fs.writeFileSync(
    path.join(bin, "sudo"),
    '#!/bin/sh\nif [ "$1" = tee ]; then cat >/dev/null; fi\n',
  );
  fs.chmodSync(path.join(bin, "sudo"), 0o755);
  const step = job.steps.find((entry) => entry.name === "Prepare Testbox shell");
  if (!step?.uses) {
    throw new Error("Missing Testbox preparation action");
  }
  const actionPath = path.join(repo, step.uses);
  for (const [key, value] of Object.entries(step.with ?? {})) {
    values.set(`inputs.${key}`, interpolate(value));
  }
  const action = parse(fs.readFileSync(path.join(actionPath, "action.yml"), "utf8"));
  const actionStep: Step = action.runs.steps[0];
  if (!actionStep.run) {
    throw new Error("Missing Testbox preparation command");
  }
  return spawnSync("bash", ["-euo", "pipefail", "-c", actionStep.run], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      ...renderEnv(actionStep.env),
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      RUNNER_OS: process.platform === "win32" ? "Windows" : "Linux",
      GITHUB_ACTION_PATH: actionPath,
      GITHUB_EVENT_NAME: eventName,
      GITHUB_BASE_REF: "main",
      GIT_CONFIG_GLOBAL: devNull,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_ALLOW_PROTOCOL: "",
      GIT_TRACE2_EVENT: trace,
    },
  });
}

describe.each(workflows)("%s Testbox base preparation", (workflowName) => {
  it.each([
    { shape: "merge", branch: "main", depth: 2, passes: true, eventName: "pull_request" },
    { shape: "linear", branch: "feature", depth: 2, passes: true, eventName: "pull_request" },
    {
      shape: "merge without parents",
      branch: "main",
      depth: 1,
      passes: false,
      eventName: "pull_request",
    },
    {
      shape: "manual",
      branch: "feature",
      depth: workflowName.endsWith("/ci-check-testbox.yml") ? 1 : 0,
      passes: true,
      eventName: "workflow_dispatch",
    },
  ])("pins the correct base in a $shape checkout", ({ branch, depth, passes, eventName }) => {
    const source = createTempDir("openclaw-testbox-source-");
    git(source, "init", "-q", "--initial-branch=main");
    git(source, "config", "user.name", "Test User");
    git(source, "config", "user.email", "test@example.com");
    for (const action of ["git-owner", "ensure-base-commit", "prepare-testbox-shell"]) {
      fs.cpSync(`.github/actions/${action}`, path.join(source, ".github/actions", action), {
        recursive: true,
      });
    }
    fs.mkdirSync(path.join(source, "scripts/lib"), { recursive: true });
    for (const helper of ["merge-head-diff-base.mjs", "arg-utils.runtime.mjs"]) {
      fs.copyFileSync(`scripts/lib/${helper}`, path.join(source, "scripts/lib", helper));
    }
    git(source, "add", ".");
    git(source, "commit", "-qm", "base");
    const eventBase = git(source, "rev-parse", "HEAD");
    git(source, "switch", "-q", "-c", "feature");
    fs.writeFileSync(path.join(source, "feature.txt"), "feature\n");
    git(source, "add", ".");
    git(source, "commit", "-qm", "feature");
    git(source, "switch", "-q", "main");
    fs.writeFileSync(path.join(source, "main.txt"), "main\n");
    git(source, "add", ".");
    git(source, "commit", "-qm", "main advanced");
    const mainBase = git(source, "rev-parse", "HEAD");
    git(source, "merge", "--no-ff", "feature", "-m", "synthetic merge");
    const repo = createTempDir("openclaw-testbox-shallow-");
    git(
      source,
      "clone",
      "--quiet",
      "--no-local",
      ...(depth ? [`--depth=${depth}`] : []),
      "--branch",
      branch,
      source,
      repo,
    );
    expect(git(repo, "rev-parse", "--is-shallow-repository")).toBe(String(depth > 0));
    expect(
      spawnSync("git", ["cat-file", "-e", `${eventBase}^{commit}`], { cwd: repo }).status === 0,
    ).toBe(depth === 0 || (branch === "feature" && depth > 1));
    const before = spawnSync("git", ["rev-parse", "refs/remotes/origin/main"], {
      cwd: repo,
      encoding: "utf8",
    });
    const trace = path.join(createTempDir("openclaw-testbox-trace-"), "git.jsonl");
    const result = runBasePreparation(repo, workflowName, eventBase, trace, eventName);
    const fetches = fs
      .readFileSync(trace, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((event) => event.event === "cmd_name" && event.name === "fetch");
    if (!passes) {
      expect(result.status).not.toBe(0);
      expect(result.stdout).toContain("Base commit still unavailable");
      expect(fetches).toHaveLength(5);
      expect(git(repo, "rev-parse", "refs/remotes/origin/main")).toBe(before.stdout.trim());
      return;
    }
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(fetches).toEqual([]);
    expect(git(repo, "rev-parse", "refs/remotes/origin/main")).toBe(
      eventName === "workflow_dispatch"
        ? depth === 1
          ? git(repo, "rev-parse", "HEAD")
          : git(source, "rev-parse", "main")
        : branch === "main"
          ? mainBase
          : eventBase,
    );
  });
});
