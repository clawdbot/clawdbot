import { once } from "node:events";
import fs from "node:fs";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTeamReportsHttpHandler } from "./http.js";
import { describePeriod } from "./periods.js";
import { renderMarkdown } from "./render/markdown.js";
import { createTeamReportsStore, type TeamReportsStore } from "./store.js";
import type { GithubCounts, Period, ReportDocument, SummaryDocument } from "./types.js";

const maliciousTitle = '<script>alert("report")</script>';
const counts: GithubCounts = {
  total: 1,
  commits: 1,
  prsOpened: 0,
  prsMerged: 0,
  prsClosed: 0,
  issuesOpened: 0,
  issuesClosed: 0,
  issueComments: 0,
  reviewComments: 0,
  securityAdvisories: 0,
  repos: { "example/project": 1 },
};

function report(period: Period, key: string, partial = false): ReportDocument {
  const descriptor = describePeriod(period, key);
  return {
    version: 1,
    period: descriptor,
    generatedAtMs: descriptor.untilMs,
    status: partial ? "partial" : "closed",
    orgs: ["example"],
    memberCount: 1,
    activeMembers: 1,
    totals: { github: counts, discord: { messages: 0, channels: {} } },
    members: [
      {
        login: "alice",
        display: "Alice",
        aliases: [],
        access: [],
        areas: [],
        github: {
          ...counts,
          items: [
            {
              kind: "commit",
              repo: "example/project",
              title: maliciousTitle,
              url: "javascript:alert(1)",
              actor: "alice",
              atMs: descriptor.sinceMs,
            },
          ],
        },
        discord: { total: 0, channels: {}, excerpts: [] },
      },
    ],
    otherActors: [],
    unmatchedDiscord: [],
    sources: { github: { ok: true, warnings: ["Fixture coverage warning"], stats: {} } },
  };
}

const summary: SummaryDocument = {
  source: "fallback",
  generatedAtMs: 1,
  globalSummary: "Collected **one contribution**.",
  highlights: ["A recorded commit."],
  fingerprint: "fixture",
};

type HttpResult = { status: number; headers: IncomingHttpHeaders; body: string };
let directory: string;
let store: TeamReportsStore;
let server: Server;
let port: number;
let available = true;

