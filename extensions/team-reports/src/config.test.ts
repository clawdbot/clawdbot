import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildJsonPluginConfigSchema } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it } from "vitest";
import manifest from "../openclaw.plugin.json" with { type: "json" };
import { parseTeamReportsConfig, resolveTeamReportsConfig } from "./config.js";

const minimal = { github: { token: "fixture-token", orgs: ["acme"] } };
const documented = {
  basePath: "/reports/",
  displayTimezone: "America/Los_Angeles",
  github: {
    token: { source: "env", provider: "default", id: "TEAM_REPORTS_TEST_TOKEN" },
    orgs: ["acme"],
    teams: [{ org: "acme", slug: "maintainers" }],
    includeDirectCollaborators: true,
    excludeRepos: ["acme/archive"],
    apiBaseUrl: "https://git.example.com/api/v3",
    ignoreCommentPatterns: ["^automated status:"],
  },
  discord: {
    token: { source: "file", provider: "hostfile", id: "/discord_bot" },
    guildId: "123",
    channels: [{ id: "456", excerpts: true }, { id: "789" }],
    excerptMaxChars: 260,
  },
  people: [
    {
      github: ["alice", "alice-work"],
      display: "Alice",
      roleGroup: "maintainer",
      access: ["release"],
      areas: ["docs"],
      discordUserId: "1234",
      status: "active",
    },
  ],
  summaries: { enabled: true, model: "openai/gpt-5.6-sol", reasoning: "high", agentId: "main" },
  schedule: {
    closedDayUtc: "00:05",
    intradayEveryHours: 4,
    jitterMinutes: 5,
    weekly: true,
    monthly: true,
  },
  retention: { days: 400 },
};

const manifestSchema = buildJsonPluginConfigSchema(manifest.configSchema);
const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Team Reports configuration", () => {
  it("accepts the documented sources and preserves identity metadata with shared defaults", () => {
    const config = parseTeamReportsConfig(documented);
    expect(config.basePath).toBe("/reports");
    expect(config.people?.[0]).toMatchObject({
      github: ["alice", "alice-work"],
      roleGroup: "maintainer",
    });
    expect(config.discord?.channels[1]).toEqual({ id: "789", excerpts: false });
    expect(manifestSchema.safeParse?.(documented).success).toBe(true);
    const defaults = parseTeamReportsConfig(minimal);
    expect(defaults).toMatchObject({
      basePath: "/reports",
      displayTimezone: "UTC",
      github: { teams: [], includeDirectCollaborators: false, ignoreCommentPatterns: [] },
      summaries: { enabled: true },
      schedule: { closedDayUtc: "00:05", intradayEveryHours: 4 },
      retention: { days: 400 },
    });
    expect(manifestSchema.safeParse?.(minimal)).toMatchObject({ success: true, data: defaults });
  });

  it.each([
    { ...minimal, typo: true },
    { github: { ...minimal.github, secret: "wrong-field" } },
    { ...minimal, summaries: { invented: true } },
    { ...minimal, people: [{ github: ["alice"], privateFact: "unaccepted" }] },
    {
      ...minimal,
      discord: { token: "fixture", guildId: "123", channels: [{ id: "456", unknown: true }] },
    },
    { ...minimal, people: [], peopleFile: "/tmp/people.json" },
    { ...minimal, schedule: { closedDayUtc: "25:00" } },
  ])("rejects malformed or ambiguous config in both validation surfaces: %j", (value) => {
    expect(() => parseTeamReportsConfig(value)).toThrow();
    expect(manifestSchema.safeParse?.(value).success).toBe(false);
  });

  it.each([
    "reports",
    "/",
    "/.",
    "/..",
    "/api/channels",
    "/api/channels/discord",
    "/reports/../admin",
    "/reports/.",
    "/reports?x=1",
    "/reports/%2fadmin",
    "//reports",
  ])("rejects unsafe or reserved route root %s", (basePath) => {
    expect(() => parseTeamReportsConfig({ ...minimal, basePath })).toThrow();
    expect(manifestSchema.safeParse?.({ ...minimal, basePath }).success).toBe(false);
  });

  it("reserves a mounted Control UI subtree while allowing the default root UI", () => {
    expect(parseTeamReportsConfig(minimal, "/").basePath).toBe("/reports");
    expect(parseTeamReportsConfig(minimal, "/dashboard/").basePath).toBe("/reports");
    for (const basePath of ["/dashboard", "/dashboard/reports/"]) {
      expect(() => parseTeamReportsConfig({ ...minimal, basePath }, "/dashboard/")).toThrow(
        "Control UI base path",
      );
    }
  });

  it("rejects invalid IANA zones and comment regular expressions before starting collection", () => {
    expect(() => parseTeamReportsConfig({ ...minimal, displayTimezone: "Not/A_Zone" })).toThrow(
      "IANA time zone",
    );
    expect(() =>
      parseTeamReportsConfig({ github: { ...minimal.github, ignoreCommentPatterns: ["["] } }),
    ).toThrow("regular expression");
  });

  it("loads a bounded people artifact only when resolving startup configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "team-reports-config-"));
    temporaryDirectories.push(directory);
    const peopleFile = join(directory, "people.json");
    const people = [
      { github: ["alice", "alice-work"], status: "archived", archivedAt: "2026-08-01" },
    ];
    await writeFile(peopleFile, JSON.stringify({ people }));
    const config = parseTeamReportsConfig({ ...minimal, peopleFile });
    const resolved = await resolveTeamReportsConfig(config, {});
    expect(resolved.people).toEqual(people);
    expect(resolved.github.token).toBe("fixture-token");
    await writeFile(peopleFile, JSON.stringify({ people, unexpected: true }));
    await expect(resolveTeamReportsConfig(config, {})).rejects.toThrow();
    await writeFile(peopleFile, " ".repeat(2 * 1024 * 1024 + 1));
    await expect(resolveTeamReportsConfig(config, {})).rejects.toThrow("at most 2 MiB");
  });
});
