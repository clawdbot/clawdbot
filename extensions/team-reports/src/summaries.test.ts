import { describe, expect, it, vi } from "vitest";
import { buildEvidenceDigest, generateSummaries } from "./summaries.js";
import type { GithubCounts, PersonReport, ReportDocument } from "./types.js";

type Complete = Parameters<typeof generateSummaries>[0]["llm"]["complete"];

function counts(): GithubCounts {
  return {
    total: 0,
    commits: 0,
    prsOpened: 0,
    prsMerged: 0,
    prsClosed: 0,
    issuesOpened: 0,
    issuesClosed: 0,
    issueComments: 0,
    reviewComments: 0,
    securityAdvisories: 0,
    repos: {},
  };
}

function member(login: string): PersonReport {
  return {
    login,
    display: login,
    access: [],
    areas: [],
    aliases: [],
    github: { ...counts(), items: [] },
    discord: { total: 0, channels: {}, excerpts: [] },
  };
}

function report(): ReportDocument {
  const alex = member("alex");
  alex.github.total = 1;
  alex.github.commits = 1;
  alex.github.repos = { "sample/widgets": 1 };
  alex.github.items = [
    {
      kind: "commit",
      repo: "sample/widgets",
      title: "Correct the widget resize calculation",
      url: "https://github.com/sample/widgets/commit/abc",
      actor: "alex",
      atMs: Date.parse("2026-08-20T12:00:00Z"),
    },
  ];
  return {
    version: 1,
    period: {
      period: "day",
      key: "2026-08-20",
      sinceMs: Date.parse("2026-08-20T00:00:00Z"),
      untilMs: Date.parse("2026-08-21T00:00:00Z"),
      title: "August 20, 2026",
    },
    generatedAtMs: 1,
    status: "closed",
    orgs: ["sample"],
    memberCount: 2,
    activeMembers: 1,
    totals: {
      github: { ...counts(), total: 1, commits: 1 },
      discord: { messages: 0, channels: {} },
    },
    members: [alex, member("blair")],
    otherActors: [],
    unmatchedDiscord: [],
    sources: { github: { ok: true, warnings: [], stats: {} } },
  };
}

function response() {
  return {
    globalSummary:
      "One member corrected widget resizing. The other member has no recorded activity.\n\n- **Widgets:** Corrected resize calculations.\n- **Reviews:** None recorded.\n- **Discord:** No messages recorded.\n- **Coverage:** GitHub collection succeeded.",
    highlights: [
      "Widget resize calculation corrected.",
      "No review comments were recorded.",
      "No Discord messages were recorded.",
      "One member has no recorded activity.",
    ],
    members: [
      {
        login: "alex",
        summary: "Corrected widget resizing in sample/widgets.",
        confidence: "high",
      },
      { login: "blair", summary: "No visible activity was recorded.", confidence: "low" },
    ],
  };
}

function completion(text: string): Awaited<ReturnType<Complete>> {
  return {
    text,
    provider: "openai",
    model: "gpt-5.6-sol",
    agentId: "main",
    usage: {},
    execution: { mode: "direct-provider", owner: { kind: "provider", id: "openai" } },
    audit: { caller: { kind: "plugin", id: "team-reports" } },
  };
}

