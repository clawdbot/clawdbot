import { once } from "node:events";
import fs from "node:fs";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTeamReportsHttpHandler } from "./http.js";
import { describePeriod } from "./periods.js";
import { renderMarkdown } from "./render/markdown.js";
import { githubCounts } from "./reports.fixtures.js";
import { createTeamReportsStore, type TeamReportsStore } from "./store.js";
import type { Period, Person, ReportDocument, SummaryDocument } from "./types.js";

const runtimeScopeMock = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/plugin-runtime", () => ({
  getPluginRuntimeGatewayRequestScope: runtimeScopeMock,
}));

const maliciousTitle = '<script>alert("report")</script>';
const hostileLogin = 'bad"><img src=x onerror=alert(1)>';
const hostileDisplay = '"Quoted <Name>';
const counts = githubCounts(1);
const avatarPeople: Person[] = [
  { github: ["invalid.login", "invalid-alias"], display: "Fallback Name" },
  { github: [hostileLogin, "hostile-alias"], display: hostileDisplay },
  { github: ["safe-login"], display: hostileDisplay },
  { github: ["a".repeat(40), "long-login-alias"], display: "Long Login" },
];

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
    otherActors: [{ login: "bob", github: counts }],
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
  warnings: ["Model summary unavailable: completion failed"],
};

type HttpResult = { status: number; headers: IncomingHttpHeaders; body: string };
let directory: string;
let store: TeamReportsStore;
let server: Server;
let port: number;
let available = true;
let currentOrgs = ["configured-example"];
const getStore = vi.fn(() => (available ? store : undefined));

