import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { TLSSocket } from "node:tls";
import { describePeriod } from "./periods.js";
import {
  renderIndexPage,
  renderPeoplePage,
  renderPersonPage,
  renderReportPage,
  type PageContext,
  type PeriodIndex,
} from "./render/html.js";
import type { TeamReportsStore } from "./store.js";
import type { Period, Person, PersonReport } from "./types.js";

type TeamReportsHttpOptions = {
  basePath: string;
  displayTimezone: string;
  getStore: () => TeamReportsStore | undefined;
  status: () => unknown;
  people: () => Person[];
};

const DAY_MS = 86_400_000;
const KEY_PATTERNS: Record<Period, RegExp> = {
  day: /^\d{4}-\d{2}-\d{2}$/,
  week: /^\d{4}-W\d{2}$/,
  month: /^\d{4}-\d{2}$/,
};

function pathSegments(
  rawUrl: string,
  basePath: string,
): { path: string; segments: string[] } | undefined {
  // WHATWG URL normalization removes dot segments, so validate the request target first.
  const path = rawUrl.split("?")[0] ?? "";
  if (path !== basePath && !path.startsWith(`${basePath}/`)) {
    return undefined;
  }
  const relative = path.slice(basePath.length);
  const segments = relative.split("/").slice(1);
  if (segments.at(-1) === "") {
    segments.pop();
  }
  if (
    segments.some(
      (segment) => !/^[A-Za-z0-9._-]+$/.test(segment) || segment === "." || segment === "..",
    )
  ) {
    return undefined;
  }
  return { path, segments };
}

function absolutePageUrl(req: IncomingMessage, path: string): string | undefined {
  const host = req.headers.host;
  if (!host || !/^(?:[A-Za-z0-9.-]+|\[[A-Fa-f0-9:]+\])(?::\d{1,5})?$/.test(host)) {
    return undefined;
  }
  const secure = req.socket instanceof TLSSocket || req.headers["x-forwarded-proto"] === "https";
  try {
    return new URL(path, `${secure ? "https" : "http"}://${host}`).href;
  } catch {
    return undefined;
  }
}

function personFromReport(member: PersonReport): Person {
  return {
    github: [member.login, ...member.aliases],
    display: member.display,
    affiliation: member.affiliation,
    roleGroup: member.roleGroup,
    roleLabel: member.roleLabel,
    access: member.access,
    areas: member.areas,
  };
}

function visiblePeople(configured: Person[], recentReports: PersonReport[]): Person[] {
  const aliases = new Set(
    configured.flatMap((person) => person.github.map((login) => login.toLowerCase())),
  );
  const result = [...configured];
  for (const member of recentReports) {
    if (aliases.has(member.login.toLowerCase())) {
      continue;
    }
    const person = personFromReport(member);
    result.push(person);
    for (const login of person.github) {
      aliases.add(login.toLowerCase());
    }
  }
  return result.toSorted((a, b) =>
    (a.display ?? a.github[0] ?? "").localeCompare(b.display ?? b.github[0] ?? ""),
  );
}

