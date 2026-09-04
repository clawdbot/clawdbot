import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  captureQaRunComparisonIdentity,
  compareQaRunConditions,
  finalizeQaRunComparisonIdentity,
} from "./run-comparability.js";
import { buildQaSuiteSummaryJson } from "./suite-artifacts.js";
import { makeQaSuiteTestScenario } from "./suite-test-helpers.js";

describe("QA completed-run comparability", () => {
  let repoRoot: string;
  const scenario = makeQaSuiteTestScenario("check-a");
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
  const capture = (harness = "harness-a", runProfile = { concurrency: 1 }) =>
    captureQaRunComparisonIdentity({
      repoRoot,
      harness,
      scenarios: [scenario],
      runProfile,
    });
  const summary = (harness = "harness-a", model = "provider-a/model-a", alternateModel = model) =>
    buildQaSuiteSummaryJson({
      comparisonIdentity: capture(harness),
      scenarios: [{ name: scenario.title, status: "pass", steps: [] }],
      startedAt: new Date("2026-01-01T00:00:00Z"),
      finishedAt: new Date("2026-01-01T00:00:01Z"),
      metrics: { wallMs: 1000 },
      providerMode: "mock-openai",
      primaryModel: model,
      alternateModel,
      fastMode: false,
      concurrency: 1,
    });

  beforeEach(async () => {
    repoRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "qa-comparability-")));
    git(["init", "-q"]);
    git([
      "-c",
      "user.name=QA Fixture",
      "-c",
      "user.email=qa@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-qm",
      "fixture",
    ]);
  });
  afterEach(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  it("compares producer metadata for different harnesses and models without ranking them", () => {
    const candidate = summary("harness-a", "provider-a/model-a", "alternate-a/model-a2");
    candidate.scenarios[0]!.status = "fail";
    const baseline = summary("harness-b", "provider-b/model-b", "alternate-b/model-b2");
    const report = compareQaRunConditions(candidate, baseline);
    expect(candidate.run.comparisonIdentity?.sourceRevision).toBe(git(["rev-parse", "HEAD"]));
    expect(report).toMatchObject({
      status: "comparable",
      candidate: {
        harness: "harness-a",
        primaryModel: "provider-a/model-a",
        primaryProvider: "provider-a",
        alternateModel: "alternate-a/model-a2",
        alternateProvider: "alternate-a",
        elapsedMs: 1000,
      },
      baseline: {
        harness: "harness-b",
        primaryModel: "provider-b/model-b",
        primaryProvider: "provider-b",
        alternateModel: "alternate-b/model-b2",
        alternateProvider: "alternate-b",
        elapsedMs: 1000,
      },
      checks: [{ name: scenario.title, candidate: "fail", baseline: "pass" }],
      regressions: [scenario.title],
    });
    expect(report).not.toHaveProperty("winner");
    expect(report).not.toHaveProperty("pass");
  });

  it("preserves alternate model differences even when the primary model is identical", () => {
    const candidate = summary("harness-a", "provider/model", "alternate-a/model");
    const baseline = summary("harness-a", "provider/model", "unqualified-model");
    expect(compareQaRunConditions(candidate, baseline)).toMatchObject({
      status: "comparable",
      candidate: {
        primaryModel: "provider/model",
        alternateModel: "alternate-a/model",
        alternateProvider: "alternate-a",
      },
      baseline: {
        primaryModel: "provider/model",
        alternateModel: "unqualified-model",
        alternateProvider: null,
      },
    });
  });

  it.each([undefined, null, ""])(
    "rejects invalid alternate model metadata: %s",
    (alternateModel) => {
      const candidate = summary();
      expect(
        compareQaRunConditions(
          { ...candidate, run: { ...candidate.run, alternateModel } },
          summary(),
        ),
      ).toEqual({
        status: "not-comparable",
        reasons: ["Candidate lacks valid completed-run comparison metadata."],
      });
    },
  );

  it("matches outcomes by identity when summary rows have different ordering", () => {
    const candidate = summary();
    const baseline = summary();
    for (const value of [candidate, baseline]) {
      value.run.comparisonIdentity!.requiredScenarios.push("check-b");
      value.scenarios.push({ name: "check-b", status: "pass", steps: [] });
    }
    candidate.scenarios.reverse();
    candidate.scenarios[0]!.status = "fail";
    expect(compareQaRunConditions(candidate, baseline)).toMatchObject({
      status: "comparable",
      checks: [
        { name: scenario.title, candidate: "pass", baseline: "pass" },
        { name: "check-b", candidate: "fail", baseline: "pass" },
      ],
      regressions: ["check-b"],
    });
  });

  it.each(["taskDigest", "sourceRevision", "checkProfileDigest", "runProfileDigest"] as const)(
    "rejects differing %s even when all checks pass",
    (key) => {
      const candidate = summary();
      const baseline = summary();
      baseline.run.comparisonIdentity![key] =
        key === "sourceRevision" ? "f".repeat(40) : "f".repeat(64);
      expect(compareQaRunConditions(candidate, baseline)).toEqual({
        status: "not-comparable",
        reasons: [`${key} is missing or different.`],
      });
    },
  );

  it.each([
    [
      "missing identity",
      (value: ReturnType<typeof summary>) => {
        delete value.run.comparisonIdentity;
      },
    ],
    [
      "running suite",
      (value: ReturnType<typeof summary>) => {
        value.run.status = "running";
      },
    ],
    [
      "missing check",
      (value: ReturnType<typeof summary>) => {
        value.scenarios = [];
      },
    ],
    [
      "duplicated check",
      (value: ReturnType<typeof summary>) => {
        value.scenarios.push({ ...value.scenarios[0]! });
      },
    ],
    [
      "substituted check",
      (value: ReturnType<typeof summary>) => {
        value.scenarios[0]!.name = "unexpected-check";
      },
    ],
    [
      "duplicate required check",
      (value: ReturnType<typeof summary>) => {
        value.run.comparisonIdentity!.requiredScenarios.push(scenario.title);
      },
    ],
    [
      "unknown source",
      (value: ReturnType<typeof summary>) => {
        value.run.comparisonIdentity!.sourceRevision = null;
      },
    ],
  ])("does not compare %s", (_name, mutate) => {
    const baseline = summary();
    const candidate = summary();
    mutate(candidate);
    const report = compareQaRunConditions(candidate, baseline);
    expect(report.status).toBe("not-comparable");
    expect(report.reasons.length).toBeGreaterThan(0);
    expect(report).not.toHaveProperty("regressions");
  });

  it("rejects unsupported identity versions without interpreting them", () => {
    const candidate = summary();
    expect(
      compareQaRunConditions(
        {
          ...candidate,
          run: {
            ...candidate.run,
            comparisonIdentity: { ...candidate.run.comparisonIdentity, version: 2 },
          },
        },
        summary(),
      ).status,
    ).toBe("not-comparable");
  });

  it("hashes content and run settings, not labels or object insertion order", () => {
    const first = captureQaRunComparisonIdentity({
      repoRoot,
      scenarios: [scenario],
      harness: "a",
      runProfile: { concurrency: 1, fastMode: false },
    });
    const reordered = captureQaRunComparisonIdentity({
      repoRoot,
      scenarios: [scenario],
      harness: "b",
      runProfile: { fastMode: false, concurrency: 1 },
    });
    expect(first.runProfileDigest).toBe(reordered.runProfileDigest);
    expect(capture("a", { concurrency: 2 }).runProfileDigest).not.toBe(capture().runProfileDigest);
    const changed = captureQaRunComparisonIdentity({
      repoRoot,
      scenarios: [{ ...scenario, successCriteria: ["different check"] }],
      harness: "a",
      runProfile: {},
    });
    expect(changed.taskDigest).not.toBe(first.taskDigest);
    expect(changed.checkProfileDigest).not.toBe(first.checkProfileDigest);
  });

  it("does not retain a clean revision after the checkout changes during the run", async () => {
    const identity = capture();
    await fs.writeFile(path.join(repoRoot, "untracked-input.txt"), "changed");
    expect(capture().sourceRevision).toBeNull();
    expect(finalizeQaRunComparisonIdentity(identity, repoRoot).sourceRevision).toBeNull();
    await fs.unlink(path.join(repoRoot, "untracked-input.txt"));
    git([
      "-c",
      "user.name=QA Fixture",
      "-c",
      "user.email=qa@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-qm",
      "changed",
    ]);
    expect(finalizeQaRunComparisonIdentity(identity, repoRoot).sourceRevision).toBeNull();
  });
});
