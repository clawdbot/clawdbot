import { describe, expect, it, vi } from "vitest";
import {
  fetchClawHubPluginCatalog,
  fetchClawHubPluginCategories,
  fetchClawHubPluginDetail,
} from "./clawhub-plugin-catalog.js";

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function requestUrl(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

const remotePlugin = {
  name: "memory-plus",
  displayName: "Memory Plus",
  family: "code-plugin",
  channel: "community",
  isOfficial: false,
  summary: "Long-term memory",
  ownerHandle: "alice",
  categories: ["memory"],
  latestVersion: "1.2.3",
  runtimeId: "memory-plus",
  stats: { downloads: 42, installs: 7 },
};

describe("ClawHub plugin catalog client", () => {
  it("browses the combined plugin endpoint with an opaque cursor", async () => {
    let requestedUrl = "";
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      requestedUrl = requestUrl(input);
      return jsonResponse({ items: [remotePlugin], nextCursor: "pkgplugins:{opaque}" });
    });

    const result = await fetchClawHubPluginCatalog({
      baseUrl: "https://example.com",
      intent: "trending",
      category: "memory",
      cursor: "pkgplugins:{opaque}",
      limit: 12,
      fetchImpl,
    });

    const url = new URL(requestedUrl);
    expect(url.pathname).toBe("/api/v1/plugins");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      category: "memory",
      cursor: "pkgplugins:{opaque}",
      sort: "trending",
      limit: "12",
    });
    expect(result).toEqual({
      items: [
        {
          packageName: "memory-plus",
          displayName: "Memory Plus",
          family: "code-plugin",
          summary: "Long-term memory",
          ownerHandle: "alice",
          isOfficial: false,
          categories: ["memory"],
          latestVersion: "1.2.3",
          runtimeId: "memory-plus",
          downloads: 42,
          installs: 7,
        },
      ],
      nextCursor: "pkgplugins:{opaque}",
    });
  });

  it("uses plugin search without inventing pagination", async () => {
    let requestedUrl = "";
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      requestedUrl = requestUrl(input);
      return jsonResponse({ results: [{ score: 9, package: remotePlugin }] });
    });

    const result = await fetchClawHubPluginCatalog({
      baseUrl: "https://example.com",
      query: "memory",
      intent: "official",
      limit: 5,
      fetchImpl,
    });

    const url = new URL(requestedUrl);
    expect(url.pathname).toBe("/api/v1/plugins/search");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: "memory",
      isOfficial: "true",
      limit: "5",
    });
    expect(result.nextCursor).toBeUndefined();
    expect(result.items).toHaveLength(1);
  });

  it("uses ClawHub's featured filter without overriding its canonical order", async () => {
    let requestedUrl = "";
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      requestedUrl = requestUrl(input);
      return jsonResponse({ items: [remotePlugin] });
    });

    await fetchClawHubPluginCatalog({
      baseUrl: "https://example.com",
      intent: "featured",
      limit: 6,
      fetchImpl,
    });

    const url = new URL(requestedUrl);
    expect(url.pathname).toBe("/api/v1/plugins");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      featured: "true",
      limit: "6",
    });
  });

  it("validates and restores canonical category ordering", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        categories: [
          {
            slug: "models",
            label: "Models",
            description: "Model providers.",
            icon: "brain",
            order: 1,
          },
          {
            slug: "channels",
            label: "Channels",
            description: "Messaging integrations.",
            icon: "message-circle",
            order: 0,
          },
        ],
      }),
    );

    const categories = await fetchClawHubPluginCategories({
      baseUrl: "https://example.com",
      fetchImpl,
    });

    expect(categories.map((category) => category.slug)).toEqual(["channels", "models"]);
  });

  it("rejects arbitrary category icon values", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        categories: [
          {
            slug: "tools",
            label: "Tools",
            description: "Agent tools.",
            icon: "lucide:wrench",
            order: 0,
          },
        ],
      }),
    );

    await expect(
      fetchClawHubPluginCategories({ baseUrl: "https://example.com", fetchImpl }),
    ).rejects.toThrow("invalid icon key");
  });

  it("falls back safely for an unknown bare category icon key", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        categories: [
          {
            slug: "tools",
            label: "Tools",
            description: "Agent tools.",
            icon: "new-upstream-icon",
            order: 0,
          },
        ],
      }),
    );

    await expect(
      fetchClawHubPluginCategories({ baseUrl: "https://example.com", fetchImpl }),
    ).resolves.toEqual([
      {
        slug: "tools",
        label: "Tools",
        description: "Agent tools.",
        icon: "package",
        order: 0,
      },
    ]);
  });

  it("assembles normalized detail from ClawHub package metadata and release endpoints", async () => {
    const requestedUrls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(requestUrl(input));
      requestedUrls.push(`${url.pathname}${url.search}`);
      if (url.pathname.endsWith("/versions")) {
        return jsonResponse({
          items: [
            {
              version: "1.2.3",
              createdAt: 300,
              changelog: "Current release",
              distTags: ["latest"],
            },
            { version: "1.2.2", createdAt: 200, changelog: "Previous release", distTags: [] },
          ],
          nextCursor: null,
        });
      }
      if (url.pathname.endsWith("/versions/1.2.3")) {
        return jsonResponse({
          package: { name: "memory-plus", displayName: "Memory Plus", family: "code-plugin" },
          version: {
            version: "1.2.3",
            createdAt: 300,
            changelog: "Current release",
            pluginManifestSummary: {
              schemaVersion: 1,
              configFields: [
                { name: "apiKey", description: "Service API key", required: true, sensitive: true },
              ],
              mcpServers: [{ name: "memory" }],
              bundledSkills: [
                {
                  name: "Recall",
                  description: "Recall saved knowledge",
                  rootPath: "skills/recall",
                  skillMdPath: "skills/recall/SKILL.md",
                  sha256: "a".repeat(64),
                  size: 42,
                },
              ],
              compatibility: { minGatewayVersion: ">=1.0.0" },
            },
            verification: {
              tier: "source-linked",
              scope: "artifact-only",
              summary: "Linked to source.",
              sourceRepo: "alice/memory-plus",
              sourceCommit: "abc123",
              sourcePath: "plugins/memory-plus",
              scanStatus: "clean",
            },
            llmAnalysis: {
              status: "clean",
              verdict: "benign",
              summary: "Capabilities match the stated purpose.",
              guidance: "Review the API key before enabling.",
              checkedAt: 400,
            },
          },
        });
      }
      if (url.pathname.endsWith("/file")) {
        return new Response("# Memory Plus\n\nLong-term memory.", { status: 200 });
      }
      return jsonResponse({
        package: {
          ...remotePlugin,
          topics: ["Retrieval"],
          createdAt: 100,
          updatedAt: 300,
          compatibility: { minGatewayVersion: ">=1.0.0" },
          scanStatus: "clean",
        },
        owner: { handle: "alice", displayName: "Alice", image: null },
      });
    });

    const detail = await fetchClawHubPluginDetail({
      baseUrl: "https://example.com",
      packageName: "memory-plus",
      fetchImpl,
    });

    expect(requestedUrls).toEqual([
      "/api/v1/packages/memory-plus",
      "/api/v1/packages/memory-plus/versions?limit=10",
      "/api/v1/packages/memory-plus/versions/1.2.3",
      "/api/v1/packages/memory-plus/file?path=README.md&preview=1&version=1.2.3",
    ]);
    expect(detail).toMatchObject({
      packageName: "memory-plus",
      owner: { handle: "alice", displayName: "Alice" },
      topics: ["Retrieval"],
      createdAt: 100,
      updatedAt: 300,
      readme: "# Memory Plus\n\nLong-term memory.",
      compatibility: { minGatewayVersion: ">=1.0.0" },
      configFields: [
        { name: "apiKey", description: "Service API key", required: true, sensitive: true },
      ],
      mcpServers: ["memory"],
      skills: [{ name: "Recall", description: "Recall saved knowledge" }],
      versions: [
        { version: "1.2.3", createdAt: 300, changelog: "Current release", tags: ["latest"] },
        { version: "1.2.2", createdAt: 200, changelog: "Previous release", tags: [] },
      ],
      verification: {
        tier: "source-linked",
        summary: "Linked to source.",
        sourceRepo: "alice/memory-plus",
        sourceCommit: "abc123",
        sourcePath: "plugins/memory-plus",
        scanStatus: "clean",
      },
      security: {
        status: "clean",
        verdict: "benign",
        summary: "Capabilities match the stated purpose.",
        guidance: "Review the API key before enabling.",
        checkedAt: 400,
      },
    });
  });
});
