import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalMainCommitMatches,
  canonicalPullRequests,
  collectReleaseProvenanceOverrides,
  contaminatingPullRequestReferences,
  contributionRecordTarget,
  countTopLevelSectionBullets,
  createGithubSnapshotState,
  cumulativeShippedPullRequests,
  defaultGithubSnapshotPath,
  githubApiWithSnapshot,
  highlightCountError,
  isEligibleHandle,
  ledgerChecks,
  parseArgs,
  persistGithubSnapshot,
  pullRequestTitleFromCommitSubject,
  releaseNoteReferences,
  releasePullRequestReferencesToSuppress,
  releaseProvenanceMarkers,
  recoverUnavailablePullRequests,
  renderedContributionRecordReferences,
  resolvedReleasePullRequests,
  standardRevertedHash,
  subtractShippedPullRequests,
  validateReleaseProvenanceOverrides,
  withoutExcludedContributionRecords,
} from "../../.agents/skills/openclaw-changelog-update/scripts/verify-release-notes.mjs";

const verifier = resolve(
  ".agents/skills/openclaw-changelog-update/scripts/verify-release-notes.mjs",
);

function git(cwd: string, args: string[], extraEnv: Record<string, string> = {}): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "OpenClaw Test",
      GIT_AUTHOR_EMAIL: "test@openclaw.invalid",
      GIT_COMMITTER_NAME: "OpenClaw Test",
      GIT_COMMITTER_EMAIL: "test@openclaw.invalid",
      ...extraEnv,
    },
  }).trim();
}