export function createTeamReportsHttpHandler(options: TeamReportsHttpOptions) {
  return (req: IncomingMessage, res: ServerResponse): boolean => {
    const nonce = randomBytes(16).toString("base64url");
    const send = (
      status: number,
      contentType: string,
      body: string,
      headers: Record<string, string> = {},
    ) => {
      res.writeHead(status, {
        "Content-Type": `${contentType}; charset=utf-8`,
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "private, no-store",
        "Content-Security-Policy": `default-src 'none'; style-src 'nonce-${nonce}'; img-src https://avatars.githubusercontent.com data:; base-uri 'none'; form-action 'none'`,
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        ...headers,
      });
      res.end(req.method === "HEAD" ? undefined : body);
      return true;
    };
    const notFound = () => send(404, "text/plain", "Not found\n");
    if (req.method !== "GET" && req.method !== "HEAD") {
      return send(405, "text/plain", "Method not allowed\n", { Allow: "GET, HEAD" });
    }
    const route = pathSegments(req.url ?? "", options.basePath);
    if (!route) {
      return notFound();
    }
    const store = options.getStore();
    if (!store) {
      return send(
        503,
        "text/plain",
        "Team Reports is not running. Start or restart the Gateway service.\n",
      );
    }
    const [first, key, format] = route.segments;
    const json = (body: unknown) => send(200, "application/json", JSON.stringify(body));
    if (first === "status" && route.segments.length === 1) {
      return json(options.status());
    }
    const index = (): PeriodIndex => ({
      day: store.listPeriods({ period: "day", limit: 60 }),
      week: store.listPeriods({ period: "week", limit: 60 }),
      month: store.listPeriods({ period: "month", limit: 60 }),
    });
    if (first === "latest" && route.segments.length === 1) {
      const closed = store.listPeriods({ period: "day", status: "closed", limit: 1 })[0];
      if (closed) {
        return send(302, "text/plain", "Redirecting to the latest closed day.\n", {
          Location: `${options.basePath}/day/${closed.key}/`,
        });
      }
      return notFound();
    }
    if (first === "index.json" && route.segments.length === 1) {
      const periods = index();
      return json({
        latest: {
          day: periods.day[0]?.key ?? null,
          week: periods.week[0]?.key ?? null,
          month: periods.month[0]?.key ?? null,
        },
        periods,
      });
    }
    const absoluteUrl = absolutePageUrl(req, route.path);
    if (!absoluteUrl) {
      return send(400, "text/plain", "A valid Host header is required.\n");
    }
    const ctx: PageContext = {
      basePath: options.basePath,
      displayTimezone: options.displayTimezone,
      nonce,
      absoluteUrl,
    };
    const html = (body: string) => send(200, "text/html", body);
    if (route.segments.length === 0) {
      const periods = index();
      const latest = periods.day[0];
      const days = latest ? store.getDayReports(latest.sinceMs - 27 * DAY_MS, latest.untilMs) : [];
      return html(renderIndexPage(ctx, periods, days));
    }
    if (first === "people" && route.segments.length <= 2) {
      const latest = store.listPeriods({ period: "day", limit: 1 })[0];
      const recent = latest ? (store.getPeriod("day", latest.key)?.report.members ?? []) : [];
      const people = visiblePeople(options.people(), recent);
      if (!key) {
        return html(renderPeoplePage(ctx, people));
      }
      const person = people.find((candidate) =>
        candidate.github.some((login) => login.toLowerCase() === key.toLowerCase()),
      );
      const login = person?.github[0] ?? key;
      const latestDay = store.listPersonDays(login, { limit: 1 })[0];
      const since = latestDay
        ? new Date(Date.parse(`${latestDay.dayKey}T00:00:00Z`) - 27 * DAY_MS)
            .toISOString()
            .slice(0, 10)
        : undefined;
      const days = latestDay ? store.listPersonDays(login, { since, limit: 28 }) : [];
      if (!person && days.length === 0) {
        return notFound();
      }
      return html(renderPersonPage(ctx, person ?? { github: [key] }, days));
    }
    if (
      (first === "day" || first === "week" || first === "month") &&
      key &&
      route.segments.length <= 3
    ) {
      if (
        !KEY_PATTERNS[first].test(key) ||
        (format !== undefined && format !== "report.md" && format !== "data.json")
      ) {
        return notFound();
      }
      try {
        describePeriod(first, key);
      } catch {
        return notFound();
      }
      const stored = store.getPeriod(first, key);
      if (!stored) {
        return notFound();
      }
      if (format === "data.json") {
        return json(stored.report);
      }
      if (format === "report.md") {
        return send(200, "text/markdown", stored.markdown);
      }
      return html(renderReportPage(ctx, stored.report, stored.summary));
    }
    return notFound();
  };
}
