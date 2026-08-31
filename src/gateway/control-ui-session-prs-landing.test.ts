import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveBranchLanding } from "./control-ui-session-prs-landing.js";

const execFileAsync = promisify(execFile);

describe("resolveBranchLanding", () => {
  let root: string;

  const git = (...args: string[]) =>
    execFileAsync("git", ["-c", "user.email=test@openclaw.ai", "-c", "user.name=Test", ...args], {
      cwd: root,
    });
  const sha = async (ref: string) => (await git("rev-parse", ref)).stdout.trim();

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-prs-landing-")));
    await git("init", "--initial-branch=main", ".");
    await fs.writeFile(path.join(root, "a.txt"), "one\n");
    await git("add", "a.txt");
    await git("commit", "-m", "base");
    await git("update-ref", "refs/remotes/origin/main", "HEAD");
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("marks a squash-landed tip and bases stats on the merged head", async () => {
    await git("checkout", "-b", "feature");
    await fs.appendFile(path.join(root, "a.txt"), "two\n");
    await git("add", "a.txt");
    await git("commit", "-m", "feature work");
    await git("update-ref", "refs/remotes/origin/feature", "HEAD");
    const mergedHead = await sha("HEAD");

    const landing = await resolveBranchLanding(root, {
      branch: "feature",
      defaultBranch: "main",
      mergedHeads: [{ sha: mergedHead, baseRef: "main" }],
    });

    expect(landing).toEqual({
      pushedSha: mergedHead,
      statsBase: mergedHead,
      hasLandedPullRequest: true,
      provenNewPushedWork: false,
    });
  });

  it("proves new pushed work once the merge base contains the landing", async () => {
    await git("checkout", "-b", "feature");
    await fs.appendFile(path.join(root, "a.txt"), "two\n");
    await git("add", "a.txt");
    await git("commit", "-m", "feature work");
    const mergedHead = await sha("HEAD");
    await git("checkout", "main");
    await fs.appendFile(path.join(root, "a.txt"), "two\n");
    await git("add", "a.txt");
    await git("commit", "-m", "squash land");
    const mergeCommit = await sha("HEAD");
    await git("update-ref", "refs/remotes/origin/main", "HEAD");
    await git("checkout", "feature");
    await git("reset", "--hard", "refs/remotes/origin/main");
    await fs.writeFile(path.join(root, "b.txt"), "second\n");
    await git("add", "b.txt");
    await git("commit", "-m", "second PR work");
    await git("update-ref", "refs/remotes/origin/feature", "HEAD");

    const landing = await resolveBranchLanding(root, {
      branch: "feature",
      defaultBranch: "main",
      mergedHeads: [{ sha: mergedHead, baseRef: "main", mergeCommitSha: mergeCommit }],
    });

    expect(landing.provenNewPushedWork).toBe(true);
    // The rebase incorporated the landing, so the merge base is the baseline.
    expect(landing.statsBase).toBe(mergeCommit);
  });

  it("selects the newest of three related baselines via the batched path", async () => {
    // Linear chain: fork point (merge base) -> merged head 1 -> merged head 2
    // -> HEAD; the maximal published baseline is merged head 2.
    await git("checkout", "-b", "feature");
    await fs.appendFile(path.join(root, "a.txt"), "two\n");
    await git("add", "a.txt");
    await git("commit", "-m", "pr1 work");
    const head1 = await sha("HEAD");
    await fs.appendFile(path.join(root, "a.txt"), "three\n");
    await git("add", "a.txt");
    await git("commit", "-m", "pr2 work");
    const head2 = await sha("HEAD");
    await fs.writeFile(path.join(root, "c.txt"), "wip\n");
    await git("add", "c.txt");
    await git("commit", "-m", "follow-up");
    await git("update-ref", "refs/remotes/origin/feature", "HEAD");

    const landing = await resolveBranchLanding(root, {
      branch: "feature",
      defaultBranch: "main",
      mergedHeads: [
        { sha: head1, baseRef: "main" },
        { sha: head2, baseRef: "main" },
      ],
    });

    expect(landing.statsBase).toBe(head2);
    expect(landing.hasLandedPullRequest).toBe(true);
  });
});