beforeEach(() => {
  runtimeScopeMock.mockReturnValue({ client: { connect: { scopes: ["operator.read"] } } });
  getStore.mockClear();
  currentOrgs = ["configured-example"];
});

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
  const avatarReport = report("day", "2026-08-19");
  avatarReport.members = avatarPeople.map((person) => ({
    login: person.github[0] ?? "",
    display: person.display ?? "",
    aliases: person.github.slice(1),
    access: [],
    areas: [],
    github: { ...counts, items: [] },
    discord: { total: 0, channels: {}, excerpts: [] },
  }));
  avatarReport.memberCount = avatarPeople.length;
  avatarReport.activeMembers = avatarPeople.length;
  avatarReport.totals.github = githubCounts(avatarPeople.length);
  avatarReport.otherActors.push({ login: hostileLogin, github: counts });
  for (const document of [
    avatarReport,
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
    assetsDir: fileURLToPath(new URL("../assets", import.meta.url)),
    getStore,
    status: () => ({ running: false, lastRun: "fixture-run" }),
    health: () => ({ running: false, warnings: 1 }),
    orgs: () => currentOrgs,
    people: () => [
      {
        github: ["alice", "alice-alias"],
        display: "Alice",
        status: "archived",
        archivedAt: "2026-08-22",
        discordUserId: "1234567890",
      },
      ...avatarPeople,
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
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  store.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("Team Reports HTTP responses", () => {
  it.each([
    { context: "missing", scopes: undefined },
    { context: "empty", scopes: [] },
    { context: "approvals only", scopes: ["operator.approvals"] },
  ])(
    "denies GET and HEAD without read authority ($context) before store access",
    async ({ scopes }) => {
      runtimeScopeMock.mockReturnValue(scopes ? { client: { connect: { scopes } } } : undefined);
      for (const url of [
        "/reports/",
        "/reports/assets/crab.avif",
        "/reports/assets/icon.png",
        "/reports/status",
        "/reports/index.json",
        "/reports/latest/",
        "/reports/people/",
        "/reports/people/alice/",
        "/reports/day/2026-08-20/",
        "/reports/day/2026-08-20/report.md",
        "/reports/day/2026-08-20/data.json",
      ]) {
        for (const method of ["GET", "HEAD"]) {
          const response = await fetchPath(url, method);
          expect(response.status).toBe(403);
          expect(response.body).toBe(
            method === "HEAD" ? "" : "Forbidden: operator.read scope required.\n",
          );
          expect(response.headers["content-type"]).toBe("text/plain; charset=utf-8");
          expect(Number(response.headers["content-length"])).toBe(
            Buffer.byteLength("Forbidden: operator.read scope required.\n"),
          );
          expect(response.headers["cache-control"]).toBe("private, no-store");
          expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
          expect(response.headers["content-security-policy"]).toMatch(/style-src 'nonce-[^']+'/);
          expect(response.headers["x-content-type-options"]).toBe("nosniff");
          expect(response.headers["referrer-policy"]).toBe("no-referrer");
        }
      }
      expect(getStore).not.toHaveBeenCalled();
    },
  );

  it.each(["operator.read", "operator.write", "operator.admin"])(
    "allows GET and HEAD with %s authority",
    async (scope) => {
      runtimeScopeMock.mockReturnValue({ client: { connect: { scopes: [scope] } } });
      for (const method of ["GET", "HEAD"]) {
        const response = await fetchPath("/reports/day/2026-08-20/", method);
        expect(response.status).toBe(200);
        expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
        if (method === "HEAD") {
          expect(response.body).toBe("");
        } else {
          expect(response.body).toContain("Alice");
        }
      }
    },
  );

  it("serves escaped HTML with one nonce-authorized script and safe navigation", async () => {
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
    const nonce = typeof csp === "string" ? /style-src 'nonce-([^']+)'/.exec(csp)?.[1] : undefined;
    expect(nonce).toBeTruthy();
    expect(csp).toBe(
      `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src 'self' https://avatars.githubusercontent.com data:; base-uri 'none'; form-action 'none'`,
    );
    expect(response.body).toContain(`<style nonce="${nonce}">`);
    expect(response.body).toContain("&lt;script&gt;alert(&quot;report&quot;)&lt;/script&gt;");
    expect(response.body.match(/<script\b/g)).toHaveLength(1);
    expect(response.body).toContain(`<script nonce="${nonce}">`);
    expect(response.body).not.toContain('href="javascript:');
    expect(response.body).toContain(
      `href="https://127.0.0.1:${port}/reports/day/2026-08-20/" target="_blank" rel="noopener" data-report-open-window aria-label="Open in a new window"`,
    );
    expect(response.body).toContain('href="/reports/people/alice/"');
    expect(response.body).toContain("Deterministic summary");
    expect(response.body).toContain("Fixture coverage warning");
    expect(response.body).toContain("Model summary unavailable: completion failed");
    expect(response.body).toContain("GitHub coverage is incomplete");
  });

  it.each([
    { url: "/reports/day/2026-08-20/", login: "alice", size: 40, variant: "md" },
    { url: "/reports/day/2026-08-20/", login: "bob", size: 20, variant: "xs" },
    { url: "/reports/people/", login: "alice", size: 36, variant: "sm" },
    { url: "/reports/people/alice-alias/", login: "alice", size: 72, variant: "xl" },
  ])(
    "renders a $size px GitHub avatar for $login on $url",
    async ({ url, login, size, variant }) => {
      const response = await fetchPath(url);
      expect(response.status).toBe(200);
      const avatars = response.body.match(/<span class="oc-avatar\b[^>]*>[\s\S]*?<\/span>/g) ?? [];
      const avatar = avatars.find((markup) =>
        markup.includes(`src="https://avatars.githubusercontent.com/${login}?s=${size}"`),
      );
      expect(avatar).toContain(`class="oc-avatar oc-avatar-${variant}"`);
      expect(avatar).toMatch(/data-initials="[^"]+"/);
      for (const attribute of [
        `width="${size}"`,
        `height="${size}"`,
        'alt=""',
        'loading="lazy"',
        'decoding="async"',
        'referrerpolicy="no-referrer"',
      ]) {
        expect(avatar).toContain(attribute);
      }
      expect(response.body).not.toContain("avatars.githubusercontent.com/alice-alias");
      expect(response.body).not.toContain("avatars.githubusercontent.com/Alice");
      expect(response.body).not.toContain("avatars.githubusercontent.com/1234567890");
    },
  );

  it.each([
    { url: "/reports/day/2026-08-19/", initials: ["FN", "LL", "&quot;&lt;"] },
    { url: "/reports/people/", initials: ["FN", "LL", "&quot;&lt;"] },
    { url: "/reports/people/invalid-alias/", initials: ["FN"] },
    { url: "/reports/people/long-login-alias/", initials: ["LL"] },
    { url: "/reports/people/hostile-alias/", initials: ["&quot;&lt;"] },
  ])(
    "keeps unsafe avatar identities escaped and falls back to initials on $url",
    async ({ url, initials }) => {
      const response = await fetchPath(url);
      expect(response.status).toBe(200);
      const avatars = response.body.match(/<span class="oc-avatar\b[^>]*>[\s\S]*?<\/span>/g) ?? [];
      for (const value of initials) {
        const fallback = avatars.find(
          (avatar) => avatar.includes(`data-initials="${value}"`) && !avatar.includes("<img"),
        );
        expect(fallback).toBeDefined();
      }
      expect(response.body).not.toContain("avatars.githubusercontent.com/invalid.login");
      expect(response.body).not.toContain(`avatars.githubusercontent.com/${"a".repeat(40)}`);
      expect(response.body).not.toContain("avatars.githubusercontent.com/bad");
      expect(response.body).not.toContain(hostileLogin);
      expect(response.body).not.toContain(hostileDisplay);
      expect(response.body).not.toContain("<img src=x");
      if (!url.includes("invalid-alias") && !url.includes("long-login-alias")) {
        expect(response.body).toContain("bad&quot;&gt;&lt;img src=x onerror=alert(1)&gt;");
        expect(response.body).toContain("&quot;Quoted &lt;Name&gt;");
        expect(response.body).toContain('data-initials="&quot;&lt;"');
      }
    },
  );

  it("uses the GitHub login for an avatar even when the display name is hostile", async () => {
    const response = await fetchPath("/reports/people/safe-login/");
    expect(response.status).toBe(200);
    expect(response.body).toContain('src="https://avatars.githubusercontent.com/safe-login?s=72"');
    expect(response.body).toContain('data-initials="&quot;&lt;"');
    expect(response.body).toContain("&quot;Quoted &lt;Name&gt;");
    expect(response.body).not.toContain(hostileDisplay);
  });

  it("serves dark and light semantic tokens with CSS-only avatar initials", async () => {
    const response = await fetchPath("/reports/");
    const styles = /<style nonce="[^"]+">([\s\S]*?)<\/style>/.exec(response.body)?.[1];
    expect(styles).toMatch(/color-scheme:\s*dark/);
    expect(styles).toMatch(/html\[data-theme="light"\]\s*\{[^}]*color-scheme:\s*light/);
    expect(styles).toMatch(
      /@media\s*\(prefers-color-scheme:\s*light\)\s*\{[^}]*color-scheme:\s*light/,
    );
    for (const token of [
      "bg-page",
      "text-primary",
      "accent-primary",
      "accent-secondary",
      "status-warning-fg",
    ]) {
      expect(styles?.match(new RegExp(`--oc-${token}:`, "g"))?.length).toBeGreaterThanOrEqual(3);
    }
    expect(styles).toMatch(/\.oc-avatar::before\s*\{[^}]*content:\s*attr\(data-initials\)/);
    expect(styles).not.toMatch(/@import|@font-face/);
  });

  it.each([
    ["crab.avif", "image/avif"],
    ["icon.png", "image/png"],
  ])("serves authenticated %s bytes with private caching and HEAD", async (asset, contentType) => {
    const get = await fetchPath(`/reports/assets/${asset}`);
    const head = await fetchPath(`/reports/assets/${asset}`, "HEAD");
    for (const response of [get, head]) {
      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toBe(contentType);
      expect(response.headers["cache-control"]).toBe("private, max-age=86400");
      expect(Number(response.headers["content-length"])).toBe(
        fs.statSync(new URL(`../assets/${asset}`, import.meta.url)).size,
      );
    }
    expect(get.body.length).toBeGreaterThan(0);
    expect(head.body).toBe("");
    expect(head.headers["content-length"]).toBe(get.headers["content-length"]);
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
    "/reports/assets/unknown.png",
    "/reports/assets/crab.avif/extra",
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
    expect(markdown.body).toContain("> Model summary unavailable: completion failed\n");
    const json = await fetchPath(`/reports/${period}/${key}/data.json`);
    expect(json.status).toBe(200);
    expect(json.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(JSON.parse(json.body)).toMatchObject({ version: 1, period: { period, key } });
  });

  it("renders stored trends, history, archived people, index, and status", async () => {
    const index = await fetchPath("/reports/");
    expect(index.status).toBe(200);
    expect(index.body).toContain('aria-label="Activity dateline"');
    expect(index.body).toContain('href="/reports/week/2026-W34/"');
    const people = await fetchPath("/reports/people/");
    expect(people.body).toContain("Member Activity Timelines");
    expect(people.body).toMatch(/class="oc-badge oc-badge-neutral">Archived<\/span>/);
    const person = await fetchPath("/reports/people/alice-alias/");
    expect(person.status).toBe(200);
    expect(person.body).toContain("Archived on 2026-08-22");
    expect(person.body).toContain('href="/reports/day/2026-08-20/?person=alice"');
    const machineIndex = await fetchPath("/reports/index.json");
    expect(JSON.parse(machineIndex.body)).toMatchObject({
      latest: { day: "2026-08-21", week: "2026-W34", month: "2026-08" },
    });
    const status = await fetchPath("/reports/status");
    expect(JSON.parse(status.body)).toEqual({ running: false, lastRun: "fixture-run" });
  });

  it("reads current overview organizations and prefers the displayed report's organizations", async () => {
    const emptyStore = createTeamReportsStore({ stateDir: path.join(directory, "empty") });
    try {
      for (const name of ["first-organization", "new <organization>"]) {
        currentOrgs = [name];
        getStore.mockReturnValueOnce(emptyStore);
        const response = await fetchPath("/reports/");
        expect(response.status).toBe(200);
        expect(response.body).toContain(
          name.replaceAll("<", "&lt;").replaceAll(">", "&gt;") + " · team",
        );
      }
      const stored = await fetchPath("/reports/");
      expect(stored.body).toContain("example · team");
      expect(stored.body).not.toContain("new &lt;organization&gt; · team");
    } finally {
      emptyStore.close();
    }
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
