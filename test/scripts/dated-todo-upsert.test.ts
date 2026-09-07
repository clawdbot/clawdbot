import { describe, expect, it } from "vitest";
import {
  runDatedTodoUpsert,
  validateDatedTodoReport,
} from "../../scripts/github/dated-todo-upsert.mjs";

const MARKER = "<!-- dated-todo-sweep -->";
const REPORT = [
  "# Dated TODO sweep",
  "",
  "Generated for 2026-07-25 UTC.",
  "",
  "## OVERDUE",
  "",
  "- [ ] src/urgent.ts:7 — remove expired compatibility (2026-07-01)",
  "",
  "## DUE within 30 days",
  "",
  "_None._",
  "",
  "## FUTURE",
  "",
  "_None._",
  "",
  "Dropped as noise: 2",
].join("\n");

function issue(number: number, options: { trusted: boolean; body?: string }) {
  return {
    number,
    state: "open",
    body: options.body ?? `${MARKER}\n\n${REPORT}`,
    user: { type: options.trusted ? "Bot" : "User" },
    labels: options.trusted ? [{ name: "dated-todo-sweep" }] : [],
  };
}

function harness(
  searchItems: ReturnType<typeof issue>[],
  options: {
    comments?: Array<{
      body?: string;
      performed_via_github_app?: { id?: number; slug?: string };
      user?: { login?: string; type?: string };
    }>;
    commentError?: Error;
    searchError?: Error;
    searchResults?: ReturnType<typeof issue>[];
  } = {},
) {
  const calls = {
    create: [] as unknown[],
    update: [] as unknown[],
    comment: [] as unknown[],
    warnings: [] as string[],
    sequence: [] as string[],
  };
  const github = {
    paginate: async (_method: unknown, args: Record<string, unknown>) =>
      "labels" in args
        ? searchItems.filter((candidate) =>
            candidate.labels.some((label) => label.name === "dated-todo-sweep"),
          )
        : (options.comments ?? []),
    rest: {
      search: {
        issuesAndPullRequests: async () => {
          if (options.searchError) {
            throw options.searchError;
          }
          return { data: { items: options.searchResults ?? searchItems } };
        },
      },
      issues: {
        getLabel: async () => ({ data: { name: "dated-todo-sweep" } }),
        createLabel: async () => ({ data: {} }),
        create: async (args: unknown) => {
          calls.create.push(args);
          return { data: { number: 123 } };
        },
        update: async (args: unknown) => {
          calls.update.push(args);
          calls.sequence.push("update");
          return { data: {} };
        },
        createComment: async (args: unknown) => {
          calls.comment.push(args);
          calls.sequence.push("comment");
          if (options.commentError) {
            throw options.commentError;
          }
          return { data: {} };
        },
        listComments: async () => ({ data: options.comments ?? [] }),
        listForRepo: async () => ({ data: searchItems }),
      },
    },
  };
  const core = {
    info: () => {},
    warning: (message: string) => calls.warnings.push(message),
  };
  return { calls, core, github };
}

