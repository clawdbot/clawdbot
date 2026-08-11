import { describe, expect, it, vi } from "vitest";
import type { OfficialExternalPluginCatalogEntry } from "../plugins/official-external-plugin-catalog.js";
import { defaultRuntime } from "../runtime.js";
import { getSetupAppRecommendations, type SetupAppScanPhase } from "./setup-app-recommendations.js";

/** Force an "ok" result so the returned candidate `groups` can be asserted. */
function completeMatching(
  pairs: Array<{ appLabel: string; candidateId: string }>,
): (prompt: string) => Promise<{ ok: true; text: string }> {
  return async () => ({
    ok: true,
    text: JSON.stringify({
      matches: pairs.map((pair) => ({ ...pair, tier: "optional", reason: "match" })),
    }),
  });
}

function officialEntry(params: {
  id: string;
  label: string;
  description: string;
  kind?: "channel" | "provider";
}): OfficialExternalPluginCatalogEntry {
  return {
    id: params.id,
    description: params.description,
    openclaw: {
      plugin: { id: params.id, label: params.label },
      ...(params.kind === "channel" ? { channel: { id: params.id, label: params.label } } : {}),
      ...(params.kind === "provider" ? { providers: [{ id: params.id, name: params.label }] } : {}),
    },
  };
}

describe("setup app recommendation candidates", () => {
  it("reports candidate and matching phases for the normalized app inventory", async () => {
    const phases: SetupAppScanPhase[] = [];

    await getSetupAppRecommendations({
      inventorySource: async () => [
        { label: "Zulu" },
        { label: "alpha" },
        { label: "Echo" },
        { label: "Bravo" },
      ],
      runtime: defaultRuntime,
      onPhase: (phase) => phases.push(phase),
      deps: {
        listPlugins: () => [],
        listChannels: () => [],
        listProviders: () => [],
        searchSkills: async ({ query }) => [
          {
            score: 1,
            slug: `${query.toLocaleLowerCase("en-US")}-tools`,
            ownerHandle: "demo-owner",
            displayName: `${query} Tools`,
          },
        ],
        complete: completeMatching([{ appLabel: "alpha", candidateId: "@demo-owner/alpha-tools" }]),
      },
    });

    expect(phases).toEqual([
      {
        kind: "candidates",
        appCount: 4,
        sampleLabels: ["alpha", "Bravo", "Echo"],
      },
      { kind: "matching", appCount: 4 },
    ]);
  });

  it.each([
    {
      reason: "unsupported",
      inventory: { status: "unsupported" as const, platform: "linux" as const, apps: [] as [] },
    },
    { reason: "no-apps", inventory: [] },
  ])("does not report phases when the scan skips for $reason", async ({ inventory }) => {
    const onPhase = vi.fn();

    await getSetupAppRecommendations({
      inventorySource: async () => inventory,
      runtime: defaultRuntime,
      onPhase,
    });

    expect(onPhase).not.toHaveBeenCalled();
  });

  it("preserves the ClawHub publisher in candidate ids", async () => {
    const result = await getSetupAppRecommendations({
      inventorySource: async () => [{ label: "Notes" }],
      runtime: defaultRuntime,
      deps: {
        listPlugins: () => [],
        listChannels: () => [],
        listProviders: () => [],
        searchSkills: async () => [
          {
            score: 1,
            slug: "notes-tools",
            ownerHandle: "demo-owner",
            displayName: "Notes Tools",
          },
          {
            score: 0.9,
            slug: "notes-tools",
            ownerHandle: "other-owner",
            displayName: "Other Notes Tools",
          },
          {
            score: 0.8,
            slug: "legacy-notes-tools",
            displayName: "Ownerless Notes Tools",
          },
        ],
        complete: completeMatching([{ appLabel: "Notes", candidateId: "@demo-owner/notes-tools" }]),
      },
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.groups[0]?.candidates.map((candidate) => candidate.id)).toEqual([
        "@demo-owner/notes-tools",
        "@other-owner/notes-tools",
      ]);
      expect(result.matches[0]?.candidate.id).toBe("@demo-owner/notes-tools");
    }
  });

  it("gathers, dedupes, and sorts official and ClawHub candidates", async () => {
    const channel = officialEntry({
      id: "chat",
      label: "Chat",
      description: "Chat desktop channel",
      kind: "channel",
    });
    const generic = officialEntry({
      id: "notes",
      label: "Notes",
      description: "Notes integration",
    });
    const searchSkills = vi.fn(async () => [
      {
        score: 2,
        slug: "notes-tools",
        ownerHandle: "demo-owner",
        displayName: "Duplicate notes",
      },
      {
        score: 1,
        slug: "notes-tools",
        ownerHandle: "demo-owner",
        displayName: "Notes Tools",
        summary: "Work with notes",
      },
    ]);

    const result = await getSetupAppRecommendations({
      inventorySource: async () => [{ label: "Notes" }, { label: "Chat Desktop" }],
      runtime: defaultRuntime,
      deps: {
        listPlugins: () => [generic, channel],
        listChannels: () => [channel],
        listProviders: () => [],
        searchSkills,
        complete: completeMatching([{ appLabel: "Notes", candidateId: "notes" }]),
      },
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.groups.map((group) => group.app.label)).toEqual(["Chat Desktop", "Notes"]);
      const notes = result.groups.find((group) => group.app.label === "Notes");
      expect(notes?.candidates.map((candidate) => [candidate.source, candidate.id])).toEqual([
        ["official-plugin", "notes"],
        ["clawhub-skill", "@demo-owner/notes-tools"],
      ]);
    }
    expect(searchSkills).toHaveBeenCalledTimes(2);
  });

  it("degrades one failed ClawHub search without aborting other apps", async () => {
    const searchSkills = vi.fn(async ({ query }: { query: string }) => {
      if (query === "Broken") {
        throw new Error("offline");
      }
      return [{ score: 1, slug: "working", ownerHandle: "demo-owner", displayName: "Working" }];
    });
    const result = await getSetupAppRecommendations({
      inventorySource: async () => [{ label: "Broken" }, { label: "Working" }],
      runtime: defaultRuntime,
      deps: {
        listPlugins: () => [],
        listChannels: () => [],
        listProviders: () => [],
        searchSkills,
        complete: completeMatching([{ appLabel: "Working", candidateId: "@demo-owner/working" }]),
      },
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.groups.find((group) => group.app.label === "Broken")?.candidates).toEqual([]);
      expect(result.groups.find((group) => group.app.label === "Working")?.candidates).toHaveLength(
        1,
      );
    }
  });
});

