import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createMainRefreshFixture } from "./pr-main-refresh.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const describePosix = process.platform === "win32" ? describe.skip : describe;

describePosix("native hosted merge handoff", () => {
  let f: ReturnType<typeof createMainRefreshFixture>;
  let preparedGates: string;

  beforeAll(() => {
    f = createMainRefreshFixture(tempDirs.make("openclaw-pr-merge-hosted-"));
    f.configure({ hostedCi: "release" });
    const prepare = f.run("prepare-run");
    expect(prepare.status, prepare.stdout + prepare.stderr).toBe(0);
    preparedGates = readFileSync(join(f.local, "gates.env"), "utf8");
    expect(
      JSON.parse(readFileSync(join(f.local, "gates-hosted-checks.json"), "utf8")),
    ).toMatchObject({
      headSha: f.head,
      workflows: expect.arrayContaining([
        expect.objectContaining({ id: 6, event: "workflow_dispatch", headSha: f.head }),
      ]),
    });
    delete f.env.OPENCLAW_TESTBOX;
    // A changelog-only checkout must not narrow the prepared source change's
    // gates, nor may a PR-controlled helper replace the canonical verifier.
    f.git(f.worktree, "checkout", "--detach", f.main);
    writeFileSync(join(f.worktree, "CHANGELOG.md"), "Unrelated changelog-only checkout.\n");
    f.git(f.worktree, "add", "CHANGELOG.md");
    f.git(f.worktree, "commit", "-qm", "docs: unrelated changelog-only checkout");
    writeFileSync(
      join(f.worktree, "scripts/verify-pr-hosted-gates.mjs"),
      "throw new Error('PR helper executed');\n",
    );
  });

  beforeEach(() => {
    // Reuse one successful preparation. Rejections must not dispatch or damage
    // that state; the final case alone completes the synthetic server merge.
    f.configure({ hostedCi: "release", requiredChecks: "pass" });
    writeFileSync(join(f.local, "gates.env"), preparedGates);
  });

  it("revalidates prepared release-gate evidence without waiting for older stuck PR CI", () => {
    const before = f.events().length;
    const result = f.run("merge-verify");
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const watchLog = join(f.local, "merge-checks-watch.log");
    expect(existsSync(watchLog) ? readFileSync(watchLog, "utf8") : "").toBe("");
    const events = f.events().slice(before);
    const hosted = events.findIndex((event) => event.kind === "hosted-gate");
    expect(hosted).toBeGreaterThanOrEqual(0);
    expect(events.findIndex((event) => event.kind === "required-checks")).toBeGreaterThan(hosted);
    expect(events.some((event) => event.kind === "ci-watched")).toBe(false);
  });

  it.each([
    "missing",
    "stale",
    "failed",
    "wrong-head",
    "unmarked",
    "wrong-workflow",
    "scheduled-failure",
    "api-error",
  ] as const)(
    "blocks %s hosted evidence despite saved green proof in an OR-list caller",
    (hostedCi) => {
      f.configure({ hostedCi });
      const savedProof = readFileSync(join(f.local, "gates-hosted-checks.json"), "utf8");
      const before = f.events().length;
      const result = f.shell("merge_run 42 || exit 1");
      const output = result.stdout + result.stderr;
      expect(result.status, output).toBe(1);
      expect(output).toContain("hosted CI/Testbox gates failed");
      expect(readFileSync(join(f.local, "gates-hosted-checks.log"), "utf8")).toContain(
        hostedCi === "api-error"
          ? "Hosted API unavailable"
          : "Missing successful recent CI workflow",
      );
      expect(
        f
          .events()
          .slice(before)
          .some((event) => event.kind === "required-checks" || event.kind === "ci-watched"),
      ).toBe(false);
      expect(readFileSync(join(f.local, "gates-hosted-checks.json"), "utf8")).toBe(savedProof);
      expect(existsSync(join(f.local, "merge-output.log"))).toBe(false);
      expect(
        f.git(
          f.canonical,
          "for-each-ref",
          "--format=%(refname)",
          "refs/openclaw/pr-merge-outcomes/42",
        ),
      ).toBe("");
    },
  );

  it("requires the prepare gate artifact before merge", () => {
    rmSync(join(f.local, "gates.env"));
    const result = f.shell("merge_run 42 || exit 1");
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toContain("Missing required artifact: .local/gates.env");
    expect(existsSync(join(f.local, "merge-output.log"))).toBe(false);
  });

  it.each(["fail", "pending", "api-error"] as const)(
    "keeps %s required checks blocking after hosted proof",
    (requiredChecks) => {
      f.configure({ requiredChecks });
      const before = f.events().length;
      const result = f.shell("merge_run 42 || exit 1");
      const output = result.stdout + result.stderr;
      expect(result.status, output).toBe(1);
      expect(output).toContain(
        requiredChecks === "api-error"
          ? "unable to verify the required GitHub checks"
          : requiredChecks === "pending"
            ? "Required checks are still pending"
            : "Required checks are failing",
      );
      const events = f.events().slice(before);
      expect(events.findIndex((event) => event.kind === "required-checks")).toBeGreaterThan(
        events.findIndex((event) => event.kind === "hosted-gate"),
      );
      expect(events.some((event) => event.kind === "ci-watched")).toBe(false);
      expect(existsSync(join(f.local, "merge-output.log"))).toBe(false);
    },
  );

  it.each(["full", "remote_testbox", "remote_crabbox_aws"])(
    "retains the PR CI wait for %s preparation",
    (mode) => {
      f.configure({ hostedCi: "scheduled" });
      writeFileSync(
        join(f.local, "gates.env"),
        preparedGates.replace("hosted_exact_or_recent_parent", mode),
      );
      const before = f.events().length;
      const result = f.shell("merge_verify 42 || exit 1");
      expect(result.status, result.stdout + result.stderr).toBe(0);
      const events = f.events().slice(before);
      const watched = events.findIndex((event) => event.kind === "ci-watched");
      expect(watched).toBeGreaterThanOrEqual(0);
      expect(events.findIndex((event) => event.kind === "required-checks")).toBeGreaterThan(
        watched,
      );
      expect(events.some((event) => event.kind === "hosted-gate")).toBe(false);
    },
  );

  it("dispatches once with the exact prepared head and ordinary server enforcement", () => {
    const result = f.run("merge-run");
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const mergeCalls = f
      .events()
      .filter(
        (event) => event.kind === "gh" && event.args?.[0] === "pr" && event.args[1] === "merge",
      );
    expect(mergeCalls).toHaveLength(1);
    expect(mergeCalls[0]?.args).toEqual([
      "pr",
      "merge",
      "42",
      "--repo",
      "https://github.com/fixture/repo",
      "--squash",
      "--match-head-commit",
      f.head,
    ]);
    expect(
      JSON.parse(f.git(f.canonical, "show", "refs/openclaw/pr-merge-outcomes/42:outcome.json")),
    ).toMatchObject({ head: f.head, route: "immediate", phase: "complete" });
  });
});