describe("dated TODO issue upsert", () => {
  it("ignores a public marker spoof and updates only the bot-and-label tracker", async () => {
    const spoof = issue(99, { trusted: false });
    const tracker = issue(10, {
      trusted: true,
      body: `${MARKER}\n\n## OVERDUE\n\n## DUE within 30 days\n\n## FUTURE\n`,
    });
    const { calls, core, github } = harness([spoof, tracker]);

    await runDatedTodoUpsert({
      github,
      context: { repo: { owner: "openclaw", repo: "openclaw" } },
      core,
      report: REPORT,
    });

    expect(calls.create).toHaveLength(0);
    expect(calls.update).toEqual([
      expect.objectContaining({ issue_number: tracker.number, state: "open" }),
    ]);
    expect(calls.comment).toEqual([
      expect.objectContaining({
        issue_number: tracker.number,
        body: expect.stringContaining("src/urgent.ts:7"),
      }),
    ]);
    expect(calls.sequence).toEqual(["comment", "update"]);
    expect(calls.warnings).toEqual([expect.stringContaining("Ignored 1 untrusted")]);
  });

  it("finds the labeled tracker while the search index is still empty", async () => {
    const tracker = issue(10, { trusted: true });
    const { calls, core, github } = harness([tracker], { searchResults: [] });

    await runDatedTodoUpsert({
      github,
      context: { repo: { owner: "openclaw", repo: "openclaw" } },
      core,
      report: REPORT,
    });

    expect(calls.create).toHaveLength(0);
    expect(calls.update).toEqual([expect.objectContaining({ issue_number: tracker.number })]);
  });

  it("updates the canonical tracker when diagnostics-only search fails", async () => {
    const tracker = issue(10, { trusted: true });
    const { calls, core, github } = harness([tracker], {
      searchError: new Error("secondary rate limit"),
    });

    await runDatedTodoUpsert({
      github,
      context: { repo: { owner: "openclaw", repo: "openclaw" } },
      core,
      report: REPORT,
    });

    expect(calls.update).toEqual([expect.objectContaining({ issue_number: tracker.number })]);
    expect(calls.warnings).toEqual([expect.stringContaining("Skipping diagnostics-only")]);
  });

  it("does not advance the issue body when an urgent notification fails", async () => {
    const tracker = issue(10, {
      trusted: true,
      body: `${MARKER}\n\n## OVERDUE\n\n## DUE within 30 days\n\n## FUTURE\n`,
    });
    const { calls, core, github } = harness([tracker], {
      commentError: new Error("comment failed"),
    });

    await expect(
      runDatedTodoUpsert({
        github,
        context: { repo: { owner: "openclaw", repo: "openclaw" } },
        core,
        report: REPORT,
      }),
    ).rejects.toThrow("comment failed");

    expect(calls.update).toHaveLength(0);
  });

  it("does not duplicate an urgent comment when retrying a failed body update", async () => {
    const tracker = issue(10, {
      trusted: true,
      body: `${MARKER}\n\n## OVERDUE\n\n## DUE within 30 days\n\n## FUTURE\n`,
    });
    const first = harness([tracker]);
    await runDatedTodoUpsert({
      github: first.github,
      context: { repo: { owner: "openclaw", repo: "openclaw" } },
      core: first.core,
      report: REPORT,
    });
    const firstComment = first.calls.comment[0] as { body: string };
    const retry = harness([tracker], {
      comments: [{ body: firstComment.body, performed_via_github_app: { id: 2729701 } }],
    });

    await runDatedTodoUpsert({
      github: retry.github,
      context: { repo: { owner: "openclaw", repo: "openclaw" } },
      core: retry.core,
      report: REPORT,
    });

    expect(retry.calls.comment).toHaveLength(0);
    expect(retry.calls.update).toHaveLength(1);
  });

  it("does not duplicate an urgent comment when the marker came from ClawSweeper", async () => {
    const tracker = issue(10, {
      trusted: true,
      body: `${MARKER}\n\n## OVERDUE\n\n## DUE within 30 days\n\n## FUTURE\n`,
    });
    const first = harness([tracker]);
    await runDatedTodoUpsert({
      github: first.github,
      context: { repo: { owner: "openclaw", repo: "openclaw" } },
      core: first.core,
      report: REPORT,
    });
    const firstComment = first.calls.comment[0] as { body: string };
    const retry = harness([tracker], {
      comments: [
        {
          body: firstComment.body,
          performed_via_github_app: { slug: "clawsweeper" },
        },
      ],
    });

    await runDatedTodoUpsert({
      github: retry.github,
      context: { repo: { owner: "openclaw", repo: "openclaw" } },
      core: retry.core,
      report: REPORT,
    });

    expect(retry.calls.comment).toHaveLength(0);
    expect(retry.calls.update).toHaveLength(1);
  });

  it("ignores a notification marker copied by an ordinary commenter", async () => {
    const tracker = issue(10, {
      trusted: true,
      body: `${MARKER}\n\n## OVERDUE\n\n## DUE within 30 days\n\n## FUTURE\n`,
    });
    const first = harness([tracker]);
    await runDatedTodoUpsert({
      github: first.github,
      context: { repo: { owner: "openclaw", repo: "openclaw" } },
      core: first.core,
      report: REPORT,
    });
    const firstComment = first.calls.comment[0] as { body: string };
    const spoofed = harness([tracker], { comments: [{ body: firstComment.body }] });

    await runDatedTodoUpsert({
      github: spoofed.github,
      context: { repo: { owner: "openclaw", repo: "openclaw" } },
      core: spoofed.core,
      report: REPORT,
    });

    expect(spoofed.calls.comment).toHaveLength(1);
  });

  it("creates a labeled tracker instead of overwriting an untrusted marker issue", async () => {
    const { calls, core, github } = harness([issue(99, { trusted: false })]);

    await runDatedTodoUpsert({
      github,
      context: { repo: { owner: "openclaw", repo: "openclaw" } },
      core,
      report: REPORT,
    });

    expect(calls.update).toHaveLength(0);
    expect(calls.create).toEqual([
      expect.objectContaining({ labels: ["dated-todo-sweep"], title: "Dated TODO sweep" }),
    ]);
  });
});

