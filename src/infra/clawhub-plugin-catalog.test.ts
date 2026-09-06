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
      requestedUrl = input instanceof Request ? input.url : String(input);
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

  it("reads package detail through the canonical package endpoint", async () => {
    let requestedUrl = "";
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      requestedUrl = requestUrl(input);
      return jsonResponse({ package: remotePlugin });
    });

    const detail = await fetchClawHubPluginDetail({
      baseUrl: "https://example.com",
      packageName: "memory-plus",
      fetchImpl,
    });

    expect(new URL(requestedUrl).pathname).toBe("/api/v1/packages/memory-plus");
    expect(detail.packageName).toBe("memory-plus");
  });
});
