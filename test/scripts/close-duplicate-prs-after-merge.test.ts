import { describe, expect, it } from "vitest";
import {
  applyClosePlan,
  buildDuplicateClosePlan,
  parseArgs,
  parsePrNumberList,
  parseUnifiedDiffRanges,
  runDuplicateCloseWorkflow,
} from "../../scripts/close-duplicate-prs-after-merge.mjs";

function pr(params: {
  body?: string;
  files?: string[];
  mergedAt?: string | null;
  mergeCommit?: string;
  number: number;
  state?: string;
  title?: string;
}) {
  return {
    body: params.body ?? "",
    closingIssuesReferences: [],
    files: (params.files ?? ["ui/src/ui/chat/grouped-render.ts"]).map((path) => ({ path })),
    mergeCommit: params.mergeCommit ? { oid: params.mergeCommit } : null,
    mergedAt: params.mergedAt ?? null,
    number: params.number,
    state: params.state ?? "OPEN",
    title: params.title ?? `PR ${params.number}`,
    url: `https://github.com/openclaw/openclaw/pull/${params.number}`,
  };
}

describe("close duplicate PRs after merge", () => {
  it("parses comma, whitespace, and hash-prefixed PR lists", () => {
    expect(parsePrNumberList("#70530, 70592\n70530")).toEqual([70530, 70592]);
  });

  it("parses hunk ranges from unified diffs", () => {
    const ranges = parseUnifiedDiffRanges(`diff --git a/a.ts b/a.ts
@@ -10,2 +20,4 @@
+x
diff --git a/b.ts b/b.ts
@@ -1 +5 @@
-a
+b`);

    expect(ranges.get("a.ts")).toEqual([{ start: 20, end: 23 }]);
    expect(ranges.get("b.ts")).toEqual([{ start: 5, end: 5 }]);
  });

  it("allows duplicate closure with overlapping hunks even without an explicit issue ref", () => {
    const landed = pr({
      body: "Fixes #70491",
      mergeCommit: "6415e35",
      mergedAt: "2026-04-23T17:13:32Z",
      number: 70532,
      state: "MERGED",
    });
    const candidate = pr({ number: 70530 });
    const diffs = new Map([
      [
        70532,
        `diff --git a/ui/src/ui/chat/grouped-render.ts b/ui/src/ui/chat/grouped-render.ts
@@ -402,8 +402,11 @@`,
      ],
      [
        70530,
        `diff --git a/ui/src/ui/chat/grouped-render.ts b/ui/src/ui/chat/grouped-render.ts
@@ -402,8 +402,11 @@`,
      ],
    ]);

    const plan = buildDuplicateClosePlan({
      candidates: [candidate],
      diffs,
      landed,
      repo: "openclaw/openclaw",
    });

    expect(plan).toStrictEqual([
      {
        action: "close",
        candidate,
        comment: `Thanks for the fix. This is now covered by the landed #70532 / commit https://github.com/openclaw/openclaw/commit/6415e35.

Evidence: overlapping changed hunks; shared file(s): ui/src/ui/chat/grouped-render.ts.

Closing #70530 as a duplicate.`,
        evidence: {
          overlappingHunks: true,
          sharedFiles: ["ui/src/ui/chat/grouped-render.ts"],
          sharedIssues: [],
        },
      },
    ]);
  });

  it("allows duplicate closure with a shared issue ref even when hunks drift", () => {
    const landed = pr({
      body: "Fixes #70491",
      mergeCommit: "6415e35",
      mergedAt: "2026-04-23T17:13:32Z",
      number: 70532,
      state: "MERGED",
    });
    const candidate = pr({ body: "Closes #70491", number: 70592 });
    const diffs = new Map([
      [
        70532,
        `diff --git a/ui/src/ui/chat/grouped-render.ts b/ui/src/ui/chat/grouped-render.ts
@@ -402,8 +402,11 @@`,
      ],
      [
        70592,
        `diff --git a/ui/src/ui/chat/grouped-render.ts b/ui/src/ui/chat/grouped-render.ts
@@ -286,8 +286,11 @@`,
      ],
    ]);

    const plan = buildDuplicateClosePlan({
      candidates: [candidate],
      diffs,
      landed,
      repo: "openclaw/openclaw",
    });

    expect(plan[0]).toStrictEqual({
      action: "close",
      candidate,
      comment: `Thanks for the fix. This is now covered by the landed #70532 / commit https://github.com/openclaw/openclaw/commit/6415e35.

Evidence: shared issue(s): #70491; shared file(s): ui/src/ui/chat/grouped-render.ts.

Closing #70592 as a duplicate.`,
      evidence: {
        overlappingHunks: false,
        sharedFiles: ["ui/src/ui/chat/grouped-render.ts"],
        sharedIssues: [70491],
      },
    });
  });

  it("refuses candidates without shared issue or overlapping hunks", () => {
    const landed = pr({
      body: "Fixes #70491",
      mergeCommit: "6415e35",
      mergedAt: "2026-04-23T17:13:32Z",
      number: 70532,
      state: "MERGED",
    });
    const candidate = pr({ body: "Fixes #1", number: 1 });
    const diffs = new Map([
      [70532, "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@"],
      [1, "diff --git a/a.ts b/a.ts\n@@ -99 +99 @@"],
    ]);

    expect(() =>
      buildDuplicateClosePlan({
        candidates: [candidate],
        diffs,
        landed,
        repo: "openclaw/openclaw",
      }),
    ).toThrow("Refusing to close #1");
  });

  it("dry-runs through gh reads without mutating", () => {
    const calls: string[][] = [];
    const responses = new Map<string, string>([
      [
        "pr view 70532 --repo openclaw/openclaw --json number,title,body,state,mergedAt,mergeCommit,closingIssuesReferences,files,url",
        JSON.stringify(
          pr({
            body: "Fixes #70491",
            mergeCommit: "6415e35",
            mergedAt: "2026-04-23T17:13:32Z",
            number: 70532,
            state: "MERGED",
          }),
        ),
      ],
      [
        "pr view 70592 --repo openclaw/openclaw --json number,title,body,state,mergedAt,mergeCommit,closingIssuesReferences,files,url",
        JSON.stringify(pr({ body: "Closes #70491", number: 70592 })),
      ],
      [
        "pr diff 70532 --repo openclaw/openclaw --color=never",
        "diff --git a/ui/src/ui/chat/grouped-render.ts b/ui/src/ui/chat/grouped-render.ts\n@@ -402,8 +402,11 @@",
      ],
      [
        "pr diff 70592 --repo openclaw/openclaw --color=never",
        "diff --git a/ui/src/ui/chat/grouped-render.ts b/ui/src/ui/chat/grouped-render.ts\n@@ -286,8 +286,11 @@",
      ],
    ]);
    const runGh = (args: string[]) => {
      calls.push(args);
      const key = args.join(" ");
      const response = responses.get(key);
      if (response === undefined) {
        throw new Error(`unexpected gh call: ${key}`);
      }
      return response;
    };

    const args = parseArgs(["--landed-pr", "70532", "--duplicates", "70592"], {
      GITHUB_REPOSITORY: "openclaw/openclaw",
    });
    const plan = runDuplicateCloseWorkflow(args, runGh);

    expect(plan).toHaveLength(1);
    expect(calls.map((call) => call.slice(0, 2).join(" "))).toEqual([
      "pr view",
      "pr view",
      "pr diff",
      "pr diff",
    ]);
  });

  it("applies labels, comment, and close commands for close actions", () => {
    const calls: string[][] = [];
    applyClosePlan({
      labels: ["duplicate", "close:duplicate"],
      plan: [
        {
          action: "close",
          candidate: pr({ number: 70592 }),
          comment: "closing",
          evidence: { overlappingHunks: false, sharedFiles: [], sharedIssues: [70491] },
        },
      ],
      repo: "openclaw/openclaw",
      runGh: (args: string[]) => {
        calls.push(args);
        return "";
      },
    });

    expect(calls).toEqual([
      [
        "pr",
        "edit",
        "70592",
        "--repo",
        "openclaw/openclaw",
        "--add-label",
        "duplicate",
        "--add-label",
        "close:duplicate",
      ],
      ["pr", "comment", "70592", "--repo", "openclaw/openclaw", "--body", "closing"],
      ["pr", "close", "70592", "--repo", "openclaw/openclaw"],
    ]);
  });
});
