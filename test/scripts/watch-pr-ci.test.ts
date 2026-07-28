import { describe, expect, it } from "vitest";
import {
  buildFindRunArgs,
  classifyRollup,
  classifyRunAttachment,
  collectRollupContexts,
  parseArgs,
  pollUntilDeadline,
  sanitizeCheckName,
  selectRunAfter,
} from "../../scripts/watch-pr-ci.mjs";

const sha = "a".repeat(40);

describe("watch-pr-ci", () => {
  it("parses defaults and overrides", () => {
    expect(parseArgs(["42", sha])).toEqual({
      pr: 42,
      headSha: sha,
      repo: "openclaw/openclaw",
      attachTimeout: 900,
      timeout: 3600,
      interval: 120,
    });
    expect(
      parseArgs([
        "7",
        sha,
        "--repo",
        "fork/project",
        "--after",
        "1234",
        "--attach-timeout",
        "30",
        "--timeout",
        "90",
        "--interval",
        "5",
      ]),
    ).toMatchObject({
      repo: "fork/project",
      after: 1234,
      attachTimeout: 30,
      timeout: 90,
      interval: 5,
    });
    expect(parseArgs(["1", sha.toUpperCase()]).headSha).toBe(sha);
  });

  it("rejects malformed arguments", () => {
    expect(() => parseArgs(["0", sha])).toThrow("pr-number must be a positive integer");
    expect(() => parseArgs(["1", "abc"])).toThrow("full 40-character commit SHA");
    expect(() => parseArgs(["1", sha, "--interval", "0"])).toThrow(
      "--interval must be a positive integer",
    );
    expect(() => parseArgs(["1", sha, "--after", "0"])).toThrow(
      "--after must be a positive integer",
    );
  });

  it("builds a pull-request-only run attachment query", () => {
    expect(buildFindRunArgs("openclaw/openclaw", sha)).toEqual([
      "run",
      "list",
      "--repo",
      "openclaw/openclaw",
      "--commit",
      sha,
      "--workflow",
      "ci.yml",
      "--event",
      "pull_request",
      "--limit",
      "1",
      "--json",
      "createdAt,databaseId",
    ]);
  });

  it("filters run ids at and before --after", () => {
    const newer = { databaseId: 102, createdAt: "2026-07-23T02:00:00Z" };
    const runs = [newer, { databaseId: 101, createdAt: "2026-07-23T01:00:00Z" }];
    expect(selectRunAfter(runs, 101)).toBe(newer);
    expect(selectRunAfter(runs, 102)).toBeUndefined();
    expect(selectRunAfter(runs)).toBe(newer);
  });

  it("sanitizes untrusted check names for terminal output", () => {
    expect(sanitizeCheckName("plain ASCII / check (1)")).toBe("plain ASCII / check (1)");
    expect(sanitizeCheckName("Crème 日本語 １２３")).toBe("Crème 日本語 １２３");
    expect(sanitizeCheckName("unit\n\r\t\u0000check")).toBe("unit?check");
    expect(sanitizeCheckName("safe\u001b[31mred\u001b[0m text")).toBe("safe?red? text");
    expect(sanitizeCheckName("link\u001b]8;;https://example.com\u0007text\u001b]8;;\u0007")).toBe(
      "link?text?",
    );
    expect(sanitizeCheckName("left\u202Eright 😀")).toBe("left?right ?");
  });

  it("sanitizes failing check and status-context names before classification output", () => {
    expect(
      classifyRollup({
        state: "FAILURE",
        contexts: {
          nodes: [
            {
              kind: "CheckRun",
              name: "unit\u001b[31mowned\u001b[0m",
              status: "COMPLETED",
              conclusion: "FAILURE",
            },
            { kind: "StatusContext", context: "deploy\nprod", state: "ERROR" },
          ],
        },
      }).failingNames,
    ).toEqual(["deploy?prod", "unit?owned?"]);
  });

  it("polls once more after the deadline-clamped final wait", async () => {
    let now = 0;
    const waits: number[] = [];
    let polls = 0;
    const result = await pollUntilDeadline({
      deadline: 1_000,
      interval: 120,
      now: () => now,
      wait: async (milliseconds) => {
        waits.push(milliseconds);
        now += milliseconds;
      },
      poll: () => (++polls === 2 ? "transitioned" : undefined),
    });

    expect(result).toBe("transitioned");
    expect(waits).toEqual([1_000]);
    expect(polls).toBe(2);
  });

  it("times out only after polling at the deadline", async () => {
    let now = 0;
    let polls = 0;
    const result = await pollUntilDeadline({
      deadline: 1_000,
      interval: 120,
      now: () => now,
      wait: async (milliseconds) => {
        now += milliseconds;
      },
      poll: () => {
        polls += 1;
        return undefined;
      },
    });

    expect(result).toBeUndefined();
    expect(now).toBe(1_000);
    expect(polls).toBe(2);
  });

  it("warns for an already-completed late attachment without changing attachment", () => {
    expect(classifyRunAttachment(102, { status: "completed", conclusion: "success" })).toEqual({
      attach: true,
      warning:
        "WARN attaching to already-completed run 102 (started before watcher); pass --after 102 to require a fresh run",
    });
    expect(classifyRunAttachment(102, { status: "completed", conclusion: "success" }, 101)).toEqual(
      { attach: true, warning: undefined },
    );
    expect(classifyRunAttachment(102, { status: "completed", conclusion: "skipped" })).toEqual({
      attach: false,
    });
  });

  it("requires aggregate success for a green rollup", () => {
    expect(classifyRollup({ state: "SUCCESS", contexts: { nodes: [] } }).verdict).toBe("GREEN");
    expect(
      classifyRollup({
        state: "PENDING",
        contexts: {
          nodes: [{ kind: "CheckRun", name: "unit", status: "COMPLETED", conclusion: "SUCCESS" }],
        },
      }),
    ).toEqual({ verdict: "PENDING", pendingCount: 0, failingNames: [], supersededCount: 0 });
  });

  it("counts pending contexts without deriving the verdict from them", () => {
    expect(
      classifyRollup({
        state: "PENDING",
        contexts: {
          nodes: [{ kind: "CheckRun", name: "unit", status: "IN_PROGRESS", conclusion: null }],
        },
      }),
    ).toEqual({ verdict: "PENDING", pendingCount: 1, failingNames: [], supersededCount: 0 });
  });

  it.each(["FAILURE", "ERROR"])(
    "keeps identity-less same-name cancellations failing for aggregate %s",
    (state) => {
      expect(
        classifyRollup({
          state,
          contexts: {
            totalCount: 3,
            nodes: [
              {
                kind: "CheckRun",
                name: "Auto response",
                status: "COMPLETED",
                conclusion: "FAILURE",
              },
              { kind: "CheckRun", name: "unit", status: "COMPLETED", conclusion: "CANCELLED" },
              { kind: "CheckRun", name: "unit", status: "COMPLETED", conclusion: "SUCCESS" },
            ],
          },
        }),
      ).toEqual({
        verdict: "FAILING",
        pendingCount: 0,
        failingNames: ["unit"],
        supersededCount: 0,
      });
    },
  );

  it("keeps a truncated failing rollup failing", () => {
    expect(
      classifyRollup({
        state: "FAILURE",
        contexts: {
          totalCount: 4,
          nodes: [
            { kind: "CheckRun", name: "unit", status: "COMPLETED", conclusion: "CANCELLED" },
            { kind: "CheckRun", name: "unit", status: "COMPLETED", conclusion: "SUCCESS" },
          ],
        },
      }),
    ).toEqual({
      verdict: "FAILING",
      pendingCount: 0,
      failingNames: ["unit", "+2 more contexts not shown"],
      supersededCount: 0,
    });
  });

  it("keeps cancelled attempts in failing-name output", () => {
    expect(
      classifyRollup({
        state: "FAILURE",
        contexts: {
          nodes: [
            { kind: "CheckRun", name: "Auto response", status: "COMPLETED", conclusion: "FAILURE" },
            { kind: "CheckRun", name: "unit", status: "COMPLETED", conclusion: "CANCELLED" },
            { kind: "CheckRun", name: "unit", status: "COMPLETED", conclusion: "SUCCESS" },
            { kind: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "TIMED_OUT" },
          ],
        },
      }),
    ).toEqual({
      verdict: "FAILING",
      pendingCount: 0,
      failingNames: ["lint", "unit"],
      supersededCount: 0,
    });
  });

  it("ignores superseded workflow runs while replacements are in progress", () => {
    expect(
      classifyRollup({
        state: "FAILURE",
        contexts: {
          nodes: [
            {
              kind: "CheckRun",
              name: "Real behavior proof",
              status: "COMPLETED",
              conclusion: "CANCELLED",
              checkSuite: {
                workflowRun: { databaseId: 100, workflow: { databaseId: 10 } },
              },
            },
            {
              kind: "CheckRun",
              name: "Real behavior proof",
              status: "IN_PROGRESS",
              conclusion: null,
              checkSuite: {
                workflowRun: { databaseId: 200, workflow: { databaseId: 10 } },
              },
            },
            {
              kind: "CheckRun",
              name: "CI",
              status: "IN_PROGRESS",
              conclusion: null,
              checkSuite: { workflowRun: { databaseId: 150, workflow: { databaseId: 20 } } },
            },
          ],
        },
      }),
    ).toEqual({ verdict: "PENDING", pendingCount: 2, failingNames: [], supersededCount: 1 });
  });

  it("keeps only the newest same-run check attempt while its replacement is pending", () => {
    expect(
      classifyRollup({
        state: "FAILURE",
        contexts: {
          nodes: [
            {
              kind: "CheckRun",
              databaseId: 1_000,
              name: "unit",
              status: "COMPLETED",
              conclusion: "CANCELLED",
              checkSuite: { workflowRun: { databaseId: 500, workflow: { databaseId: 20 } } },
            },
            {
              kind: "CheckRun",
              databaseId: 2_000,
              name: "unit",
              status: "IN_PROGRESS",
              conclusion: null,
              checkSuite: { workflowRun: { databaseId: 500, workflow: { databaseId: 20 } } },
            },
          ],
        },
      }),
    ).toEqual({ verdict: "PENDING", pendingCount: 1, failingNames: [], supersededCount: 1 });
  });

  it("accepts a successful newest check attempt when the aggregate remains failed", () => {
    expect(
      classifyRollup({
        state: "FAILURE",
        contexts: {
          nodes: [
            {
              kind: "CheckRun",
              databaseId: 1_000,
              name: "unit",
              status: "COMPLETED",
              conclusion: "CANCELLED",
              checkSuite: { workflowRun: { databaseId: 500, workflow: { databaseId: 20 } } },
            },
            {
              kind: "CheckRun",
              databaseId: 2_000,
              name: "unit",
              status: "COMPLETED",
              conclusion: "SUCCESS",
              checkSuite: { workflowRun: { databaseId: 500, workflow: { databaseId: 20 } } },
            },
          ],
        },
      }),
    ).toEqual({ verdict: "GREEN", pendingCount: 0, failingNames: [], supersededCount: 1 });
  });

  it("accepts newest successful runs when the aggregate remains failed", () => {
    expect(
      classifyRollup({
        state: "FAILURE",
        contexts: {
          nodes: [
            {
              kind: "CheckRun",
              name: "old proof",
              status: "COMPLETED",
              conclusion: "CANCELLED",
              checkSuite: {
                workflowRun: { databaseId: 100, workflow: { databaseId: 10 } },
              },
            },
            {
              kind: "CheckRun",
              name: "proof",
              status: "COMPLETED",
              conclusion: "SUCCESS",
              checkSuite: {
                workflowRun: { databaseId: 200, workflow: { databaseId: 10 } },
              },
            },
            {
              kind: "CheckRun",
              name: "old CI",
              status: "COMPLETED",
              conclusion: "CANCELLED",
              checkSuite: { workflowRun: { databaseId: 150, workflow: { databaseId: 20 } } },
            },
            {
              kind: "CheckRun",
              name: "CI",
              status: "COMPLETED",
              conclusion: "SUCCESS",
              checkSuite: { workflowRun: { databaseId: 250, workflow: { databaseId: 20 } } },
            },
          ],
        },
      }),
    ).toEqual({ verdict: "GREEN", pendingCount: 0, failingNames: [], supersededCount: 2 });
  });

  it("preserves a genuine failure from the newest workflow run", () => {
    expect(
      classifyRollup({
        state: "FAILURE",
        contexts: {
          nodes: [
            {
              kind: "CheckRun",
              name: "superseded cancellation",
              status: "COMPLETED",
              conclusion: "CANCELLED",
              checkSuite: { workflowRun: { databaseId: 100, workflow: { databaseId: 20 } } },
            },
            {
              kind: "CheckRun",
              name: "unit",
              status: "COMPLETED",
              conclusion: "FAILURE",
              checkSuite: { workflowRun: { databaseId: 200, workflow: { databaseId: 20 } } },
            },
          ],
        },
      }),
    ).toEqual({
      verdict: "FAILING",
      pendingCount: 0,
      failingNames: ["unit"],
      supersededCount: 1,
    });
  });

  it("preserves failures across interleaved distinct workflow identities", () => {
    expect(
      classifyRollup({
        state: "FAILURE",
        contexts: {
          nodes: [
            {
              kind: "CheckRun",
              name: "old deploy",
              status: "COMPLETED",
              conclusion: "CANCELLED",
              checkSuite: { workflowRun: { databaseId: 200, workflow: { databaseId: 20 } } },
            },
            {
              kind: "CheckRun",
              name: "unit",
              status: "COMPLETED",
              conclusion: "FAILURE",
              checkSuite: { workflowRun: { databaseId: 300, workflow: { databaseId: 10 } } },
            },
            {
              kind: "CheckRun",
              name: "deploy",
              status: "COMPLETED",
              conclusion: "SUCCESS",
              checkSuite: { workflowRun: { databaseId: 400, workflow: { databaseId: 20 } } },
            },
          ],
        },
      }),
    ).toEqual({
      verdict: "FAILING",
      pendingCount: 0,
      failingNames: ["unit"],
      supersededCount: 1,
    });
  });

  it("keeps an older run's unique failing job visible", () => {
    expect(
      classifyRollup({
        state: "FAILURE",
        contexts: {
          nodes: [
            {
              kind: "CheckRun",
              databaseId: 1_000,
              name: "nightly-special",
              status: "COMPLETED",
              conclusion: "FAILURE",
              checkSuite: { workflowRun: { databaseId: 300, workflow: { databaseId: 20 } } },
            },
            {
              kind: "CheckRun",
              databaseId: 2_000,
              name: "unit",
              status: "COMPLETED",
              conclusion: "SUCCESS",
              checkSuite: { workflowRun: { databaseId: 400, workflow: { databaseId: 20 } } },
            },
          ],
        },
      }),
    ).toEqual({
      verdict: "FAILING",
      pendingCount: 0,
      failingNames: ["nightly-special"],
      supersededCount: 0,
    });
  });

  it("supersedes same-name checks across runs of the same workflow", () => {
    expect(
      classifyRollup({
        state: "FAILURE",
        contexts: {
          nodes: [
            {
              kind: "CheckRun",
              databaseId: 1_000,
              name: "unit",
              status: "COMPLETED",
              conclusion: "FAILURE",
              checkSuite: { workflowRun: { databaseId: 300, workflow: { databaseId: 20 } } },
            },
            {
              kind: "CheckRun",
              databaseId: 2_000,
              name: "unit",
              status: "COMPLETED",
              conclusion: "SUCCESS",
              checkSuite: { workflowRun: { databaseId: 400, workflow: { databaseId: 20 } } },
            },
          ],
        },
      }),
    ).toEqual({ verdict: "GREEN", pendingCount: 0, failingNames: [], supersededCount: 1 });
  });

  it("fails conservatively when unseen contexts may explain aggregate failure", () => {
    expect(
      classifyRollup({
        state: "FAILURE",
        contexts: {
          totalCount: 3,
          nodes: [
            {
              kind: "CheckRun",
              name: "old CI",
              status: "COMPLETED",
              conclusion: "CANCELLED",
              checkSuite: { workflowRun: { databaseId: 100, workflow: { databaseId: 20 } } },
            },
            {
              kind: "CheckRun",
              name: "CI",
              status: "COMPLETED",
              conclusion: "SUCCESS",
              checkSuite: { workflowRun: { databaseId: 200, workflow: { databaseId: 20 } } },
            },
          ],
        },
      }),
    ).toEqual({
      verdict: "FAILING",
      pendingCount: 0,
      failingNames: ["status rollup", "+1 more contexts not shown"],
      supersededCount: 1,
    });
  });

  it("collects rollup contexts across pages", () => {
    const cursors: Array<string | null> = [];
    const result = collectRollupContexts((cursor) => {
      cursors.push(cursor);
      if (cursor === null) {
        return {
          statusCheckRollup: {
            state: "PENDING",
            contexts: {
              totalCount: 2,
              nodes: [{ kind: "CheckRun", name: "first" }],
              pageInfo: { hasNextPage: true, endCursor: "next" },
            },
          },
        };
      }
      return {
        statusCheckRollup: {
          state: "PENDING",
          contexts: {
            totalCount: 2,
            nodes: [{ kind: "CheckRun", name: "second" }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      };
    });

    expect(cursors).toEqual([null, "next"]);
    expect(result?.statusCheckRollup?.contexts?.totalCount).toBe(2);
    expect(result?.statusCheckRollup?.contexts?.nodes?.map((node) => node.name)).toEqual([
      "first",
      "second",
    ]);
  });

  it("rejects rollup pages from a changed snapshot", () => {
    expect(() =>
      collectRollupContexts((cursor) => ({
        headRefOid: "a".repeat(40),
        statusCheckRollup: {
          state: "PENDING",
          contexts: {
            totalCount: cursor === null ? 2 : 3,
            nodes: [{ kind: "CheckRun", name: cursor === null ? "first" : "second" }],
            pageInfo:
              cursor === null
                ? { hasNextPage: true, endCursor: "next" }
                : { hasNextPage: false, endCursor: null },
          },
        },
      })),
    ).toThrow("rollup snapshot changed during pagination");
  });

  it("rejects a pagination read that loses an advertised page", () => {
    expect(() =>
      collectRollupContexts((cursor) =>
        cursor === null
          ? {
              headRefOid: "a".repeat(40),
              statusCheckRollup: {
                state: "SUCCESS",
                contexts: {
                  totalCount: 2,
                  nodes: [{ kind: "CheckRun", name: "first" }],
                  pageInfo: { hasNextPage: true, endCursor: "next" },
                },
              },
            }
          : { headRefOid: "b".repeat(40), statusCheckRollup: null },
      ),
    ).toThrow("rollup snapshot changed during pagination");
  });

  it("caps rollup context collection at ten pages", () => {
    let calls = 0;
    const result = collectRollupContexts(() => {
      calls += 1;
      return {
        statusCheckRollup: {
          state: "FAILURE",
          contexts: {
            totalCount: 11,
            nodes: [{ kind: "CheckRun", name: `page-${calls}` }],
            pageInfo: { hasNextPage: true, endCursor: `cursor-${calls}` },
          },
        },
      };
    });

    expect(calls).toBe(10);
    expect(result?.statusCheckRollup?.contexts?.nodes).toHaveLength(10);
  });
});