describe("release-note verification", () => {
  it("excludes maintainer and automation identities from contributor credit", () => {
    expect(isEligibleHandle("human-contributor")).toBe(true);
    expect(isEligibleHandle("steipete")).toBe(false);
    expect(isEligibleHandle("steipete-oai")).toBe(false);
    expect(isEligibleHandle("hugin-bot")).toBe(false);
    expect(isEligibleHandle("roboclaw-bot")).toBe(false);
  });

  it("accepts only canonical commit PR suffixes", () => {
    const repeated = "Fix status (#102147) (#102147)";
    const distinct = "Fix status (#120582) (#120584)";
    expect(pullRequestTitleFromCommitSubject("Fix status (#102147)", 102147)).toBe("Fix status");
    expect(pullRequestTitleFromCommitSubject(repeated, 102147)).toBeUndefined();
    expect(pullRequestTitleFromCommitSubject(distinct, 120584)).toBeUndefined();
    expect(pullRequestTitleFromCommitSubject("Fix status(#102147)", 102147)).toBeUndefined();
    expect(pullRequestTitleFromCommitSubject("Fix status (#0102147)", 102147)).toBeUndefined();
    expect(pullRequestTitleFromCommitSubject(" Fix status (#102147)", 102147)).toBeUndefined();
    expect(pullRequestTitleFromCommitSubject("Fix status (#102147) ", 102147)).toBeUndefined();
    expect(pullRequestTitleFromCommitSubject("Fix status (#102148)", 102147)).toBeUndefined();
  });

  it("reads the exact target from a generated contribution record", () => {
    const target = "a".repeat(40);
    expect(
      contributionRecordTarget({
        source: [
          "## 2026.7.2",
          "",
          "### Complete contribution record",
          "",
          `This audited record covers the complete base..${target} history: 1 in-range PR + 0 retained seed-only PRs = 1 unique PR.`,
          "",
          "#### Pull requests",
          "",
          "- **PR #123** fix: example.",
        ].join("\n"),
      }),
    ).toBe(target);
  });

  it("recovers a vanished PR only from an exact covered commit and prior record", () => {
    const number = 102147;
    const commit = {
      authorHandle: undefined,
      closingReferences: [102146],
      coauthors: [],
      committedAt: "2026-07-01T12:00:00Z",
      hash: "a".repeat(40),
      pullRequests: [],
      references: [number],
      subject: `Fix silent maintenance delivery status (#${number})`,
    };
    const source = {
      activeCommits: [commit],
      coauthorsByReference: new Map<number, Set<string>>(),
      pullRequests: new Set<number>(),
      target: "c".repeat(40),
    };
    const nodes = new Map();
    const recovered = recoverUnavailablePullRequests({
      numbers: [number],
      nodes,
      record: {
        pullRequests: new Map([[number, { references: [], thanks: ["coolmanns"] }]]),
      },
      recordTarget: "b".repeat(40),
      source,
      isAncestor: () => true,
    });

    expect(recovered.get(number)).toMatchObject({
      __typename: "PullRequest",
      number,
      title: "Fix silent maintenance delivery status",
      mergedAt: commit.committedAt,
      mergeCommit: { oid: commit.hash },
      author: { __typename: "User", login: "coolmanns" },
    });
    expect(commit.pullRequests).toEqual([number]);
    expect(source.pullRequests).toEqual(new Set([number]));
    expect(source.coauthorsByReference.get(number)).toEqual(new Set(["coolmanns"]));
  });

  it("does not recover an unavailable reference without an exact PR title suffix", () => {
    const number = 102147;
    const source = {
      activeCommits: [
        {
          committedAt: "2026-07-01T12:00:00Z",
          hash: "a".repeat(40),
          pullRequests: [],
          references: [number],
          subject: `Fix status; refs #${number}`,
        },
      ],
      coauthorsByReference: new Map<number, Set<string>>(),
      pullRequests: new Set<number>(),
      target: "c".repeat(40),
    };

    expect(
      recoverUnavailablePullRequests({
        numbers: [number],
        nodes: new Map(),
        record: {
          pullRequests: new Map([[number, { references: [], thanks: ["coolmanns"] }]]),
        },
        recordTarget: "b".repeat(40),
        source,
        isAncestor: () => true,
      }),
    ).toEqual(new Map());
  });

  it("does not recover an unavailable PR with multiple active canonical commits", () => {
    const number = 102147;
    const coveredHash = "a".repeat(40);
    const laterHash = "d".repeat(40);
    const source = {
      activeCommits: [
        {
          committedAt: "2026-07-01T12:00:00Z",
          hash: coveredHash,
          pullRequests: [],
          references: [number],
          subject: `Fix status (#${number})`,
        },
        {
          committedAt: "2026-07-02T12:00:00Z",
          hash: laterHash,
          pullRequests: [],
          references: [number],
          subject: `Fix status again (#${number})`,
        },
      ],
      coauthorsByReference: new Map<number, Set<string>>(),
      pullRequests: new Set<number>(),
      target: "c".repeat(40),
    };

    expect(
      recoverUnavailablePullRequests({
        numbers: [number],
        nodes: new Map(),
        record: {
          pullRequests: new Map([[number, { references: [], thanks: ["coolmanns"] }]]),
        },
        recordTarget: "b".repeat(40),
        source,
        isAncestor: (left: string, right: string) =>
          (left === "b".repeat(40) && right === source.target) ||
          (left === coveredHash && right === "b".repeat(40)),
      }),
    ).toEqual(new Map());
  });

  it("stores default GitHub snapshots in the shared Git common directory", () => {
    const commonDir = resolve("/tmp/openclaw-shared-git");
    expect(defaultGithubSnapshotPath("a".repeat(40), "b".repeat(40), commonDir)).toBe(
      join(
        commonDir,
        "openclaw-release-cache",
        `verify-release-notes-${"a".repeat(40)}-${"b".repeat(40)}.json`,
      ),
    );
  });

  it("accepts only exact release provenance markers for active commits", () => {
    const releaseCommit = "a".repeat(40);
    const markerCommit = "b".repeat(40);
    const body = [
      `Release provenance: ${releaseCommit} -> #104905, #102980, #104956`,
      `Release provenance for ${"c".repeat(40)} -> #123`,
    ].join("\n");

    expect(releaseProvenanceMarkers(body)).toEqual([
      {
        commit: releaseCommit,
        pullRequests: [104905, 102980, 104956],
      },
    ]);
    expect(
      collectReleaseProvenanceOverrides([
        { body: "", hash: releaseCommit },
        { body, hash: markerCommit },
      ]),
    ).toEqual(new Map([[releaseCommit, [104905, 102980, 104956]]]));
    expect(resolvedReleasePullRequests([104939], [], false, [104905, 102980, 104956])).toEqual([
      104905, 102980, 104956,
    ]);
    expect(
      releasePullRequestReferencesToSuppress(
        [],
        "test(live): harden GPT-5.6 nonce retries for July (#104939)",
        [104905, 102980, 104956],
        true,
      ),
    ).toEqual([104939]);
  });

  it("rejects malformed, out-of-range, or conflicting release provenance markers", () => {
    const releaseCommit = "a".repeat(40);
    const firstMarkerCommit = "b".repeat(40);
    const secondMarkerCommit = "c".repeat(40);

    expect(() => releaseProvenanceMarkers("Release provenance: short -> #123")).toThrow(
      "invalid release provenance marker",
    );
    expect(() =>
      collectReleaseProvenanceOverrides([
        {
          body: `Release provenance: ${"d".repeat(40)} -> #104905`,
          hash: firstMarkerCommit,
        },
      ]),
    ).toThrow("release provenance marker targets commit outside the active range");
    expect(() =>
      collectReleaseProvenanceOverrides([
        { body: "", hash: releaseCommit },
        {
          body: `Release provenance: ${releaseCommit} -> #104905`,
          hash: firstMarkerCommit,
        },
        {
          body: `Release provenance: ${releaseCommit} -> #104956`,
          hash: secondMarkerCommit,
        },
      ]),
    ).toThrow(`conflicting release provenance markers for ${releaseCommit}`);
  });

  it("accepts repeatable CLI provenance without metadata commits", () => {
    const mappings: Array<[string, number]> = [
      ["bdde3d1c6dd7cc415588a72cf27ebe27f83bfe47", 120085],
      ["5090cae6d0cc3f2ec272b2448970c6238f525610", 120479],
      ["8ff1724067c1dcfb9a63574e6f3771261033ffae", 120479],
      ["0cd3075adf7cd201e17d25c95cbe190991f8aab1", 120538],
    ];
    const payloads = mappings.map(([commit, pullRequest]) => `${commit} -> #${pullRequest}`);
    const options = parseArgs([
      "--base",
      "base",
      "--target",
      "target",
      "--version",
      "2026.8.1",
      ...payloads.flatMap((payload) => ["--release-provenance", payload]),
    ]);

    expect(options.releaseProvenance).toEqual(payloads);
    expect(
      collectReleaseProvenanceOverrides(
        mappings.map(([hash]) => ({ body: "", hash })),
        options.releaseProvenance,
      ),
    ).toEqual(new Map(mappings.map(([commit, pullRequest]) => [commit, [pullRequest]])));
  });

  it("validates CLI provenance through the exact marker merge path", () => {
    const activeCommit = "a".repeat(40);

    expect(() =>
      collectReleaseProvenanceOverrides([{ body: "", hash: activeCommit }], ["short -> #1"]),
    ).toThrow("invalid release provenance marker");
    expect(() =>
      collectReleaseProvenanceOverrides(
        [{ body: "", hash: activeCommit }],
        [`${activeCommit} -> #1 trailing`],
      ),
    ).toThrow("invalid release provenance marker");
    expect(() =>
      collectReleaseProvenanceOverrides(
        [{ body: "", hash: activeCommit }],
        [`${activeCommit} -> #1\nRelease provenance: ${activeCommit} -> #2`],
      ),
    ).toThrow("invalid release provenance marker");
    for (const payload of [
      `${activeCommit} -> #1\n`,
      `${activeCommit} -> #1,\n#2`,
      `${activeCommit} -> #1\r\n`,
    ]) {
      expect(() =>
        collectReleaseProvenanceOverrides([{ body: "", hash: activeCommit }], [payload]),
      ).toThrow("invalid release provenance marker");
    }
    expect(() =>
      collectReleaseProvenanceOverrides(
        [{ body: "", hash: activeCommit }],
        [`${"b".repeat(40)} -> #1`],
      ),
    ).toThrow("release provenance marker targets commit outside the active range");
    expect(() =>
      collectReleaseProvenanceOverrides(
        [{ body: `Release provenance: ${activeCommit} -> #1`, hash: activeCommit }],
        [`${activeCommit} -> #2`],
      ),
    ).toThrow(`conflicting release provenance markers for ${activeCommit}`);
  });

  it("requires release provenance PRs to be merged into current main", () => {
    const releaseCommit = "a".repeat(40);
    const mainCommit = "b".repeat(40);
    const mergeCommit = "c".repeat(40);
    const overrides = new Map([[releaseCommit, [104905]]]);
    const validNode = {
      __typename: "PullRequest",
      baseRefName: "main",
      mergeCommit: { oid: mergeCommit },
      mergedAt: "2026-07-12T00:00:00Z",
    };

    expect(() =>
      validateReleaseProvenanceOverrides(
        overrides,
        new Map([[104905, validNode]]),
        mainCommit,
        () => true,
      ),
    ).not.toThrow();
    for (const node of [
      { ...validNode, baseRefName: "release/2026.7.1" },
      { ...validNode, mergedAt: null },
    ]) {
      expect(() =>
        validateReleaseProvenanceOverrides(
          overrides,
          new Map([[104905, node]]),
          mainCommit,
          () => true,
        ),
      ).toThrow("references non-main PR #104905");
    }
    expect(() =>
      validateReleaseProvenanceOverrides(
        overrides,
        new Map([[104905, validNode]]),
        mainCommit,
        () => false,
      ),
    ).toThrow("references non-main PR #104905");
  });

  it("uses the original main PR for explicit and uniquely matched backports", () => {
    const mainCommit = {
      authorEmail: "maintainer@example.com",
      authorName: "Maintainer",
      changedPaths: new Set(["src/channel.ts"]),
      hash: "a".repeat(40),
      pullRequests: [123],
      subject: "fix(channel): preserve durable replies",
    };
    const explicitBackport = {
      authorEmail: "other@example.com",
      authorName: "Other",
      body: `(cherry picked from commit ${mainCommit.hash})`,
      changedPaths: new Set(["src/channel.ts"]),
      hash: "b".repeat(40),
      subject: "fix(channel): preserve durable replies",
    };
    const integratedBackport = {
      authorEmail: mainCommit.authorEmail,
      authorName: mainCommit.authorName,
      body: "",
      changedPaths: new Set(["src/channel.ts", "src/release.ts"]),
      hash: "c".repeat(40),
      subject: "fix(channel): preserve durable replies",
    };
    const pullRequestBackport = {
      authorEmail: mainCommit.authorEmail,
      authorName: mainCommit.authorName,
      body: "Backport of #123 to release/2026.7.1.",
      changedPaths: new Set(["src/channel.ts"]),
      hash: "d".repeat(40),
      subject: "fix(channel): keep replies after renewal",
    };

    expect(canonicalMainCommitMatches(explicitBackport, [mainCommit])).toEqual([mainCommit.hash]);
    expect(canonicalMainCommitMatches(integratedBackport, [mainCommit])).toEqual([mainCommit.hash]);
    expect(canonicalMainCommitMatches(pullRequestBackport, [mainCommit])).toEqual([
      mainCommit.hash,
    ]);
    expect(
      canonicalMainCommitMatches(pullRequestBackport, [
        {
          ...mainCommit,
          pullRequests: [],
          body: "Original main PR #123.",
          subject: "fix(channel): preserve durable replies",
        },
      ]),
    ).toEqual([]);
    expect(
      canonicalMainCommitMatches(pullRequestBackport, [
        {
          ...mainCommit,
          pullRequests: [999],
          subject: "fix(channel): keep replies after renewal",
        },
      ]),
    ).toEqual([]);
    expect(
      canonicalMainCommitMatches(
        { ...pullRequestBackport, authorEmail: "other@example.com", authorName: "Other" },
        [mainCommit],
      ),
    ).toEqual([]);
    expect(
      canonicalMainCommitMatches(
        { ...pullRequestBackport, changedPaths: new Set(["src/other.ts"]) },
        [mainCommit],
      ),
    ).toEqual([]);
    expect(
      canonicalMainCommitMatches({ ...pullRequestBackport, body: "Related #123." }, [mainCommit]),
    ).toEqual([]);
    expect(
      canonicalMainCommitMatches(pullRequestBackport, [
        mainCommit,
        { ...mainCommit, hash: "e".repeat(40), pullRequests: [123] },
      ]),
    ).toEqual([]);
    expect(
      canonicalMainCommitMatches(pullRequestBackport, [
        mainCommit,
        {
          ...mainCommit,
          body: "Original main PR #123.",
          hash: "f".repeat(40),
          pullRequests: [],
        },
      ]),
    ).toEqual([mainCommit.hash]);
    const backportSubject = "fix(gateway): retain work admission across hosted wizard steps";
    mainCommit.subject = `${backportSubject} (#120582)`;
    integratedBackport.subject = `${mainCommit.subject} (#120584)`;
    expect(canonicalMainCommitMatches(integratedBackport, [mainCommit])).toEqual([mainCommit.hash]);
    const malformed = { ...integratedBackport, subject: `${backportSubject}(#120582) (#120584)` };
    expect(canonicalMainCommitMatches(malformed, [mainCommit])).toEqual([]);
    expect(canonicalPullRequests([456], [123])).toEqual([123]);
  });

  it("keeps the release PR without an unambiguous main forward-port", () => {
    const releaseCommit = {
      authorEmail: "maintainer@example.com",
      authorName: "Maintainer",
      body: "",
      changedPaths: new Set(["src/channel.ts"]),
      hash: "c".repeat(40),
      subject: "fix(channel): preserve durable replies",
    };
    const ambiguousMainCommits = ["a", "b"].map((prefix) => ({
      authorEmail: releaseCommit.authorEmail,
      authorName: releaseCommit.authorName,
      changedPaths: new Set(["src/channel.ts"]),
      hash: prefix.repeat(40),
      subject: "fix(channel): preserve durable replies (#123)",
    }));

    expect(canonicalMainCommitMatches(releaseCommit, ambiguousMainCommits)).toEqual([]);
    expect(canonicalPullRequests([456], [])).toEqual([456]);
  });

  it("drops the release PR when the matching main forward-port is a direct commit", () => {
    expect(canonicalPullRequests([456], [], true)).toEqual([]);
  });

  it("reuses exact-range GitHub GraphQL snapshots without caching REST reads", () => {
    const cwd = mkdtempSync(join(tmpdir(), "openclaw-release-notes-snapshot-"));
    try {
      const filePath = join(cwd, "snapshot.json");
      let fetches = 0;
      const fetchApi = (args: string[]) => {
        fetches += 1;
        return { data: { request: args, fetches } };
      };
      const first = createGithubSnapshotState({
        base: "a".repeat(40),
        filePath,
        target: "b".repeat(40),
      });

      expect(githubApiWithSnapshot(["graphql", "-f", "query=one"], fetchApi, first)).toEqual({
        data: {
          request: ["graphql", "-f", "query=one"],
          fetches: 1,
        },
      });
      expect(
        githubApiWithSnapshot(["repos/openclaw/openclaw/releases/tags/v1"], fetchApi, first),
      ).toEqual({
        data: {
          request: ["repos/openclaw/openclaw/releases/tags/v1"],
          fetches: 2,
        },
      });
      persistGithubSnapshot(first);

      const second = createGithubSnapshotState({
        base: "a".repeat(40),
        filePath,
        target: "b".repeat(40),
      });
      expect(githubApiWithSnapshot(["graphql", "-f", "query=one"], fetchApi, second)).toEqual({
        data: {
          request: ["graphql", "-f", "query=one"],
          fetches: 1,
        },
      });
      expect(second.hits).toBe(1);
      expect(second.misses).toBe(0);
      expect(fetches).toBe(2);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("checkpoints successful GraphQL responses during long verification runs", () => {
    const cwd = mkdtempSync(join(tmpdir(), "openclaw-release-notes-snapshot-"));
    try {
      const filePath = join(cwd, "snapshot.json");
      const state = createGithubSnapshotState({
        base: "a".repeat(40),
        checkpointEvery: 2,
        filePath,
        target: "b".repeat(40),
      });
      const fetchApi = (args: string[]) => ({ data: { request: args } });

      githubApiWithSnapshot(["graphql", "-f", "query=one"], fetchApi, state);
      expect(state.dirty).toBe(true);
      expect(state.writesSincePersist).toBe(1);
      githubApiWithSnapshot(["graphql", "-f", "query=two"], fetchApi, state);

      expect(state.dirty).toBe(false);
      expect(state.writesSincePersist).toBe(0);
      expect(JSON.parse(readFileSync(filePath, "utf8")).responses).toHaveProperty(
        JSON.stringify(["graphql", "-f", "query=two"]),
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("does not cache transient GraphQL errors", () => {
    const cwd = mkdtempSync(join(tmpdir(), "openclaw-release-notes-snapshot-"));
    try {
      const filePath = join(cwd, "snapshot.json");
      const state = createGithubSnapshotState({
        base: "a".repeat(40),
        filePath,
        target: "b".repeat(40),
      });
      let fetches = 0;
      const fetchApi = () => {
        fetches += 1;
        return fetches === 1
          ? { errors: [{ message: "rate limited" }] }
          : { data: { repository: { id: "repository-id" } } };
      };
      const args = ["graphql", "-f", "query=one"];

      expect(githubApiWithSnapshot(args, fetchApi, state)).toEqual({
        errors: [{ message: "rate limited" }],
      });
      expect(state.dirty).toBe(false);
      expect(state.responses).toEqual({});
      expect(githubApiWithSnapshot(args, fetchApi, state)).toEqual({
        data: { repository: { id: "repository-id" } },
      });
      expect(state.misses).toBe(2);
      expect(fetches).toBe(2);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects a snapshot bound to a different release target", () => {
    const cwd = mkdtempSync(join(tmpdir(), "openclaw-release-notes-snapshot-"));
    try {
      const filePath = join(cwd, "snapshot.json");
      const state = createGithubSnapshotState({
        base: "a".repeat(40),
        filePath,
        target: "b".repeat(40),
      });
      githubApiWithSnapshot(["graphql", "-f", "query=one"], () => ({ data: true }), state);
      persistGithubSnapshot(state);

      expect(() =>
        createGithubSnapshotState({
          base: "a".repeat(40),
          filePath,
          target: "c".repeat(40),
        }),
      ).toThrow("use --refresh-github-snapshot");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("ignores nested revert markers in squash-merge bodies", () => {
    const nestedRevert = [
      "feat(android): render display math (#101435)",
      "",
      "* feat(android): render display math",
      "",
      ' * Revert "docs(changelog): note display math"',
      "",
      `This reverts commit ${"a".repeat(40)}.`,
    ].join("\n");
    const topLevelRevert = [
      'Revert "fix(qa): keep smoke profile on one channel (#101173)" (#101184)',
      "",
      `This reverts commit ${"b".repeat(40)}.`,
    ].join("\n");
    const squashRevert = [
      "Revert chat session picker inline search (#85527)",
      "",
      '* Revert "fix(ui): keep chat session search inline (#85490)"',
      "",
      `This reverts commit ${"c".repeat(40)}.`,
      "",
      "* fix(ui): clear applied chat picker search on empty input",
    ].join("\n");
    const conventionalSquashRevert = [
      "chore: revert dependency guard backfill machinery (#87867)",
      "",
      '* Revert "ci: isolate dependency guard backfill label (#87882)"',
      "",
      `This reverts commit ${"d".repeat(40)}.`,
      "",
      "* ci: preserve clawsweeper bot label filter",
    ].join("\n");
    const explainedTopLevelRevert = [
      "revert: restore a provider default",
      "",
      "The replacement broke non-native endpoints.",
      "",
      `This reverts commit ${"e".repeat(40)}.`,
    ].join("\n");

    expect(standardRevertedHash(nestedRevert)).toBeUndefined();
    expect(standardRevertedHash(topLevelRevert)).toBe("b".repeat(40));
    expect(standardRevertedHash(squashRevert)).toBe("c".repeat(40));
    expect(standardRevertedHash(conventionalSquashRevert)).toBe("d".repeat(40));
    expect(standardRevertedHash(explainedTopLevelRevert)).toBe("e".repeat(40));
  });

  it("counts only top-level Highlights bullets and enforces the 5-8 policy input", () => {
    const highlights = [
      "### Highlights",
      "",
      "- One",
      "  - nested detail",
      "- Two",
      "- Three",
      "- Four",
      "- Five",
      "",
      "### Changes",
      "",
      "- Not a highlight",
    ].join("\n");
    const overLimit = highlights.replace("- Five", "- Five\n- Six\n- Seven\n- Eight\n- Nine");

    expect(countTopLevelSectionBullets(highlights, "Highlights")).toBe(5);
    expect(countTopLevelSectionBullets(overLimit, "Highlights")).toBe(9);
    expect(highlightCountError(highlights)).toBeUndefined();
    expect(highlightCountError(overLimit)).toBe(
      "### Highlights must contain 5-8 top-level bullets; found 9",
    );
  });

  it("rejects prior-release PRs from prose or the existing record unless explicitly seeded", () => {
    const nodes = new Map([
      [97118, { __typename: "PullRequest" }],
      [102000, { __typename: "PullRequest" }],
      [98565, { __typename: "Issue" }],
    ]);
    const params = {
      noteReferences: [97118, 98565],
      recordedReferences: [97118, 102000],
      sourcePullRequests: new Set([102000]),
      sourceReferences: [102000, 98565],
      seededPullRequests: new Set<number>(),
      nodes,
    };

    expect(contaminatingPullRequestReferences(params)).toEqual([97118]);
    expect(
      contaminatingPullRequestReferences({
        ...params,
        seededPullRequests: new Set([97118]),
      }),
    ).toEqual([]);
  });

  it("allows shipped PR references only in generated record metadata", () => {
    const nodes = new Map([
      [97118, { __typename: "PullRequest" }],
      [102000, { __typename: "PullRequest" }],
    ]);
    const params = {
      noteReferences: [],
      recordedReferences: [97118, 102000],
      excludedRecordedReferences: new Set([97118]),
      sourcePullRequests: new Set([102000]),
      sourceReferences: [102000],
      seededPullRequests: new Set<number>(),
      nodes,
    };

    expect(contaminatingPullRequestReferences(params)).toEqual([]);
    expect(
      contaminatingPullRequestReferences({
        ...params,
        noteReferences: [97118],
      }),
    ).toEqual([97118]);
  });

  it("ignores the stale generated record while rewriting it", () => {
    const record = {
      pullRequests: new Map([[104732, { references: [102289], thanks: ["fuller-stack-dev"] }]]),
      legacyIssues: new Map(),
    };

    expect(renderedContributionRecordReferences(record, true)).toEqual([]);
    expect(renderedContributionRecordReferences(record, false)).toEqual([104732, 102289]);
  });

  it("excludes Unreleased records from a cumulative shipped tag boundary", () => {
    const changelog = [
      "# Changelog",
      "",
      "## Unreleased",
      "",
      "### Complete contribution record",
      "",
      `This audited record covers the complete base..${"a".repeat(40)} history: 1 merged PR.`,
      "",
      "#### Pull requests",
      "",
      "- **PR #1** fix: not shipped.",
      "",
      "## 2026.6.11",
      "",
      "### Complete contribution record",
      "",
      "This audited record covers the complete base..HEAD history: 0 merged PRs.",
      "",
      "#### Pull requests",
      "",
      "- **PR #2** fix: shipped.",
    ].join("\n");

    expect([...cumulativeShippedPullRequests(changelog, "test baseline")]).toEqual([2]);
  });

  it("subtracts cumulative shipped PRs deterministically from the source inventory", () => {
    const source = {
      pullRequests: new Set([1, 2, 3]),
      references: [1, 2, 4],
    };

    const result = subtractShippedPullRequests(source, [
      { ref: "v2026.6.11", pullRequests: new Set([1, 2]) },
      { ref: "v2026.6.10", pullRequests: new Set([2, 4]) },
    ]);

    expect([...source.pullRequests]).toEqual([3]);
    expect(source.references).toEqual([]);
    expect(result.baselines).toEqual([
      { ref: "v2026.6.10", count: 2, pullRequests: [2, 4] },
      { ref: "v2026.6.11", count: 1, pullRequests: [1] },
    ]);
    expect([...result.pullRequests].toSorted((a, b) => a - b)).toEqual([1, 2, 4]);
  });

  it("removes rewrite-excluded references from an existing contribution record", () => {
    const record = {
      pullRequests: new Map([
        [1, { references: [2, 10], thanks: [] }],
        [2, { references: [11], thanks: [] }],
      ]),
      legacyIssues: new Map([
        [10, { references: [], thanks: [] }],
        [11, { references: [], thanks: [] }],
      ]),
    };

    const filtered = withoutExcludedContributionRecords(record, new Set([2, 10]));

    expect([...filtered.pullRequests]).toEqual([
      [1, { externalReferences: [], references: [], thanks: [] }],
    ]);
    expect([...filtered.legacyIssues]).toEqual([
      [11, { externalReferences: [], references: [], thanks: [] }],
    ]);
  });

  it("does not treat the shipped baseline inventory as current release-note references", () => {
    const baselines = [{ ref: "v2026.6.11", count: 2, pullRequests: [1, 2] }];
    const section = [
      "## 2026.7.1",
      "",
      "- Fixes #1 in the current range.",
      "",
      "### Complete contribution record",
      "",
      "Shipped baseline exclusions: v2026.6.11 (2 PRs: #1, #2).",
      "",
      "- **PR #3** fix: current work.",
    ].join("\n");

    expect(releaseNoteReferences(section, baselines)).toEqual([1, 3]);
  });

  it.each([
    {
      name: "CSS palette comparisons in a commit message",
      source: [
        "fix(control-ui): darken the Absolutely surface ramp (#130239)",
        "",
        "--bg #262624 sat above Dash #1a1210, Claw #0e1015, and Knot #080808.",
        "Steps the ramp down (--bg #262624 -> #1c1c1a).",
      ].join("\n"),
      expected: [130239],
    },
    {
      name: "issue refs after CSS colors on the same line",
      source: "--bg #262624 (fixes #123), refs #1234, #123456, and #12345678.",
      expected: [123, 1234, 123456, 12345678],
    },
    {
      name: "short and alpha CSS values and numeric color transitions",
      source:
        "--fg: #123; --border:#1234; --bg #123456 -> #654321; --alpha: #12345678 → #87654321. (#456)",
      expected: [456],
    },
    {
      name: "qualified references beside CSS values",
      source: "OpenClaw/OpenClaw#123 --bg #262624; openclaw/openclaw#456 and Other/Repo#123456.",
      expected: [123, 456],
    },
    {
      name: "ordinary Markdown and code references",
      source:
        "**PR #123**; `#456`; [#789](https://github.com/openclaw/openclaw/issues/789)\n```text\n#123456\n```\n`--bg: #262624` (#1234)",
      expected: [123, 456, 789, 123456, 1234],
    },
    {
      name: "complete numeric reference tokens",
      source:
        "#1a1210 #0e1015 #080808 #fff #123abc #456_def &#123; file#456; #123 #1234 #123456 #12345678",
      expected: [123, 1234, 123456, 12345678],
    },
    {
      name: "non-color custom-property prose and cross-line references",
      source: "--bg fixes #123; --border relates to #456.\n--bg\n#789",
      expected: [123, 456, 789],
    },
  ])("extracts release references from $name", ({ source, expected }) => {
    expect(releaseNoteReferences(source, [])).toEqual(expected);
  });

  it.each([
    { reference: "", expected: [] },
    {
      reference: " (fixes #262624)",
      expected: [
        "editorial release prose references non-editorial chore PR #262624 (chore)",
        "missing editorial Thanks @alice for PR #262624",
      ],
    },
  ])("validates editorial credit after a CSS color: '$reference'", ({ reference, expected }) => {
    const source = [
      "## 2026.8.1",
      "### Highlights",
      "- One.",
      "- Two.",
      "- Three.",
      "- Four.",
      "- Five.",
      "### Changes",
      "### Fixes",
      `- Set --bg #262624${reference}.`,
      "### Complete contribution record",
      `This audited record covers the complete base..${"a".repeat(40)} history: 1 merged PR.`,
      "#### Pull requests",
      "- **PR #262624** Thanks @alice.",
    ].join("\n");
    const entry = {
      number: 262624,
      title: "chore: unrelated tooling",
      type: "chore",
      editorialEligible: false,
      externalReferences: [],
      linkedIssues: [],
      thanks: ["alice"],
    };

    expect(
      ledgerChecks({ source }, [entry], new Map([[262624, { __typename: "PullRequest" }]]), []),
    ).toEqual(expected);
  });

  it.each([0, 1, 2])(
    "accounts for merged side ancestry with %i reversals without duplicating shipped PRs",
    (reversals) => {
      const cwd = mkdtempSync(join(tmpdir(), "openclaw-release-notes-ancestry-"));
      try {
        git(cwd, ["init", "-q", "-b", "main"]);
        const changelog = [
          "# Changelog",
          "",
          "## 2026.7.1",
          "",
          "### Highlights",
          "",
          "- One.",
          "- Two.",
          "- Three.",
          "- Four.",
          "- Five.",
          "",
          "### Changes",
          "",
          "### Fixes",
          "",
        ].join("\n");
        writeFileSync(join(cwd, "CHANGELOG.md"), changelog);
        const commit = (subject: string, file: string) => {
          writeFileSync(join(cwd, file), subject);
          git(cwd, ["add", file]);
          git(cwd, ["commit", "-qm", subject]);
          return git(cwd, ["rev-parse", "HEAD"]);
        };
        git(cwd, ["add", "CHANGELOG.md"]);
        const base = commit("chore: existing work (#9)", "base.txt");
        git(cwd, ["checkout", "-qb", "side"]);
        const first = commit("fix: side contribution", "first.txt");
        git(cwd, ["checkout", "-qb", "nested-side"]);
        const second = commit("fix: same contribution follow-up", "second.txt");
        git(cwd, ["checkout", "-q", "side"]);
        git(cwd, ["merge", "--no-ff", "-qm", "merge: nested side work", "nested-side"]);
        const nestedMerge = git(cwd, ["rev-parse", "HEAD"]);
        const withdrawn = commit("fix: withdrawable contribution", "withdrawn.txt");
        const shipped = commit("fix: separately shipped contribution", "shipped.txt");
        git(cwd, ["checkout", "-q", "main"]);
        commit("chore: main work", "main.txt");
        git(cwd, ["merge", "--no-ff", "-qm", "merge: side work", "side"]);
        let reversed = withdrawn;
        for (let index = 0; index < reversals; index += 1) {
          git(cwd, ["revert", "--no-edit", reversed]);
          reversed = git(cwd, ["rev-parse", "HEAD"]);
        }
        const target = git(cwd, ["rev-parse", "HEAD"]);

        // A divergent stable tag already contains PR #12; its side commit is in
        // this Git range, so subtraction must happen after complete discovery.
        git(cwd, ["checkout", "-qb", "shipped-release", base]);
        writeFileSync(
          join(cwd, "CHANGELOG.md"),
          [
            "## 2026.6.1",
            "",
            "### Complete contribution record",
            "",
            `This audited record covers the complete ${base}..${base} history: 1 in-range PR + 0 retained seed-only PRs = 1 unique PR.`,
            "",
            "#### Pull requests",
            "",
            "- **PR #12** Thanks @contributor.",
            "",
          ].join("\n"),
        );
        git(cwd, ["add", "CHANGELOG.md"]);
        git(cwd, ["commit", "-qm", "docs: shipped record"]);
        git(cwd, ["tag", "v2026.6.1"]);
        git(cwd, ["checkout", "-q", "main"]);

        // Exercise the real CLI and Git DAG. Only GitHub's external boundary is
        // replaced; associations have no PR suffix for the collector to guess.
        const associations = {
          [first]: 10,
          [second]: 10,
          [withdrawn]: 11,
          [shipped]: 12,
          [nestedMerge]: 13,
        };
        const gh = join(cwd, "gh");
        writeFileSync(
          gh,
          `#!${process.execPath}\n
const associations = ${JSON.stringify(associations)};
const query = process.argv.find((arg) => arg.startsWith("query="))?.slice(6) ?? "";
const data = {};
for (const [, alias, hash] of query.matchAll(/(c\\d+): repository[\\s\\S]*?object\\(expression: "([0-9a-f]+)"\\)/g)) {
  const number = associations[hash];
  data[alias] = { object: {
    associatedPullRequests: { nodes: number ? [{ number, mergedAt: "2026-01-01T00:00:00Z", mergeCommit: { oid: hash } }] : [], pageInfo: { hasNextPage: false, endCursor: null } },
    author: { user: { login: "steipete" } },
  } };
}
for (const [, alias, rawNumber] of query.matchAll(/(n\\d+): repository[\\s\\S]*?issueOrPullRequest\\(number: (\\d+)\\)/g)) {
  data[alias] = { issueOrPullRequest: { __typename: "PullRequest", number: Number(rawNumber), title: "fix: contribution", baseRefName: "main", mergedAt: "2026-01-01T00:00:00Z", author: { __typename: "User", login: "contributor" }, closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } };
}
console.log(JSON.stringify({ data }));
`,
        );
        chmodSync(gh, 0o755);
        const manifestPath = join(cwd, "manifest.json");
        const result = spawnSync(
          process.execPath,
          [
            verifier,
            "--base",
            base,
            "--target",
            target,
            "--main-ref",
            target,
            "--version",
            "2026.7.1",
            "--shipped-ref",
            "v2026.6.1",
            "--manifest",
            manifestPath,
            "--write-ledger",
            "--json",
          ],
          { cwd, encoding: "utf8", env: { ...process.env, PATH: `${cwd}:${process.env.PATH}` } },
        );
        expect(result.stderr).toBe("");
        expect(result.status, result.stdout).toBe(0);
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        expect(
          manifest.pullRequests.map((entry: { number: number }) => entry.number).toSorted(),
        ).toEqual(reversals === 1 ? [10, 13] : [10, 11, 13]);
        expect(manifest.pullRequests[0].thanks).toEqual(["contributor"]);
        expect(manifest.shippedBaselines).toEqual([
          { ref: "v2026.6.1", count: 1, pullRequests: [12] },
        ]);
        expect(
          readFileSync(join(cwd, "CHANGELOG.md"), "utf8").match(/\*\*PR #10\*\*/g),
        ).toHaveLength(1);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  );

  it.each([
<<<<<<< HEAD
    { mode: "recover", attempts: 2, error: undefined },
    { mode: "exhaust", attempts: 5, error: "unexpected EOF" },
    { mode: "auth", attempts: 1, error: "Bad credentials" },
    { mode: "missing-data", attempts: 1, error: "did not include data" },
    { mode: "schema", attempts: 1, error: "Field unknownField does not exist" },
  ])("handles GraphQL transport failure at the CLI boundary: $mode", (scenario) => {
    const cwd = mkdtempSync(join(tmpdir(), "openclaw-release-notes-transport-"));
    try {
      git(cwd, ["init", "-q", "-b", "main"]);
      const changelog = [
        "# Changelog",
        "",
        "## 2026.7.1",
        "",
        "### Highlights",
        "",
        "- One.",
        "- Two.",
        "- Three.",
        "- Four.",
        "- Five.",
        "",
        "### Changes",
        "",
        "### Fixes",
        "",
      ].join("\n");
      writeFileSync(join(cwd, "CHANGELOG.md"), changelog);
      git(cwd, ["add", "CHANGELOG.md"]);
      git(cwd, ["commit", "-qm", "chore: baseline"]);
      const base = git(cwd, ["rev-parse", "HEAD"]);
      git(cwd, ["commit", "--allow-empty", "-qm", "chore: source contribution"]);
=======
    { message: "Exact-head CI #41 passed.", accepted: true },
    { message: "CI run #41 passed.", accepted: true },
    { message: "Actions run #41 passed.", accepted: true },
    { message: "workflow run #41 passed.", accepted: true },
    { message: "CI #41 passed.", node: "Issue", accepted: true },
    { message: "CI #41 passed.", node: "PullRequest", accepted: true },
    { message: "Related #41.", accepted: false },
    { message: "CI #41 passed.", reverted: true, other: "Related #41.", accepted: false },
    { message: "CI #41 passed. Fixes #41.", accepted: false },
    { message: "CI openclaw/openclaw#41 passed.", accepted: false },
    { message: "CI #41 passed.", other: "Related #41.", accepted: false },
    { message: "CI #41 passed.", note: "Related #41.", accepted: false },
    { message: "CI #41 passed.", identity: "missing", accepted: false },
    { message: "CI #41 passed.", identity: "wrong-id", accepted: false },
    { message: "CI #41 passed.", identity: "wrong-repo", accepted: false },
  ])("classifies active workflow references without losing issue accounting: %j", (scenario) => {
    const cwd = mkdtempSync(join(tmpdir(), "openclaw-release-notes-runs-"));
    try {
      git(cwd, ["init", "-q", "-b", "main"]);
      writeFileSync(
        join(cwd, "CHANGELOG.md"),
        [
          "# Changelog",
          "",
          "## 2026.7.1",
          "",
          "### Highlights",
          "",
          "- One.",
          "- Two.",
          "- Three.",
          "- Four.",
          "- Five.",
          "",
          "### Changes",
          "",
          "### Fixes",
          "",
          scenario.note ?? "",
          "",
        ].join("\n"),
      );
      git(cwd, ["add", "CHANGELOG.md"]);
      git(cwd, ["commit", "-qm", "chore: base"]);
      const base = git(cwd, ["rev-parse", "HEAD"]);
      writeFileSync(join(cwd, "validation.txt"), scenario.message);
      git(cwd, ["add", "validation.txt"]);
      git(cwd, ["commit", "-qm", "chore: validation", "-m", scenario.message]);
      if (scenario.reverted) {
        git(cwd, ["revert", "--no-edit", "HEAD"]);
      }
      if (scenario.other) {
        git(cwd, ["commit", "--allow-empty", "-qm", "chore: follow-up", "-m", scenario.other]);
      }
>>>>>>> 40b9ef5cbe8 (fix(release): distinguish verified workflow run references)
      const target = git(cwd, ["rev-parse", "HEAD"]);
      const gh = join(cwd, "gh");
      writeFileSync(
        gh,
        `#!${process.execPath}\n
<<<<<<< HEAD
const fs = require("node:fs");
const mode = ${JSON.stringify(scenario.mode)};
const state = fs.existsSync("request-state.json") ? JSON.parse(fs.readFileSync("request-state.json", "utf8")) : { attempts: 0, settled: false };
if (!state.settled) {
  state.attempts += 1;
  fs.writeFileSync("request-state.json", JSON.stringify(state));
  if (mode === "exhaust" || (mode === "recover" && state.attempts === 1)) {
    process.stderr.write('Post "https://api.github.com/graphql": unexpected EOF\\n');
    process.exit(1);
  }
  if (mode === "auth") {
    console.log(JSON.stringify({ message: "Bad credentials", status: 401 }));
    process.stderr.write("gh: Bad credentials (HTTP 401)\\n");
    process.exit(1);
  }
  if (mode === "missing-data") {
    console.log(JSON.stringify({ unexpected: "shape" }));
    process.exit(0);
  }
  if (mode === "schema") {
    console.log(JSON.stringify({ errors: [{ type: "GRAPHQL_VALIDATION_FAILED", message: "Field unknownField does not exist on type Repository" }] }));
    process.exit(0);
  }
  state.settled = true;
  fs.writeFileSync("request-state.json", JSON.stringify(state));
=======
const scenario = ${JSON.stringify(scenario)};
if (process.argv[3] === "repos/openclaw/openclaw/actions/runs/41") {
  require("node:fs").appendFileSync("run-requests", "41\\n");
  console.log(JSON.stringify(scenario.identity === "missing" ? { message: "Not Found" } : {
    id: scenario.identity === "wrong-id" ? 42 : 41,
    repository: { full_name: scenario.identity === "wrong-repo" ? "other/repository" : "openclaw/openclaw" },
    pull_requests: [],
  }));
  process.exit(0);
>>>>>>> 40b9ef5cbe8 (fix(release): distinguish verified workflow run references)
}
const query = process.argv.find((arg) => arg.startsWith("query="))?.slice(6) ?? "";
const data = {};
for (const [, alias] of query.matchAll(/(c\\d+): repository/g)) {
<<<<<<< HEAD
  data[alias] = { object: { associatedPullRequests: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }, author: { user: { login: "steipete" } } } };
=======
  data[alias] = { object: { associatedPullRequests: { nodes: [], pageInfo: { hasNextPage: false } }, author: { user: { login: "steipete" } } } };
}
for (const [, alias] of query.matchAll(/(n\\d+): repository/g)) {
  data[alias] = { issueOrPullRequest: scenario.node ? {
    __typename: scenario.node, number: 41, title: "chore: validation", baseRefName: "main",
    mergedAt: "2026-01-01T00:00:00Z", mergeCommit: { oid: ${JSON.stringify(target)} }, author: { __typename: "User", login: "steipete" },
    closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false } },
    closedByPullRequestsReferences: { nodes: [], pageInfo: { hasNextPage: false } },
  } : null };
>>>>>>> 40b9ef5cbe8 (fix(release): distinguish verified workflow run references)
}
console.log(JSON.stringify({ data }));
`,
      );
      chmodSync(gh, 0o755);
      const manifestPath = join(cwd, "manifest.json");
      const result = spawnSync(
        process.execPath,
        [
          verifier,
          "--base",
          base,
          "--target",
          target,
          "--main-ref",
          target,
          "--version",
          "2026.7.1",
          "--manifest",
          manifestPath,
          "--write-ledger",
          "--json",
        ],
        { cwd, encoding: "utf8", env: { ...process.env, PATH: `${cwd}:${process.env.PATH}` } },
      );
<<<<<<< HEAD
      const requests = JSON.parse(readFileSync(join(cwd, "request-state.json"), "utf8"));
      expect(requests.attempts, result.stderr).toBe(scenario.attempts);
      if (scenario.error) {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(scenario.error);
        expect(readFileSync(join(cwd, "CHANGELOG.md"), "utf8")).toBe(changelog);
      } else {
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(readFileSync(manifestPath, "utf8")).source.directCommits).toBe(1);
        expect(readFileSync(join(cwd, "CHANGELOG.md"), "utf8")).toContain(
          "### Complete contribution record",
        );
=======
      if (!scenario.accepted) {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("GitHub could not resolve source references: #41");
        return;
      }
      expect(result.stderr).toBe("");
      expect(result.status, result.stdout).toBe(0);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      expect(manifest.source.references).toBe(scenario.node ? 1 : 0);
      expect(manifest.pullRequests.map((entry: { number: number }) => entry.number)).toEqual(
        scenario.node === "PullRequest" ? [41] : [],
      );
      if (!scenario.node) {
        expect(manifest.directCommits[0].references).toEqual([]);
        expect(manifest.workflowRuns).toEqual([{ id: 41, repository: "openclaw/openclaw" }]);
      } else {
        expect(() => readFileSync(join(cwd, "run-requests"))).toThrow();
>>>>>>> 40b9ef5cbe8 (fix(release): distinguish verified workflow run references)
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.each([
    "exact",
    "double-revert",
    "before-base",
    "before-base-double",
    "before-base-triple",
    "three-targets",
    "non-utf8",
    "overlapping",
    "extra-change",
    "partial",
    "unknown-target",
    "nonancestor",
    "merge-target",
    "abbreviated",
    "duplicate",
    "multiple-declarations",
    "prose",
    "non-revert-subject",
  ])("proves explicit multi-commit reversal accounting: %s", (mode) => {
    const cwd = mkdtempSync(join(tmpdir(), "openclaw-release-notes-multi-revert-"));
    try {
      git(cwd, ["init", "-q", "-b", "main"]);
      const prose = [
        "# Changelog",
        "",
        "## 2026.7.1",
        "",
        "### Highlights",
        "",
        "- One.",
        "- Two.",
        "- Three.",
        "- Four.",
        "- Five.",
        "",
        "### Changes",
        "",
        "### Fixes",
        "",
      ].join("\n");
      writeFileSync(join(cwd, "CHANGELOG.md"), prose);
      writeFileSync(join(cwd, "alpha.txt"), "original\n");
      writeFileSync(join(cwd, "beta.bin"), Buffer.from([0, 255, 1]));
      const commit = (subject: string) => {
        git(cwd, ["add", "."]);
        git(cwd, ["commit", "-qm", subject]);
        return git(cwd, ["rev-parse", "HEAD"]);
      };
      const originalBase = commit("chore: baseline");
      writeFileSync(
        join(cwd, "alpha.txt"),
        mode === "non-utf8" ? Buffer.from([97, 255, 10]) : "first\n",
      );
      const first = commit("chore: first source (#21)");
      writeFileSync(join(cwd, "beta.bin"), Buffer.from([0, 254, 2]));
      if (mode === "overlapping") {
        writeFileSync(join(cwd, "alpha.txt"), "second\n");
      }
      const second = commit("chore: second source (#22)");
      let third: string | undefined;
      if (mode === "three-targets") {
        writeFileSync(join(cwd, "third.txt"), "third\n");
        third = commit("chore: third source (#23)");
      }
      writeFileSync(
        join(cwd, "CHANGELOG.md"),
        `${prose}\n### Complete contribution record\n\nThis audited record covers the complete ${originalBase}..${second} history: 2 in-range PRs + 0 retained seed-only PRs = 2 unique PRs.\n\n#### Pull requests\n\n- **PR #21** chore: first source.\n- **PR #22** chore: second source.\n`,
      );
      const seed = commit("docs: preserve source ledger");
      let declaredSecond = second;
      if (mode === "nonancestor" || mode === "merge-target") {
        git(cwd, ["checkout", "-qb", "side", originalBase]);
        writeFileSync(join(cwd, "side.txt"), "side\n");
        declaredSecond = commit("chore: side source");
        git(cwd, ["checkout", "-q", "main"]);
        if (mode === "merge-target") {
          git(cwd, ["merge", "--no-ff", "-qm", "merge side", "side"]);
          declaredSecond = git(cwd, ["rev-parse", "HEAD"]);
        }
      }
      git(cwd, [
        "revert",
        "--no-commit",
        ...(third ? [third] : []),
        second,
        ...(mode === "partial" ? [] : [first]),
      ]);
      if (mode === "extra-change") {
        writeFileSync(join(cwd, "extra.txt"), "unrelated change\n");
      }
      if (mode === "unknown-target") {
        declaredSecond = "1".repeat(40);
      }
      if (mode === "duplicate") {
        declaredSecond = first;
      }
      let declaration = `Reverts ${first} and ${declaredSecond} to restore the previous behavior.`;
      if (third) {
        declaration = `Reverts ${first}, ${second}, and ${third}.`;
      }
      if (mode === "abbreviated") {
        declaration = `Reverts ${first.slice(0, 12)} and ${second.slice(0, 12)}.`;
      } else if (mode === "multiple-declarations") {
        declaration = `${declaration}\n\n${declaration}`;
      } else if (mode === "prose") {
        declaration = `Discussion: ${declaration}`;
      }
      git(cwd, ["add", "."]);
      git(cwd, [
        "commit",
        "-qm",
        mode === "non-revert-subject" ? "chore: describe changes" : "chore: revert source changes",
        "-m",
        declaration,
      ]);
      let base = mode.startsWith("before-base") ? seed : originalBase;
      if (mode === "before-base-double") {
        base = git(cwd, ["rev-parse", "HEAD"]);
      }
      if (["double-revert", "before-base-double", "before-base-triple"].includes(mode)) {
        git(cwd, ["revert", "--no-edit", "HEAD"]);
      }
      if (mode === "before-base-triple") {
        base = git(cwd, ["rev-parse", "HEAD"]);
        git(cwd, ["revert", "--no-edit", "HEAD"]);
      }
      const target = git(cwd, ["rev-parse", "HEAD"]);
      const associations = { [first]: 21, [second]: 22, ...(third ? { [third]: 23 } : {}) };
      const gh = join(cwd, "gh");
      writeFileSync(
        gh,
        `#!${process.execPath}\n
const associations = ${JSON.stringify(associations)};
const query = process.argv.find((arg) => arg.startsWith("query="))?.slice(6) ?? "";
const data = {};
for (const [, alias, hash] of query.matchAll(/(c\\d+): repository[\\s\\S]*?object\\(expression: "([0-9a-f]+)"\\)/g)) {
 const number = associations[hash];
 data[alias] = { object: { associatedPullRequests: { nodes: number ? [{ number, mergedAt: "2020-01-01T00:00:00Z", mergeCommit: { oid: hash } }] : [], pageInfo: { hasNextPage: false } }, author: { user: { login: "steipete" } } } };
}
for (const [, alias, number] of query.matchAll(/(n\\d+): repository[\\s\\S]*?issueOrPullRequest\\(number: (\\d+)\\)/g)) {
 data[alias] = { issueOrPullRequest: { __typename: "PullRequest", number: Number(number), title: "chore: source", baseRefName: "main", mergedAt: "2020-01-01T00:00:00Z", author: { __typename: "User", login: "steipete" }, closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false } } } };
}
console.log(JSON.stringify({ data }));
`,
      );
      chmodSync(gh, 0o755);
      const privateTmp = join(cwd, "private-proof-tmp");
      mkdirSync(privateTmp);
      const index = join(cwd, git(cwd, ["rev-parse", "--git-path", "index"]));
      const originalIndex = readFileSync(index);
      const originalObjects = git(cwd, ["count-objects", "-v"]);
      const hooks = join(cwd, "test-hooks");
      mkdirSync(hooks);
      const hook = join(hooks, "post-index-change");
      writeFileSync(hook, "#!/bin/sh\nprintf unexpected > hook-fired\n");
      chmodSync(hook, 0o755);
      git(cwd, ["config", "core.hooksPath", hooks]);
      git(cwd, ["config", "diff.external", hook]);

      const manifestPath = join(cwd, "manifest.json");
      const result = spawnSync(
        process.execPath,
        [
          verifier,
          "--base",
          base,
          "--target",
          target,
          "--main-ref",
          target,
          "--seed-ref",
          seed,
          "--version",
          "2026.7.1",
          "--manifest",
          manifestPath,
          "--write-ledger",
          "--json",
        ],
        {
          cwd,
          encoding: "utf8",
          env: { ...process.env, TMPDIR: privateTmp, PATH: `${cwd}:${process.env.PATH}` },
        },
      );
      expect(readFileSync(index)).toEqual(originalIndex);
      expect(git(cwd, ["rev-parse", "HEAD"])).toBe(target);
      expect(git(cwd, ["count-objects", "-v"])).toBe(originalObjects);
      expect(readdirSync(privateTmp)).toEqual([]);
      expect(readdirSync(cwd)).not.toContain("hook-fired");
      if (
        ["extra-change", "partial", "unknown-target", "nonancestor", "merge-target"].includes(mode)
      ) {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("could not verify explicit multi-commit revert");
        return;
      }
      expect(result.stderr).toBe("");
      expect(result.status, result.stdout).toBe(0);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      const removed = [
        "exact",
        "before-base",
        "before-base-triple",
        "three-targets",
        "non-utf8",
        "overlapping",
      ].includes(mode);
      expect(
        manifest.pullRequests.map((entry: { number: number }) => entry.number).toSorted(),
      ).toEqual(removed ? [] : [21, 22]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.each([
    "body-only",
    "future-associated",
    "stale-row",
    "reachable-body",
    "explicit-seed",
    "canonical-carrier",
    "backport-carrier",
    "provenance-carrier",
    "unresolved-body",
  ])("bounds contribution membership to the frozen source graph: %s", (mode) => {
    const cwd = mkdtempSync(join(tmpdir(), "openclaw-release-notes-membership-"));
    try {
      git(cwd, ["init", "-q", "-b", "release"]);
      const prose = [
        "# Changelog",
        "",
        "## 2026.7.1",
        "",
        "### Highlights",
        "",
        "- One.",
        "- Two.",
        "- Three.",
        "- Four.",
        "- Five.",
        "",
        "### Changes",
        "",
        "### Fixes",
        "",
      ].join("\n");
      writeFileSync(join(cwd, "CHANGELOG.md"), prose);
      const commitAt = (message: string, day: number) => {
        git(cwd, ["add", "."]);
        const date = `2026-07-0${day}T12:00:00Z`;
        git(cwd, ["commit", "--allow-empty", "-qm", message], {
          GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_DATE: date,
        });
        return git(cwd, ["rev-parse", "HEAD"]);
      };
      const base = commitAt("chore: baseline", 1);
      writeFileSync(join(cwd, "support.txt"), "independent supporting repair\n");
      const source = commitAt(
        "chore: supporting repair (#21)\n\nRelated: #22\nThis repair is independent of the performance work.",
        2,
      );
      git(cwd, ["checkout", "-qb", "later-main"]);
      writeFileSync(join(cwd, "performance.txt"), "performance implementation\n");
      const future = commitAt("chore: performance work (#22)", 3);
      git(cwd, ["checkout", "-q", "release"]);
      let main = source;
      let carrier: string | undefined;
      if (mode === "reachable-body") {
        git(cwd, ["merge", "--ff-only", "later-main"]);
      } else if (mode.endsWith("-carrier")) {
        main = future;
        commitAt("chore: release preparation", 4);
        if (mode === "canonical-carrier") {
          git(cwd, ["cherry-pick", "-x", future], { GIT_COMMITTER_DATE: "2026-07-05T12:00:00Z" });
          carrier = git(cwd, ["rev-parse", "HEAD"]);
        } else {
          writeFileSync(join(cwd, "performance.txt"), "performance implementation\n");
          carrier = commitAt(
            mode === "backport-carrier"
              ? "chore: release performance backport\n\nBackport of #22 to release/fixture."
              : "chore: carry selected implementation",
            5,
          );
        }
      }
      let seed: string | undefined;
      if (mode === "explicit-seed") {
        writeFileSync(
          join(cwd, "CHANGELOG.md"),
          `${prose}\n### Complete contribution record\n\nThis audited record covers the complete ${base}..${source} history: 1 in-range PR + 1 retained seed-only PR = 2 unique PRs.\n\n#### Pull requests\n\n- **PR #21** chore: supporting repair.\n- **PR #22** chore: performance work.\n`,
        );
        seed = commitAt("docs: retain an explicit historical seed", 4);
      }
      const target = commitAt("chore: final release preparation", 6);
      if (
        [
          "body-only",
          "future-associated",
          "stale-row",
          "explicit-seed",
          "unresolved-body",
        ].includes(mode)
      ) {
        expect(() => git(cwd, ["merge-base", "--is-ancestor", future, target])).toThrow();
        expect(() => git(cwd, ["merge-base", "--is-ancestor", future, main])).toThrow();
        expect(() => git(cwd, ["cat-file", "-e", `${target}:performance.txt`])).toThrow();
      }
      if (mode === "stale-row") {
        writeFileSync(
          join(cwd, "CHANGELOG.md"),
          `${prose}\n### Complete contribution record\n\nThis audited record covers the complete ${base}..${target} history: 2 in-range PRs + 0 retained seed-only PRs = 2 unique PRs.\n\n#### Pull requests\n\n- **PR #21** chore: supporting repair.\n- **PR #22** chore: performance work.\n`,
        );
      }
      const gh = join(cwd, "gh");
      writeFileSync(
        gh,
        `#!${process.execPath}\n
const mode = ${JSON.stringify(mode)};
const source = ${JSON.stringify(source)};
const future = ${JSON.stringify(future)};
const query = process.argv.find((arg) => arg.startsWith("query="))?.slice(6) ?? "";
const data = {};
const nodeFor = (number) => ({ number, mergedAt: number === 21 ? "2026-07-02T12:00:00Z" : "2026-07-03T12:00:00Z", mergeCommit: { oid: number === 21 ? source : future } });
for (const [, alias, hash] of query.matchAll(/(c\\d+): repository[\\s\\S]*?object\\(expression: "([0-9a-f]+)"\\)/g)) {
 const numbers = hash === source ? (mode === "future-associated" ? [21, 22] : [21]) : hash === future && mode.endsWith("-carrier") ? [22] : [];
 data[alias] = { object: { associatedPullRequests: { nodes: numbers.map(nodeFor), pageInfo: { hasNextPage: false } }, author: { user: { login: "steipete" } } } };
}
for (const [, alias, rawNumber] of query.matchAll(/(n\\d+): repository[\\s\\S]*?issueOrPullRequest\\(number: (\\d+)\\)/g)) {
 const number = Number(rawNumber);
 data[alias] = { issueOrPullRequest: mode === "unresolved-body" && number === 22 ? null : { ...nodeFor(number), __typename: "PullRequest", title: number === 21 ? (mode === "body-only" ? "chore: supporting repair (Related #22)" : "chore: supporting repair") : "chore: performance work", baseRefName: "main", author: { __typename: "User", login: "steipete" }, closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false } } } };
}
console.log(JSON.stringify({ data }));
`,
      );
      chmodSync(gh, 0o755);
      const manifestPath = join(cwd, "manifest.json");
      const args = [
        verifier,
        "--base",
        base,
        "--target",
        target,
        "--main-ref",
        main,
        "--version",
        "2026.7.1",
        "--manifest",
        manifestPath,
        "--json",
        ...(seed ? ["--seed-ref", seed] : []),
        ...(mode === "provenance-carrier" ? ["--release-provenance", `${carrier} -> #22`] : []),
      ];
      const run = (write: boolean) =>
        spawnSync(process.execPath, [...args, ...(write ? ["--write-ledger"] : [])], {
          cwd,
          encoding: "utf8",
          env: { ...process.env, PATH: `${cwd}:${process.env.PATH}` },
        });
      if (mode === "stale-row") {
        const stale = run(false);
        expect(stale.status).not.toBe(0);
        expect(stale.stderr).toContain("outside");
      }
      const result = run(true);
      if (mode === "unresolved-body") {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("could not resolve source references: #22");
        return;
      }
      expect(result.stderr).toBe("");
      expect(result.status, result.stdout).toBe(0);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      const included = mode === "reachable-body" || mode.endsWith("-carrier") || Boolean(seed);
      expect(
        manifest.pullRequests.map((entry: { number: number }) => entry.number).toSorted(),
      ).toEqual(included ? [21, 22] : [21]);
      expect(manifest.source.inRangePullRequests).toBe(included && !seed ? 2 : 1);
      expect(manifest.source.retainedSeedOnlyPullRequests).toBe(seed ? 1 : 0);
      expect(manifest.source.references).toBe(2);
      if (mode === "body-only") {
        const generated = readFileSync(join(cwd, "CHANGELOG.md"), "utf8");
        writeFileSync(
          join(cwd, "CHANGELOG.md"),
          generated.replace("**PR #21**", "**PR #21** Related #22."),
        );
        const verified = run(false);
        expect(verified.stderr).toBe("");
        expect(verified.status, verified.stdout).toBe(0);
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("records a canonical target SHA when --target is symbolic", () => {
    const cwd = mkdtempSync(join(tmpdir(), "openclaw-release-notes-"));
    try {
      git(cwd, ["init", "-q"]);
      writeFileSync(
        join(cwd, "CHANGELOG.md"),
        [
          "# Changelog",
          "",
          "## 2026.7.1",
          "",
          "### Highlights",
          "",
          "- One.",
          "- Two.",
          "- Three.",
          "- Four.",
          "- Five.",
          "",
          "### Changes",
          "",
          "### Fixes",
        ].join("\n"),
      );
      git(cwd, ["add", "CHANGELOG.md"]);
      git(cwd, ["commit", "-qm", "initial"]);
      const targetSha = git(cwd, ["rev-parse", "HEAD"]);

      const result = spawnSync(
        process.execPath,
        [
          verifier,
          "--base",
          "HEAD",
          "--target",
          "HEAD",
          "--main-ref",
          "HEAD",
          "--version",
          "2026.7.1",
          "--write-ledger",
          "--json",
        ],
        { cwd, encoding: "utf8" },
      );

      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).target).toBe(targetSha);
      expect(readFileSync(join(cwd, "CHANGELOG.md"), "utf8")).toContain(
        `This audited record covers the complete HEAD..${targetSha} history:`,
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("accepts a release-only base that shares history with canonical main", () => {
    const cwd = mkdtempSync(join(tmpdir(), "openclaw-release-notes-"));
    try {
      git(cwd, ["init", "-q"]);
      writeFileSync(
        join(cwd, "CHANGELOG.md"),
        [
          "# Changelog",
          "",
          "## 2026.7.1",
          "",
          "### Highlights",
          "",
          "- One.",
          "- Two.",
          "- Three.",
          "- Four.",
          "- Five.",
          "",
          "### Changes",
          "",
          "### Fixes",
        ].join("\n"),
      );
      git(cwd, ["add", "CHANGELOG.md"]);
      git(cwd, ["commit", "-qm", "initial"]);
      const root = git(cwd, ["rev-parse", "HEAD"]);

      writeFileSync(join(cwd, "main.txt"), "main\n");
      git(cwd, ["add", "main.txt"]);
      git(cwd, ["commit", "-qm", "main"]);
      git(cwd, ["branch", "main-ref"]);

      git(cwd, ["checkout", "-qb", "release", root]);
      writeFileSync(join(cwd, "release.txt"), "release\n");
      git(cwd, ["add", "release.txt"]);
      git(cwd, ["commit", "-qm", "release"]);
      git(cwd, ["tag", "beta-base"]);

      const result = spawnSync(
        process.execPath,
        [
          verifier,
          "--base",
          "beta-base",
          "--target",
          "HEAD",
          "--main-ref",
          "main-ref",
          "--version",
          "2026.7.1",
          "--write-ledger",
        ],
        { cwd, encoding: "utf8" },
      );

      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("leaves CHANGELOG.md untouched when the rendered ledger fails validation", () => {
    const cwd = mkdtempSync(join(tmpdir(), "openclaw-release-notes-"));
    try {
      git(cwd, ["init", "-q"]);
      const changelog = [
        "# Changelog",
        "",
        "## 2026.7.1",
        "",
        "### Highlights",
        "",
        "- Only one highlight.",
        "",
        "### Changes",
        "",
        "### Fixes",
        "",
      ].join("\n");
      writeFileSync(join(cwd, "CHANGELOG.md"), changelog);
      git(cwd, ["add", "CHANGELOG.md"]);
      git(cwd, ["commit", "-qm", "initial"]);
      const manifestPath = join(cwd, "release-manifest.json");

      const result = spawnSync(
        process.execPath,
        [
          verifier,
          "--base",
          "HEAD",
          "--target",
          "HEAD",
          "--main-ref",
          "HEAD",
          "--manifest",
          manifestPath,
          "--version",
          "2026.7.1",
          "--write-ledger",
        ],
        { cwd, encoding: "utf8" },
      );

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("1 errors");
      expect(JSON.parse(readFileSync(manifestPath, "utf8"))).toMatchObject({
        schemaVersion: 3,
        version: "2026.7.1",
        source: {
          inRangePullRequests: 0,
          retainedSeedOnlyPullRequests: 0,
          uniquePullRequests: 0,
        },
      });
      expect(readFileSync(join(cwd, "CHANGELOG.md"), "utf8")).toBe(changelog);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects a release base that is not an ancestor of the target", () => {
    const cwd = mkdtempSync(join(tmpdir(), "openclaw-release-notes-"));
    try {
      git(cwd, ["init", "-q"]);
      writeFileSync(
        join(cwd, "CHANGELOG.md"),
        [
          "# Changelog",
          "",
          "## 2026.7.1",
          "",
          "### Highlights",
          "",
          "- Test release.",
          "",
          "### Complete contribution record",
          "",
        ].join("\n"),
      );
      git(cwd, ["add", "CHANGELOG.md"]);
      git(cwd, ["commit", "-qm", "initial"]);
      git(cwd, ["branch", "target"]);

      writeFileSync(join(cwd, "base.txt"), "base\n");
      git(cwd, ["add", "base.txt"]);
      git(cwd, ["commit", "-qm", "base"]);
      git(cwd, ["tag", "base-ref"]);

      git(cwd, ["checkout", "-q", "target"]);
      writeFileSync(join(cwd, "target.txt"), "target\n");
      git(cwd, ["add", "target.txt"]);
      git(cwd, ["commit", "-qm", "target"]);

      const result = spawnSync(
        process.execPath,
        [
          verifier,
          "--base",
          "base-ref",
          "--target",
          "HEAD",
          "--main-ref",
          "HEAD",
          "--version",
          "2026.7.1",
        ],
        { cwd, encoding: "utf8" },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "release range base base-ref must be an ancestor of target HEAD",
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