describe("dated TODO report validation", () => {
  it("accepts exact checklist entries and the explicit empty-section sentinel", () => {
    expect(() => validateDatedTodoReport(REPORT)).not.toThrow();
  });

  it.each([
    ["checked item", "- [x] src/urgent.ts:7 — remove expired compatibility (2026-07-01)"],
    ["missing checkbox", "src/urgent.ts:7 — remove expired compatibility (2026-07-01)"],
    ["invalid date", "- [ ] src/urgent.ts:7 — remove expired compatibility (2026-99-01)"],
  ])("rejects a malformed %s", (_name, malformed) => {
    expect(() =>
      validateDatedTodoReport(
        REPORT.replace(
          "- [ ] src/urgent.ts:7 — remove expired compatibility (2026-07-01)",
          malformed,
        ),
      ),
    ).toThrow(/Invalid dated TODO checklist item/u);
  });

  it.each([
    [
      "future date under OVERDUE",
      REPORT.replace("(2026-07-01)", "(2027-01-01)"),
      /Non-overdue date/u,
    ],
    [
      "past date under DUE",
      REPORT.replace(
        "## DUE within 30 days\n\n_None._",
        "## DUE within 30 days\n\n- [ ] src/due.ts:9 — revisit gate (2026-07-24)",
      ),
      /outside the 30-day due window/u,
    ],
    [
      "date beyond 30 days under DUE",
      REPORT.replace(
        "## DUE within 30 days\n\n_None._",
        "## DUE within 30 days\n\n- [ ] src/due.ts:9 — revisit gate (2026-08-25)",
      ),
      /outside the 30-day due window/u,
    ],
  ])("rejects a %s", (_name, report, expected) => {
    expect(() => validateDatedTodoReport(report)).toThrow(expected);
  });

  it("allows an old literal date in FUTURE for the prompt's ambiguous-retention rule", () => {
    const ambiguousFuture = REPORT.replace(
      "## FUTURE\n\n_None._",
      "## FUTURE\n\n- [ ] src/ambiguous.ts:11 — investigate ambiguous commitment (2026-07-01)",
    );

    expect(() => validateDatedTodoReport(ambiguousFuture)).not.toThrow();
  });

  it("binds the report date and file locations to the fresh checkout", () => {
    const verifiedReport = REPORT.replace("src/urgent.ts:7", "scripts/github/pr-ci-sweeper.mjs:1");

    expect(() =>
      validateDatedTodoReport(verifiedReport, {
        expectedDate: "2026-07-25",
        repoRoot: process.cwd(),
      }),
    ).not.toThrow();
    expect(() => validateDatedTodoReport(verifiedReport, { expectedDate: "2026-07-26" })).toThrow(
      /expected 2026-07-26/u,
    );
    expect(() =>
      validateDatedTodoReport(REPORT, {
        expectedDate: "2026-07-25",
        repoRoot: process.cwd(),
      }),
    ).toThrow(/Untracked or missing repository path/u);
  });

  it("accepts inert tracked-path grammar with spaces", () => {
    const report = REPORT.replace("src/urgent.ts:7", "docs/temporary note.md:7");

    expect(() => validateDatedTodoReport(report)).not.toThrow();
  });

  it.each([
    ["mention", "- [ ] src/urgent.ts:7 — notify @maintainers (2026-07-01)"],
    ["link", "- [ ] src/urgent.ts:7 — [review details](https://example.com) (2026-07-01)"],
    ["markup", "- [ ] src/urgent.ts:7 — remove **temporary** gate (2026-07-01)"],
  ])("rejects active Markdown in a %s", (_name, item) => {
    const report = REPORT.replace(
      "- [ ] src/urgent.ts:7 — remove expired compatibility (2026-07-01)",
      item,
    );

    expect(() => validateDatedTodoReport(report)).toThrow(/Non-plain-text summary/u);
  });

  it("allows underscores only inside plain identifiers", () => {
    const safe = REPORT.replace(
      "remove expired compatibility",
      "remove media_legacy compatibility",
    );
    const emphasized = REPORT.replace(
      "remove expired compatibility",
      "remove _expired_ compatibility",
    );

    expect(() => validateDatedTodoReport(safe)).not.toThrow();
    expect(() => validateDatedTodoReport(emphasized)).toThrow(/Non-plain-text summary/u);
  });

  it.each([
    ["URL", "- [ ] src/urgent.ts:7 — see https://example.com (2026-07-01)"],
    ["issue reference", "- [ ] src/urgent.ts:7 — follow up in #123 (2026-07-01)"],
    ["GH reference", "- [ ] src/urgent.ts:7 — follow up in GH-123 (2026-07-01)"],
  ])("rejects a GitHub autolink from a %s", (_name, item) => {
    const report = REPORT.replace(
      "- [ ] src/urgent.ts:7 — remove expired compatibility (2026-07-01)",
      item,
    );

    expect(() => validateDatedTodoReport(report)).toThrow(/Non-plain-text summary/u);
  });

  it("rejects unexpected report prologue content", () => {
    const report = REPORT.replace(
      "Generated for 2026-07-25 UTC.\n\n",
      "Generated for 2026-07-25 UTC.\n\n@maintainers\n\n",
    );

    expect(() => validateDatedTodoReport(report)).toThrow(/prologue or section order/u);
  });
});