describe("official catalog candidates", () => {
  it("produces channel candidates from the real package-shaped catalogs", async () => {
    // Regression: real catalog entries carry no top-level id; keying by it
    // used to collapse the whole catalog and drop every official candidate.
    const result = await getSetupAppRecommendations({
      inventorySource: async () => [{ label: "Discord" }, { label: "WhatsApp" }],
      runtime: defaultRuntime,
      deps: {
        searchSkills: async () => [],
        complete: completeMatching([
          { appLabel: "Discord", candidateId: "discord" },
          { appLabel: "WhatsApp", candidateId: "whatsapp" },
        ]),
      },
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const discord = result.groups.find((group) => group.app.label === "Discord");
      const whatsapp = result.groups.find((group) => group.app.label === "WhatsApp");
      expect(discord?.candidates).toContainEqual(
        expect.objectContaining({ id: "discord", source: "official-channel" }),
      );
      expect(whatsapp?.candidates).toContainEqual(
        expect.objectContaining({ id: "whatsapp", source: "official-channel" }),
      );
    }
  });
});

describe("setup app recommendation matcher", () => {
  const inventorySource = async () => [{ label: "Notes", bundleId: "com.example.notes" }];
  const candidateDeps = {
    listPlugins: () => [],
    listChannels: () => [],
    listProviders: () => [],
    searchSkills: async () => [
      {
        score: 1,
        slug: "notes-tools",
        ownerHandle: "demo-owner",
        displayName: "Notes Tools",
        summary: "Work with notes",
      },
    ],
  };

  it("accepts strict JSON", async () => {
    const result = await getSetupAppRecommendations({
      inventorySource,
      runtime: defaultRuntime,
      deps: {
        ...candidateDeps,
        complete: async () => ({
          ok: true,
          text: JSON.stringify({
            matches: [
              {
                appLabel: "Notes",
                candidateId: "@demo-owner/notes-tools",
                tier: "recommended",
                reason: "Connects directly to your notes",
              },
            ],
          }),
        }),
      },
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.matches[0]).toMatchObject({
        candidateId: "@demo-owner/notes-tools",
        tier: "recommended",
      });
    }
  });

  it("tolerates fenced JSON with extra keys and long reasons", async () => {
    const reason = `${"a".repeat(118)}🤖suffix`;
    const result = await getSetupAppRecommendations({
      inventorySource,
      runtime: defaultRuntime,
      deps: {
        ...candidateDeps,
        complete: async () => ({
          ok: true,
          text: [
            "Here you go:",
            "```json",
            JSON.stringify({
              matches: [
                {
                  appLabel: "Notes",
                  candidateId: "@demo-owner/notes-tools",
                  tier: "optional",
                  reason,
                  confidence: "high",
                },
              ],
            }),
            "```",
          ].join("\n"),
        }),
      },
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.matches[0]?.candidateId).toBe("@demo-owner/notes-tools");
      expect(result.matches[0]?.reason).toBe(`${"a".repeat(118)}…`);
      expect(result.matches[0]?.reason.length).toBeLessThanOrEqual(120);
    }
  });

  it("skips garbage model output", async () => {
    await expect(
      getSetupAppRecommendations({
        inventorySource,
        runtime: defaultRuntime,
        deps: { ...candidateDeps, complete: async () => ({ ok: true, text: "not json" }) },
      }),
    ).resolves.toEqual({ status: "skipped", reason: "model-failed" });
  });

  it("drops unknown candidate ids", async () => {
    await expect(
      getSetupAppRecommendations({
        inventorySource,
        runtime: defaultRuntime,
        deps: {
          ...candidateDeps,
          complete: async () => ({
            ok: true,
            text: JSON.stringify({
              matches: [
                {
                  appLabel: "Notes",
                  candidateId: "unknown",
                  tier: "optional",
                  reason: "Looks useful",
                },
              ],
            }),
          }),
        },
      }),
    ).resolves.toEqual({ status: "skipped", reason: "no-matches" });
  });
});