function fetchPath(
  url: string,
  method = "GET",
  headers: Record<string, string> = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: url, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

beforeAll(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "team-reports-http-"));
  store = createTeamReportsStore({ stateDir: directory });
  for (const document of [
    report("day", "2026-08-20"),
    report("day", "2026-08-21", true),
    report("week", "2026-W34"),
    report("month", "2026-08"),
  ]) {
    store.upsertPeriod({ report: document, summary, markdown: renderMarkdown(document, summary) });
  }
  const handler = createTeamReportsHttpHandler({
    basePath: "/reports",
    displayTimezone: "UTC",
    getStore: () => (available ? store : undefined),
    status: () => ({ running: false, lastRun: "fixture-run" }),
    people: () => [
      {
        github: ["alice", "alice-alias"],
        display: "Alice",
        status: "archived",
        archivedAt: "2026-08-22",
      },
    ],
  });
  server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP server address");
  }
  port = address.port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  store.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("Team Reports HTTP responses", () => {
  it("serves no-script escaped HTML with nonce-based CSP and safe navigation", async () => {
    const response = await fetchPath("/reports/day/2026-08-20/", "GET", {
      "x-forwarded-proto": "https",
    });
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["x-frame-options"]).toBeUndefined();
    const csp = response.headers["content-security-policy"];
    expect(csp).toContain("default-src 'none'");
    const nonce = typeof csp === "string" ? /style-src 'nonce-([^']+)'/.exec(csp)?.[1] : undefined;
    expect(nonce).toBeTruthy();
    expect(response.body).toContain(`<style nonce="${nonce}">`);
    expect(response.body).toContain("&lt;script&gt;alert(&quot;report&quot;)&lt;/script&gt;");
    expect(response.body).not.toContain("<script>");
    expect(response.body).not.toContain('href="javascript:');
    expect(response.body).toContain(
      `href="https://127.0.0.1:${port}/reports/day/2026-08-20/" target="_blank" rel="noopener">Open in a new window`,
    );
    expect(response.body).toContain('href="/reports/people/alice/"');
    expect(response.body).toContain("Deterministic summary");
    expect(response.body).toContain("Fixture coverage warning");
  });

  it("supports HEAD without a body and rejects writes", async () => {
    const head = await fetchPath("/reports/day/2026-08-20/", "HEAD");
    expect(head.status).toBe(200);
    expect(head.body).toBe("");
    expect(Number(head.headers["content-length"])).toBeGreaterThan(0);
    expect(head.headers["content-type"]).toBe("text/html; charset=utf-8");
    const post = await fetchPath("/reports/day/2026-08-20/", "POST");
    expect(post.status).toBe(405);
    expect(post.headers.allow).toBe("GET, HEAD");
  });

  it.each([
    "/reports/missing/",
    "/reports/day/2026-02-30/",
    "/reports/week/2026-W54/",
    "/reports/day/2026-08-20/unknown",
    "/reports/day/../2026-08-20/",
    "/reports/day/%2e%2e/2026-08-20/",
    "/reports/people/alice%2fextra/",
    "/reports/people/alice\\extra/",
    "/reports//",
    "/reports-elsewhere/",
  ])("returns 404 for unknown or unsafe path %s", async (url) => {
    const response = await fetchPath(url);
    expect(response.status).toBe(404);
    expect(response.headers["content-type"]).toBe("text/plain; charset=utf-8");
  });

  it("redirects latest to a closed day even when a newer partial exists", async () => {
    const response = await fetchPath("/reports/latest/");
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe("/reports/day/2026-08-20/");
  });

  it.each([
    ["day", "2026-08-20"],
    ["week", "2026-W34"],
    ["month", "2026-08"],
  ])("serves %s Markdown and canonical JSON", async (period, key) => {
    const markdown = await fetchPath(`/reports/${period}/${key}/report.md`);
    expect(markdown.status).toBe(200);
    expect(markdown.headers["content-type"]).toBe("text/markdown; charset=utf-8");
    expect(markdown.body).toContain(key);
    expect(markdown.body).not.toContain(maliciousTitle);
    const json = await fetchPath(`/reports/${period}/${key}/data.json`);
    expect(json.status).toBe(200);
    expect(json.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(JSON.parse(json.body)).toMatchObject({ version: 1, period: { period, key } });
  });

  it("renders stored trends, history, archived people, index, and status", async () => {
    const index = await fetchPath("/reports/");
    expect(index.status).toBe(200);
    expect(index.body).toContain('<svg viewBox="0 0 780 185"');
    expect(index.body).toContain('href="/reports/week/2026-W34/"');
    const people = await fetchPath("/reports/people/");
    expect(people.body).toContain("Archived");
    const person = await fetchPath("/reports/people/alice-alias/");
    expect(person.status).toBe(200);
    expect(person.body).toContain("Archived on 2026-08-22");
    expect(person.body).toContain('href="/reports/day/2026-08-20/"');
    const machineIndex = await fetchPath("/reports/index.json");
    expect(JSON.parse(machineIndex.body)).toMatchObject({
      latest: { day: "2026-08-21", week: "2026-W34", month: "2026-08" },
    });
    const status = await fetchPath("/reports/status");
    expect(JSON.parse(status.body)).toEqual({ running: false, lastRun: "fixture-run" });
  });

  it("reports unavailable service state without touching a closed store", async () => {
    available = false;
    try {
      const response = await fetchPath("/reports/");
      expect(response.status).toBe(503);
      expect(response.body).toContain("Start or restart the Gateway service");
    } finally {
      available = true;
    }
  });
});