describe("team report summaries", () => {
  it.each([false, true])("accepts complete JSON output (fenced: %s)", async (fenced) => {
    const json = JSON.stringify(response());
    const complete = vi
      .fn<Complete>()
      .mockResolvedValue(completion(fenced ? `\`\`\`json\n${json}\n\`\`\`` : json));
    const result = await generateSummaries({
      report: report(),
      options: { enabled: true, reasoning: "high", model: "openai/gpt-5.6-sol" },
      llm: { complete },
      nowMs: 20,
    });
    expect(result.summary).toMatchObject({
      source: "model",
      model: "openai/gpt-5.6-sol",
      generatedAtMs: 20,
    });
    expect(result.report.members.map(({ login, summary }) => ({ login, summary }))).toEqual([
      {
        login: "alex",
        summary: { text: response().members[0]?.summary, confidence: "high", source: "model" },
      },
      {
        login: "blair",
        summary: { text: response().members[1]?.summary, confidence: "low", source: "model" },
      },
    ]);
    expect(complete).toHaveBeenCalledOnce();
  });

  it.each(["missing", "duplicate", "unexpected"])(
    "repairs valid JSON with %s member coverage",
    async (kind) => {
      const incomplete = response();
      if (kind === "missing") {
        incomplete.members.pop();
      } else if (kind === "duplicate") {
        incomplete.members.push({ login: "alex", summary: "Duplicate.", confidence: "high" });
      } else {
        incomplete.members.push({ login: "outsider", summary: "Unrequested.", confidence: "high" });
      }
      const complete = vi
        .fn<Complete>()
        .mockResolvedValueOnce(completion(JSON.stringify(incomplete)))
        .mockResolvedValueOnce(completion(JSON.stringify(response())));
      const result = await generateSummaries({
        report: report(),
        options: { enabled: true },
        llm: { complete },
      });
      expect(result.summary.source).toBe("model");
      expect(result.report.members.every((entry) => entry.summary?.source === "model")).toBe(true);
      expect(complete).toHaveBeenCalledTimes(2);
      expect(complete.mock.calls[1]?.[0].messages.at(-1)?.content).toContain("member login");
    },
  );

  it("retries invalid output once then retains evidence and quiet-member fallback notes", async () => {
    const input = report();
    const complete = vi.fn<Complete>().mockResolvedValue(completion("invalid JSON"));
    const result = await generateSummaries({
      report: input,
      options: { enabled: true },
      llm: { complete },
    });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(result.summary.source).toBe("fallback");
    expect(result.report.members[0]?.github.items).toEqual(input.members[0]?.github.items);
    expect(result.report.members[1]?.summary).toMatchObject({
      source: "fallback",
      confidence: "low",
    });
    expect(result.report.members[1]?.summary?.text).toContain("No visible activity");
    expect(input.members[0]?.summary).toBeUndefined();
  });

  it("uses deterministic fallback without calling a model when summaries are disabled", async () => {
    const complete = vi.fn<Complete>();
    const input = report();
    input.sources.github = { ok: false, warnings: ["Collection incomplete"], stats: {} };
    const params = { report: input, options: { enabled: false }, llm: { complete }, nowMs: 20 };
    const first = await generateSummaries(params);
    const second = await generateSummaries(params);
    expect(first).toEqual(second);
    expect(first.summary.globalSummary).toContain("Source coverage has gaps");
    expect(first.report.members).toHaveLength(2);
    expect(complete).not.toHaveBeenCalled();
  });

  it("reuses an unchanged fingerprint and restores stored member prose onto fresh evidence", async () => {
    const complete = vi.fn<Complete>().mockResolvedValue(completion(JSON.stringify(response())));
    const first = await generateSummaries({
      report: report(),
      options: { enabled: true },
      llm: { complete },
    });
    const fresh = report();
    fresh.generatedAtMs = 12345;
    fresh.sources.github.stats.apiCalls = 100;
    fresh.members.reverse();
    const next = await generateSummaries({
      report: fresh,
      options: { enabled: true },
      llm: { complete },
      previous: first,
    });
    expect(complete).toHaveBeenCalledOnce();
    expect(next.reused).toBe(true);
    expect(next.summary.fingerprint).toBe(first.summary.fingerprint);
    expect(next.report.generatedAtMs).toBe(12345);
    expect(next.report.members.find((entry) => entry.login === "alex")?.summary?.text).toBe(
      response().members[0]?.summary,
    );
  });

  it("regenerates when a source gap changes even if activity counts do not", async () => {
    const complete = vi.fn<Complete>().mockResolvedValue(completion(JSON.stringify(response())));
    const first = await generateSummaries({
      report: report(),
      options: { enabled: true },
      llm: { complete },
    });
    const fresh = report();
    fresh.sources.github.warnings.push("One repository could not be read");
    const next = await generateSummaries({
      report: fresh,
      options: { enabled: true },
      llm: { complete },
      previous: first,
    });
    expect(next.reused).toBe(false);
    expect(next.summary.fingerprint).not.toBe(first.summary.fingerprint);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("bounds member evidence and excludes raw comment bodies from model input", async () => {
    const input = report();
    const alex = input.members[0];
    if (!alex) {
      throw new Error("Missing fixture member");
    }
    alex.github.items = Array.from({ length: 100 }, (_, index) => ({
      kind: "issue_comment",
      repo: "sample/widgets",
      title: `Public summary ${index}`,
      body: "RAW BODY MUST NOT REACH THE MODEL",
      url: `https://github.com/sample/widgets/issues/1#comment-${index}`,
      actor: "alex",
      atMs: index,
    }));
    const complete = vi.fn<Complete>().mockResolvedValue(completion(JSON.stringify(response())));
    await generateSummaries({ report: input, options: { enabled: true }, llm: { complete } });
    const digest = complete.mock.calls[0]?.[0].messages[1]?.content;
    expect(digest).not.toContain("RAW BODY");
    expect(digest).toContain("Public summary 99");
    expect(digest).not.toContain('"title":"Public summary 19"');
    expect(buildEvidenceDigest(input)).toBe(digest);
  });

  it("propagates cancellation and does not return a late model result or start a repair", async () => {
    const controller = new AbortController();
    const complete = vi.fn<Complete>().mockImplementation(async ({ signal }) => {
      expect(signal).toBe(controller.signal);
      controller.abort(new Error("Run deadline reached"));
      return completion(JSON.stringify(response()));
    });
    await expect(
      generateSummaries({
        report: report(),
        options: { enabled: true },
        llm: { complete },
        signal: controller.signal,
      }),
    ).rejects.toThrow("Run deadline reached");
    expect(complete).toHaveBeenCalledOnce();
  });
});
