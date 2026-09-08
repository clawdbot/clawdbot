import { afterEach, describe, expect, it, vi } from "vitest";
import { completion, githubCounts as counts, type Complete } from "./reports.fixtures.js";
import { generateSummaries } from "./summaries.js";
import type { PersonReport, ReportDocument } from "./types.js";

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

afterEach(() => vi.restoreAllMocks());

describe("team report summaries", () => {
  it.each([
    [1, 4300],
    [52, 19600],
    [100, 32000],
  ])("budgets both attempts for %i roster members at %i tokens", async (size, maxTokens) => {
    const input = report();
    input.members = Array.from({ length: size }, (_, index) => member(`member-${index}`));
    input.memberCount = size;
    const output = {
      ...response(),
      members: input.members.map(({ login }) => ({
        login,
        summary: "No visible activity was recorded.",
        confidence: "low",
      })),
    };
    const complete = vi
      .fn<Complete>()
      .mockResolvedValueOnce(completion('{"globalSummary":"truncated'))
      .mockResolvedValueOnce(completion(JSON.stringify(output)));
    const logger = { warn: vi.fn() };
    const result = await generateSummaries({
      report: input,
      options: { enabled: true },
      llm: { complete },
      logger,
    });
    expect(complete.mock.calls.map(([params]) => params.maxTokens)).toEqual([maxTokens, maxTokens]);
    expect(result.summary.source).toBe("model");
    expect(result.report.members.every((entry) => entry.summary?.source === "model")).toBe(true);
    expect(result.summary.warnings).toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each([false, true])("accepts complete JSON output (fenced: %s)", async (fenced) => {
    vi.spyOn(Date, "now").mockReturnValue(20);
    const json = JSON.stringify(response());
    const complete = vi
      .fn<Complete>()
      .mockResolvedValue(completion(fenced ? `\`\`\`json\n${json}\n\`\`\`` : json));
    const result = await generateSummaries({
      report: report(),
      options: { enabled: true, reasoning: "high", model: "openai/gpt-5.6-sol" },
      llm: { complete },
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

  it.each([
    ["truncated JSON", '{"globalSummary":"private-response-marker', "response appears truncated"],
    [
      "invalid JSON",
      '{"globalSummary": private-response-marker}',
      "invalid JSON after repair: Response must contain one valid JSON object",
    ],
    [
      "unexpected key",
      JSON.stringify({ ...response(), "private-response-marker": true }),
      "invalid JSON after repair: response: unrecognized_keys",
    ],
    [
      "unexpected member",
      JSON.stringify({
        ...response(),
        members: [{ login: "private-response-marker", summary: "Private", confidence: "low" }],
      }),
      "invalid JSON after repair: Unexpected member login",
    ],
  ])("warns once after invalid output and repair (%s)", async (_kind, raw, cause) => {
    const input = report();
    const complete = vi.fn<Complete>().mockResolvedValue(completion(raw));
    const logger = { warn: vi.fn() };
    const result = await generateSummaries({
      report: input,
      options: { enabled: true },
      llm: { complete },
      logger,
    });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(result.summary.source).toBe("fallback");
    expect(result.summary.warnings).toEqual([expect.stringContaining(cause)]);
    expect(result.summary.warnings?.[0]?.length).toBeLessThanOrEqual(300);
    expect(logger.warn.mock.calls).toEqual([[result.summary.warnings?.[0]]]);
    expect(JSON.stringify([result.summary, logger.warn.mock.calls])).not.toContain(
      "private-response-marker",
    );
    expect(result.report.members[0]?.github.items).toEqual(input.members[0]?.github.items);
    expect(result.report.members[1]?.summary).toMatchObject({
      source: "fallback",
      confidence: "low",
    });
    expect(result.report.members[1]?.summary?.text).toContain("No visible activity");
    expect(input.members[0]?.summary).toBeUndefined();
  });

  it("warns on completion failure without retaining provider error bodies", async () => {
    const complete = vi
      .fn<Complete>()
      .mockRejectedValue(new Error("private-provider-error-marker"));
    const logger = { warn: vi.fn() };
    const result = await generateSummaries({
      report: report(),
      options: { enabled: true },
      llm: { complete },
      logger,
    });
    expect(result.summary.warnings).toEqual(["Model summary unavailable: completion failed"]);
    expect(logger.warn.mock.calls).toEqual([["Model summary unavailable: completion failed"]]);
    expect(JSON.stringify(result)).not.toContain("private-provider-error-marker");
    expect(complete).toHaveBeenCalledOnce();
    const disabled = await generateSummaries({
      report: report(),
      options: { enabled: false },
      llm: { complete },
      logger,
      previous: result,
    });
    expect(disabled.summary.warnings).toBeUndefined();
    expect(complete).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it("uses deterministic fallback without calling a model when summaries are disabled", async () => {
    vi.spyOn(Date, "now").mockReturnValue(20);
    const complete = vi.fn<Complete>();
    const input = report();
    input.sources.github = { ok: false, warnings: ["Collection incomplete"], stats: {} };
    const params = { report: input, options: { enabled: false }, llm: { complete } };
    const first = await generateSummaries(params);
    const second = await generateSummaries(params);
    expect(first).toEqual(second);
    expect(first.summary.globalSummary).toContain("Source coverage has gaps");
    expect(first.report.members).toHaveLength(2);
    expect(first.summary.warnings).toBeUndefined();
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

  it("retries the model when the stored summary is a fallback for the same evidence", async () => {
    const complete = vi
      .fn<Complete>()
      .mockRejectedValueOnce(new Error("provider unavailable"))
      .mockResolvedValue(completion(JSON.stringify(response())));
    const first = await generateSummaries({
      report: report(),
      options: { enabled: true },
      llm: { complete },
    });
    expect(first.summary.source).toBe("fallback");
    expect(first.summary.warnings).toHaveLength(1);
    const next = await generateSummaries({
      report: report(),
      options: { enabled: true },
      llm: { complete },
      previous: first,
    });
    expect(next.reused).toBe(false);
    expect(next.summary.source).toBe("model");
    expect(next.summary.warnings).toBeUndefined();
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("reuses a stored model summary for unchanged evidence when summaries are disabled", async () => {
    const complete = vi.fn<Complete>().mockResolvedValue(completion(JSON.stringify(response())));
    const first = await generateSummaries({
      report: report(),
      options: { enabled: true },
      llm: { complete },
    });
    const next = await generateSummaries({
      report: report(),
      options: { enabled: false },
      llm: { complete },
      previous: first,
    });
    expect(next.reused).toBe(true);
    expect(next.summary.source).toBe("model");
    expect(complete).toHaveBeenCalledOnce();
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
