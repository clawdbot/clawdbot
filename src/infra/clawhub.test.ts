// Covers ClawHub metadata and artifact fetch helpers.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import {
  downloadClawHubGitHubSkillArchive,
  downloadClawHubPackageArchive,
  downloadClawHubSkillArchive,
  downloadClawHubSkillArchiveUrl,
  fetchClawHubSkillDetail,
  fetchClawHubSkillInstallResolution,
  fetchClawHubSkillCard,
  fetchClawHubSkillSecurityVerdicts,
  fetchClawHubPackageArtifact,
  fetchClawHubPackageSecurity,
  fetchClawHubSkillVerification,
  normalizeClawHubSha256Integrity,
  normalizeClawHubSha256Hex,
  parseClawHubPluginSpec,
  resolveLatestVersionFromPackage,
  satisfiesGatewayMinimum,
  satisfiesPluginApiRange,
  searchClawHubSkills,
} from "./clawhub.js";

async function expectPathMissing(targetPath: string): Promise<void> {
  let statError: unknown;
  try {
    await fs.stat(targetPath);
  } catch (error) {
    statError = error;
  }
  if (statError === undefined) {
    throw new Error(`Expected ${targetPath} to be missing`);
  }
  expect((statError as { code?: unknown }).code).toBe("ENOENT");
}

function createStalledBodyResponse(params: {
  headers: HeadersInit;
  firstChunk: Uint8Array;
  status?: number;
  statusText?: string;
}): {
  response: Response;
  cancel: ReturnType<typeof vi.fn>;
} {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(params.firstChunk);
    },
    cancel(reason) {
      cancel(reason);
    },
  });
  return {
    response: new Response(body, {
      status: params.status ?? 200,
      statusText: params.statusText,
      headers: params.headers,
    }),
    cancel,
  };
}

function createOversizedArchiveResponse(
  params: {
    headers?: HeadersInit;
  } = {},
): {
  response: Response;
  cancel: ReturnType<typeof vi.fn>;
} {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancel();
    },
  });
  const headers = new Headers(params.headers);
  headers.set("content-type", headers.get("content-type") ?? "application/zip");
  headers.set("content-length", String(256 * 1024 * 1024 + 512 * 1024));
  return {
    response: new Response(body, {
      status: 200,
      headers,
    }),
    cancel,
  };
}

const oversizedArchiveCases: Array<{
  name: string;
  headers?: HeadersInit;
  download: (response: Response) => Promise<unknown>;
  expectedResource: string;
}> = [
  {
    name: "package archive",
    download: (response) =>
      downloadClawHubPackageArchive({
        name: "@hyf/zai-external-alpha",
        version: "0.0.1",
        fetchImpl: async () => response,
      }),
    expectedResource: "package archive download for @hyf/zai-external-alpha",
  },
  {
    name: "ClawPack artifact",
    headers: { "content-type": "application/octet-stream" },
    download: (response) =>
      downloadClawHubPackageArchive({
        name: "demo",
        version: "1.2.3",
        artifact: "clawpack",
        fetchImpl: async () => response,
      }),
    expectedResource: "ClawPack download for demo@1.2.3",
  },
  {
    name: "skill archive",
    download: (response) =>
      downloadClawHubSkillArchive({
        slug: "agentreceipt",
        version: "1.0.0",
        fetchImpl: async () => response,
      }),
    expectedResource: "skill archive download for agentreceipt",
  },
  {
    name: "resolver URL archive",
    download: (response) =>
      downloadClawHubSkillArchiveUrl({
        baseUrl: "https://clawhub.ai",
        url: "https://downloads.example.com/skill.zip",
        fetchImpl: async () => response,
      }),
    expectedResource: "skill archive download at /skill.zip",
  },
  {
    name: "GitHub source archive",
    download: (response) =>
      downloadClawHubGitHubSkillArchive({
        repo: "owner/repo",
        commit: "abc123",
        fetchImpl: async () => response,
      }),
    expectedResource: "GitHub source archive for owner/repo@abc123",
  },
];

describe("clawhub helpers", () => {
  const originalEnv = captureEnv(["HOME", "XDG_CONFIG_HOME"]);

  async function expectSearchUsesAuthToken(expectedToken: string): Promise<void> {
    await expect(
      searchClawHubSkills({
        query: "calendar",
        fetchImpl: async (_input, init) => {
          expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${expectedToken}`);
          return new Response(JSON.stringify({ results: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      }),
    ).resolves.toStrictEqual([]);
  }

  afterEach(() => {
    delete process.env.OPENCLAW_CLAWHUB_URL;
    delete process.env.CLAWHUB_TOKEN;
    delete process.env.CLAWHUB_AUTH_TOKEN;
    delete process.env.CLAWHUB_CONFIG_PATH;
    delete process.env.CLAWDHUB_CONFIG_PATH;
    originalEnv.restore();
  });

  it("parses explicit ClawHub package specs", () => {
    expect(parseClawHubPluginSpec("clawhub:demo")).toEqual({
      name: "demo",
    });
    expect(parseClawHubPluginSpec("clawhub:demo@1.2.3")).toEqual({
      name: "demo",
      version: "1.2.3",
    });
    expect(parseClawHubPluginSpec("clawhub:@scope/pkg")).toEqual({
      name: "@scope/pkg",
    });
    expect(parseClawHubPluginSpec("clawhub:@scope/pkg@1.2.3")).toEqual({
      name: "@scope/pkg",
      version: "1.2.3",
    });
    expect(parseClawHubPluginSpec("clawhub:demo@")).toBeNull();
    expect(parseClawHubPluginSpec("clawhub:@scope/pkg@")).toBeNull();
    expect(parseClawHubPluginSpec("@scope/pkg")).toBeNull();
  });

  it("resolves latest versions from latestVersion before tags", () => {
    expect(
      resolveLatestVersionFromPackage({
        package: {
          name: "demo",
          displayName: "Demo",
          family: "code-plugin",
          channel: "official",
          isOfficial: true,
          createdAt: 0,
          updatedAt: 0,
          latestVersion: "1.2.3",
          tags: { latest: "1.2.2" },
        },
      }),
    ).toBe("1.2.3");
    expect(
      resolveLatestVersionFromPackage({
        package: {
          name: "demo",
          displayName: "Demo",
          family: "code-plugin",
          channel: "official",
          isOfficial: true,
          createdAt: 0,
          updatedAt: 0,
          tags: { latest: "1.2.2" },
        },
      }),
    ).toBe("1.2.2");
  });

  it("checks plugin api ranges with semver precedence", () => {
    expect(satisfiesPluginApiRange("1.2.3", "^1.2.0")).toBe(true);
    expect(satisfiesPluginApiRange("1.2.3", "~1.2.0")).toBe(true);
    expect(satisfiesPluginApiRange("1.2.3", "1.2.x")).toBe(true);
    expect(satisfiesPluginApiRange("1.9.0", ">=1.2.0 <2.0.0")).toBe(true);
    expect(satisfiesPluginApiRange("1.3.0", "~1.2.0")).toBe(false);
    expect(satisfiesPluginApiRange("2.0.0", "^1.2.0")).toBe(false);
    expect(satisfiesPluginApiRange("2.0.0-beta.1", "^1.2.0")).toBe(false);
    expect(satisfiesPluginApiRange("1.1.9", ">=1.2.0")).toBe(false);
    expect(satisfiesPluginApiRange("2026.3.22", ">=2026.3.22")).toBe(true);
    expect(satisfiesPluginApiRange("2026.3.21", ">=2026.3.22")).toBe(false);
    expect(satisfiesPluginApiRange("invalid", "^1.2.0")).toBe(false);
  });

  it("treats OpenClaw release correction versions as stable plugin API hosts", () => {
    expect(satisfiesPluginApiRange("2026.5.3-1", ">=2026.5.3")).toBe(true);
    expect(satisfiesPluginApiRange("2026.5.32-1", ">=2026.5.32")).toBe(true);
    expect(satisfiesPluginApiRange("2026.5.3-2", ">=2026.5.3")).toBe(true);
    expect(satisfiesPluginApiRange("2026.5.3-beta.1", ">=2026.5.3")).toBe(true);
    expect(satisfiesPluginApiRange("2026.5.3-alpha.1", ">=2026.5.3")).toBe(true);
    expect(satisfiesPluginApiRange("2026.5.3-rc.1", ">=2026.5.3")).toBe(true);
    expect(satisfiesPluginApiRange("2026.5.2-beta.1", ">=2026.5.3")).toBe(false);
  });

  it("preserves prerelease ordering for explicit plugin API prerelease floors", () => {
    expect(satisfiesPluginApiRange("2026.3.24-beta.1", ">=2026.3.24-beta.2")).toBe(false);
    expect(satisfiesPluginApiRange("2026.3.24-beta.2", ">=2026.3.24-beta.2")).toBe(true);
    expect(satisfiesPluginApiRange("2026.3.24-1", ">=2026.3.24-beta.2")).toBe(true);
    expect(satisfiesPluginApiRange("2026.3.24", ">=2026.3.24-beta.2")).toBe(true);
    expect(satisfiesPluginApiRange("2026.3.24-beta.1", ">=2026.3.24")).toBe(true);
  });

  it("accepts legacy bare major.minor plugin api ranges as lower bounds", () => {
    expect(satisfiesPluginApiRange("2026.5.2", "2026.4")).toBe(true);
    expect(satisfiesPluginApiRange("2026.4.0", "2026.4")).toBe(true);
    expect(satisfiesPluginApiRange("2026.3.99", "2026.4")).toBe(false);
    expect(satisfiesPluginApiRange("2026.4.1", "=2026.4")).toBe(false);
    expect(satisfiesPluginApiRange("2026.5.2", "=2026.4")).toBe(false);
    expect(satisfiesPluginApiRange("invalid", "2026.4")).toBe(false);
  });

  it.each(["*", "x", "X", "=*", "=x", ">=*", ">=x", "<=*", "^*", "~*"] as const)(
    "accepts plugin api wildcard range %s for valid runtime versions",
    (range) => {
      expect(satisfiesPluginApiRange("2026.3.24", range)).toBe(true);
      expect(satisfiesPluginApiRange("1.0.0", range)).toBe(true);
    },
  );

  it("keeps wildcard plugin api ranges intersected with concrete comparators", () => {
    expect(satisfiesPluginApiRange("2026.3.24", "* >=2026.3.22")).toBe(true);
    expect(satisfiesPluginApiRange("2026.3.21", "* >=2026.3.22")).toBe(false);
    expect(satisfiesPluginApiRange("2026.3.24", "x <2026.3.24")).toBe(false);
  });

  it("rejects invalid runtime versions and impossible wildcard comparators", () => {
    expect(satisfiesPluginApiRange("invalid", "*")).toBe(false);
    expect(satisfiesPluginApiRange("2026.3.24", ">*")).toBe(false);
    expect(satisfiesPluginApiRange("2026.3.24", "<*")).toBe(false);
    expect(satisfiesPluginApiRange("1.5.0", ">=1.0.0 || >=2.0.0")).toBe(false);
    expect(satisfiesPluginApiRange("1.2.3", "1.2.3||2.0.0")).toBe(false);
    expect(satisfiesPluginApiRange("1.5.0", "1.0.0 - 2.0.0")).toBe(false);
    expect(satisfiesPluginApiRange("1.2.3", "~>1.2.3")).toBe(false);
  });

  it("checks min gateway versions with loose host labels", () => {
    expect(satisfiesGatewayMinimum("2026.3.22", "2026.3.0")).toBe(true);
    expect(satisfiesGatewayMinimum("OpenClaw 2026.3.22", "2026.3.0")).toBe(true);
    expect(satisfiesGatewayMinimum("2026.2.9", "2026.3.0")).toBe(false);
    expect(satisfiesGatewayMinimum("unknown", "2026.3.0")).toBe(false);
  });

  it("normalizes raw ClawHub SHA-256 hashes into integrity strings", () => {
    const hex = "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81";
    const integrity = "sha256-A5BYxvLAy0ksUzsKTRTvd8wPeKvMztUofYShogEc+4E=";
    const unpaddedIntegrity = "sha256-A5BYxvLAy0ksUzsKTRTvd8wPeKvMztUofYShogEc+4E";
    expect(normalizeClawHubSha256Integrity(hex)).toBe(integrity);
    expect(normalizeClawHubSha256Integrity(`sha256:${hex}`)).toBe(integrity);
    expect(normalizeClawHubSha256Integrity(integrity)).toBe(integrity);
    expect(normalizeClawHubSha256Integrity(unpaddedIntegrity)).toBe(integrity);
    expect(normalizeClawHubSha256Integrity(`sha256=${hex}`)).toBeNull();
    expect(normalizeClawHubSha256Integrity("sha256-a=")).toBeNull();
    expect(normalizeClawHubSha256Integrity("not-a-hash")).toBeNull();
  });

  it("normalizes ClawHub SHA-256 hex values", () => {
    expect(normalizeClawHubSha256Hex("AA".repeat(32))).toBe("aa".repeat(32));
    expect(normalizeClawHubSha256Hex("not-a-hash")).toBeNull();
  });

  it("loads ClawHub request auth from config.json", async () => {
    await withTempDir({ prefix: "openclaw-clawhub-config-" }, async (configRoot) => {
      const configPath = path.join(configRoot, "clawhub", "config.json");
      process.env.CLAWHUB_CONFIG_PATH = configPath;
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, JSON.stringify({ auth: { token: "cfg-token-123" } }), "utf8");

      await expectSearchUsesAuthToken("cfg-token-123");
    });
  });

  it("loads ClawHub request auth from the legacy config path override", async () => {
    await withTempDir({ prefix: "openclaw-clawdhub-config-" }, async (configRoot) => {
      const configPath = path.join(configRoot, "config.json");
      process.env.CLAWDHUB_CONFIG_PATH = configPath;
      await fs.writeFile(configPath, JSON.stringify({ token: "legacy-token-123" }), "utf8");

      await expectSearchUsesAuthToken("legacy-token-123");
    });
  });

  it.runIf(process.platform === "darwin")(
    "loads ClawHub request auth from the macOS Application Support path",
    async () => {
      await withTempDir({ prefix: "openclaw-clawhub-home-" }, async (fakeHome) => {
        const configPath = path.join(
          fakeHome,
          "Library",
          "Application Support",
          "clawhub",
          "config.json",
        );
        const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
        try {
          await fs.mkdir(path.dirname(configPath), { recursive: true });
          await fs.writeFile(configPath, JSON.stringify({ token: "macos-token-123" }), "utf8");

          await expectSearchUsesAuthToken("macos-token-123");
        } finally {
          homedirSpy.mockRestore();
        }
      });
    },
  );

  it.runIf(process.platform === "darwin")(
    "falls back to XDG_CONFIG_HOME for ClawHub request auth on macOS",
    async () => {
      await withTempDir({ prefix: "openclaw-clawhub-home-" }, async (fakeHome) => {
        await withTempDir({ prefix: "openclaw-clawhub-xdg-" }, async (xdgRoot) => {
          const configPath = path.join(xdgRoot, "clawhub", "config.json");
          const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
          setTestEnvValue("XDG_CONFIG_HOME", xdgRoot);
          try {
            await fs.mkdir(path.dirname(configPath), { recursive: true });
            await fs.writeFile(configPath, JSON.stringify({ token: "xdg-token-123" }), "utf8");

            await expectSearchUsesAuthToken("xdg-token-123");
          } finally {
            homedirSpy.mockRestore();
          }
        });
      });
    },
  );

  it("injects resolved auth token into ClawHub requests", async () => {
    process.env.CLAWHUB_TOKEN = "env-token-123";
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      expect(url).toContain("/api/v1/search");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer env-token-123");
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await expect(searchClawHubSkills({ query: "calendar", fetchImpl })).resolves.toStrictEqual([]);
  });

  it("preserves the configured ClawHub base URL path prefix", async () => {
    process.env.OPENCLAW_CLAWHUB_URL = "https://internal.example.com/clawhub";
    let requestedUrl = "";

    await expect(
      searchClawHubSkills({
        query: "calendar",
        fetchImpl: async (input) => {
          requestedUrl = input instanceof Request ? input.url : String(input);
          return new Response(JSON.stringify({ results: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      }),
    ).resolves.toStrictEqual([]);

    const url = new URL(requestedUrl);
    expect(url.origin).toBe("https://internal.example.com");
    expect(url.pathname).toBe("/clawhub/api/v1/search");
    expect(url.searchParams.get("q")).toBe("calendar");
  });

  it("sends owner-qualified skill detail lookups as slug plus ownerHandle", async () => {
    let requestedUrl = "";

    await expect(
      fetchClawHubSkillDetail({
        slug: "weather",
        ownerHandle: "demo-owner",
        fetchImpl: async (input) => {
          requestedUrl = input instanceof Request ? input.url : String(input);
          return new Response(
            JSON.stringify({
              skill: {
                slug: "weather",
                displayName: "Weather",
                createdAt: 1,
                updatedAt: 2,
              },
            }),
            { headers: { "content-type": "application/json" } },
          );
        },
      }),
    ).resolves.toMatchObject({ skill: { slug: "weather" } });

    const url = new URL(requestedUrl);
    expect(url.pathname).toBe("/api/v1/skills/weather");
    expect(url.searchParams.get("ownerHandle")).toBe("demo-owner");
  });

  it("sends owner-qualified skill install resolution lookups as slug plus ownerHandle", async () => {
    let requestedUrl = "";

    await expect(
      fetchClawHubSkillInstallResolution({
        slug: "weather",
        ownerHandle: "demo-owner",
        fetchImpl: async (input) => {
          requestedUrl = input instanceof Request ? input.url : String(input);
          return new Response(
            JSON.stringify({
              ok: true,
              slug: "weather",
              installKind: "archive",
              archive: {
                version: "1.0.0",
                downloadUrl: "https://clawhub.ai/api/v1/download?slug=weather&version=1.0.0",
              },
            }),
            { headers: { "content-type": "application/json" } },
          );
        },
      }),
    ).resolves.toMatchObject({ ok: true, slug: "weather" });

    const url = new URL(requestedUrl);
    expect(url.pathname).toBe("/api/v1/skills/weather/install");
    expect(url.searchParams.get("ownerHandle")).toBe("demo-owner");
  });

  it("fetches skill verification reports and lets version take precedence over tag", async () => {
    let requestedUrl = "";
    const envelope = {
      schema: "clawhub.skill.verify.v1",
      ok: true,
      decision: "pass",
      reasons: [],
      skill: { slug: "agentreceipt", displayName: "Agent Receipt" },
      publisher: { handle: "openclaw" },
      version: { version: "1.2.3", tag: "stable" },
      card: {
        available: true,
        url: "https://clawhub.ai/api/v1/skills/agentreceipt/card?version=1.2.3",
      },
      artifact: {
        sourceFingerprint: "source-fp",
        bundleFingerprints: ["generated-bundle-fp"],
      },
      provenance: null,
      security: { status: "clean" },
      signature: { status: "unsigned" },
    };

    await expect(
      fetchClawHubSkillVerification({
        slug: "agentreceipt",
        version: "1.2.3",
        tag: "stable",
        fetchImpl: async (input) => {
          requestedUrl = input instanceof Request ? input.url : String(input);
          return new Response(JSON.stringify(envelope), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      }),
    ).resolves.toEqual(envelope);

    const url = new URL(requestedUrl);
    expect(url.pathname).toBe("/api/v1/skills/agentreceipt/verify");
    expect(url.searchParams.get("version")).toBe("1.2.3");
    expect(url.searchParams.has("tag")).toBe(false);
  });

  it("sends owner-qualified skill verification lookups as slug plus ownerHandle", async () => {
    let requestedUrl = "";

    await expect(
      fetchClawHubSkillVerification({
        slug: "weather",
        ownerHandle: "demo-owner",
        version: "1.0.0",
        fetchImpl: async (input) => {
          requestedUrl = input instanceof Request ? input.url : String(input);
          return new Response(
            JSON.stringify({
              schema: "clawhub.skill.verify.v1",
              ok: true,
              decision: "pass",
              reasons: [],
              skill: {},
              publisher: {},
              version: {},
              card: {},
              artifact: {},
              provenance: {},
              security: {},
              signature: {},
            }),
            { headers: { "content-type": "application/json" } },
          );
        },
      }),
    ).resolves.toMatchObject({ schema: "clawhub.skill.verify.v1" });

    const url = new URL(requestedUrl);
    expect(url.pathname).toBe("/api/v1/skills/weather/verify");
    expect(url.searchParams.get("ownerHandle")).toBe("demo-owner");
    expect(url.searchParams.get("version")).toBe("1.0.0");
  });

  it("posts bulk skill security verdict requests", async () => {
    let requestedUrl = "";
    let requestedInit: RequestInit | undefined;
    const envelope = {
      schema: "clawhub.skill.security-verdicts.v1",
      items: [
        {
          ok: true,
          decision: "pass",
          reasons: [],
          requestedSlug: "agentreceipt",
          slug: "agentreceipt",
          requestedVersion: "1.2.3",
          version: "1.2.3",
          security: { status: "clean", passed: true },
        },
      ],
    };

    await expect(
      fetchClawHubSkillSecurityVerdicts({
        items: [{ slug: "agentreceipt", version: "1.2.3" }],
        fetchImpl: async (input, init) => {
          requestedUrl = input instanceof Request ? input.url : String(input);
          requestedInit = init;
          return new Response(JSON.stringify(envelope), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      }),
    ).resolves.toEqual(envelope);

    const url = new URL(requestedUrl);
    expect(url.pathname).toBe("/api/v1/skills/-/security-verdicts");
    expect(requestedInit?.method).toBe("POST");
    expect(requestedInit?.headers).toMatchObject({ "Content-Type": "application/json" });
    expect(requestedInit?.body).toBe(
      JSON.stringify({ items: [{ slug: "agentreceipt", version: "1.2.3" }] }),
    );
  });

  it("can post bulk skill security verdict requests without resolved auth", async () => {
    process.env.CLAWHUB_TOKEN = "env-token-123";
    let requestedInit: RequestInit | undefined;
    const envelope = {
      schema: "clawhub.skill.security-verdicts.v1",
      items: [],
    };

    await expect(
      fetchClawHubSkillSecurityVerdicts({
        items: [{ slug: "agentreceipt", version: "1.2.3" }],
        skipAuth: true,
        fetchImpl: async (_input, init) => {
          requestedInit = init;
          return new Response(JSON.stringify(envelope), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      }),
    ).resolves.toEqual(envelope);

    expect(new Headers(requestedInit?.headers).get("Authorization")).toBeNull();
  });

  it("returns failed skill verification reports with missing card reasons", async () => {
    const envelope = {
      schema: "clawhub.skill.verify.v1",
      ok: false,
      decision: "fail",
      reasons: ["card.missing"],
      skill: { slug: "agentreceipt" },
      publisher: null,
      version: { version: "1.2.3" },
      card: { available: false },
      artifact: null,
      provenance: null,
      security: { status: "clean" },
      signature: { status: "unsigned" },
    };

    await expect(
      fetchClawHubSkillVerification({
        slug: "agentreceipt",
        fetchImpl: async () =>
          new Response(JSON.stringify(envelope), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      }),
    ).resolves.toEqual(envelope);
  });

  it("fetches generated Skill Card markdown and applies tag queries", async () => {
    let requestedUrl = "";

    await expect(
      fetchClawHubSkillCard({
        slug: "agentreceipt",
        tag: "latest",
        fetchImpl: async (input) => {
          requestedUrl = input instanceof Request ? input.url : String(input);
          return new Response("# Agent Receipt\n\nVerified by ClawHub.\n", {
            status: 200,
            headers: { "content-type": "text/markdown; charset=utf-8" },
          });
        },
      }),
    ).resolves.toBe("# Agent Receipt\n\nVerified by ClawHub.\n");

    const url = new URL(requestedUrl);
    expect(url.pathname).toBe("/api/v1/skills/agentreceipt/card");
    expect(url.searchParams.get("tag")).toBe("latest");
    expect(url.searchParams.has("version")).toBe(false);
  });

  it("clamps oversized ClawHub request timeouts before scheduling", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      await expect(
        fetchClawHubSkillCard({
          slug: "agentreceipt",
          timeoutMs: Number.MAX_SAFE_INTEGER,
          fetchImpl: async () =>
            new Response("# Agent Receipt\n", {
              status: 200,
              headers: { "content-type": "text/markdown; charset=utf-8" },
            }),
        }),
      ).resolves.toBe("# Agent Receipt\n");

      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("fetches generated Skill Card markdown from an exact verified card URL", async () => {
    let requestedUrl = "";

    await expect(
      fetchClawHubSkillCard({
        url: "https://cards.example.test/generated/agentreceipt.md",
        baseUrl: "https://clawhub.ai",
        fetchImpl: async (input) => {
          requestedUrl = input instanceof Request ? input.url : String(input);
          return new Response("# Agent Receipt\n", {
            status: 200,
            headers: { "content-type": "text/markdown; charset=utf-8" },
          });
        },
      }),
    ).resolves.toBe("# Agent Receipt\n");

    expect(requestedUrl).toBe("https://cards.example.test/generated/agentreceipt.md");
  });

  it("wraps non-200 skill card responses", async () => {
    await expect(
      fetchClawHubSkillCard({
        slug: "agentreceipt",
        fetchImpl: async () => new Response("card missing", { status: 404 }),
      }),
    ).rejects.toThrow("ClawHub /api/v1/skills/agentreceipt/card failed (404): card missing");
  });

  it("rejects oversized generated Skill Card markdown", async () => {
    await expect(
      fetchClawHubSkillCard({
        slug: "agentreceipt",
        fetchImpl: async () => new Response("x".repeat(256 * 1024 + 1)),
      }),
    ).rejects.toThrow(
      "ClawHub skill card for agentreceipt exceeded 262144 bytes (262145 bytes received)",
    );
  });

  it("wraps non-200 skill verification responses", async () => {
    await expect(
      fetchClawHubSkillVerification({
        slug: "agentreceipt",
        fetchImpl: async () => new Response("not found", { status: 404 }),
      }),
    ).rejects.toThrow("ClawHub /api/v1/skills/agentreceipt/verify failed (404): not found");
  });

  it("fetches typed package artifact resolver reports", async () => {
    let requestedUrl = "";
    await expect(
      fetchClawHubPackageArtifact({
        name: "@openclaw/diagnostics-otel",
        version: "2026.3.22",
        fetchImpl: async (input) => {
          requestedUrl = input instanceof Request ? input.url : String(input);
          return new Response(
            JSON.stringify({
              artifact: {
                source: "clawhub",
                artifactKind: "npm-pack",
                packageName: "@openclaw/diagnostics-otel",
                version: "2026.3.22",
                downloadUrl: "https://clawhub.ai/api/v1/clawpacks/abc",
                npmIntegrity: "sha512-demo",
                npmShasum: "abc",
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      }),
    ).resolves.toEqual({
      artifact: {
        source: "clawhub",
        artifactKind: "npm-pack",
        packageName: "@openclaw/diagnostics-otel",
        version: "2026.3.22",
        downloadUrl: "https://clawhub.ai/api/v1/clawpacks/abc",
        npmIntegrity: "sha512-demo",
        npmShasum: "abc",
      },
    });
    expect(new URL(requestedUrl).pathname).toBe(
      "/api/v1/packages/%40openclaw%2Fdiagnostics-otel/versions/2026.3.22/artifact",
    );
  });

  it("fetches typed package security reports", async () => {
    let requestedUrl = "";
    await expect(
      fetchClawHubPackageSecurity({
        name: "@openclaw/diagnostics-otel",
        version: "2026.3.22",
        fetchImpl: async (input) => {
          requestedUrl = input instanceof Request ? input.url : String(input);
          return new Response(
            JSON.stringify({
              package: {
                name: "@openclaw/diagnostics-otel",
                displayName: "Diagnostics",
                family: "code-plugin",
              },
              release: {
                releaseId: "rel_demo",
                version: "2026.3.22",
              },
              trust: {
                scanStatus: "clean",
                moderationState: null,
                blockedFromDownload: false,
                reasons: [],
                pending: false,
                stale: true,
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        },
      }),
    ).resolves.toEqual({
      package: {
        name: "@openclaw/diagnostics-otel",
        displayName: "Diagnostics",
        family: "code-plugin",
      },
      release: {
        id: "rel_demo",
        version: "2026.3.22",
      },
      trust: {
        scanStatus: "clean",
        moderationState: null,
        blockedFromDownload: false,
        reasons: [],
        pending: false,
        stale: true,
      },
    });
    expect(new URL(requestedUrl).pathname).toBe(
      "/api/v1/packages/%40openclaw%2Fdiagnostics-otel/versions/2026.3.22/security",
    );
  });

  it("rejects malformed package security reports", async () => {
    await expect(
      fetchClawHubPackageSecurity({
        name: "@openclaw/diagnostics-otel",
        version: "2026.3.22",
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              trust: {
                scanStatus: "clean",
                moderationState: null,
                blockedFromDownload: false,
                reasons: "clean",
                pending: false,
                stale: false,
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      }),
    ).rejects.toThrow("expected reasons to be a string array");
  });

  it("downloads package archives to sanitized temp paths and cleans them up", async () => {
    const archive = await downloadClawHubPackageArchive({
      name: "@hyf/zai-external-alpha",
      version: "0.0.1",
      fetchImpl: async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "application/zip" },
        }),
    });

    try {
      expect(path.basename(archive.archivePath)).toBe("zai-external-alpha.zip");
      expect(archive.archivePath.includes("@hyf")).toBe(false);
      await expect(fs.readFile(archive.archivePath)).resolves.toEqual(Buffer.from([1, 2, 3]));
    } finally {
      const archiveDir = path.dirname(archive.archivePath);
      await archive.cleanup();
      await expectPathMissing(archiveDir);
    }
  });

  it("downloads ClawPack package artifacts from the version route and verifies response headers", async () => {
    const bytes = new Uint8Array([7, 8, 9]);
    const sha256Hex = createHash("sha256").update(bytes).digest("hex");
    const sha1Hex = createHash("sha1").update(bytes).digest("hex");
    let requestedUrl = "";
    const archive = await downloadClawHubPackageArchive({
      name: "demo",
      version: "1.2.3",
      artifact: "clawpack",
      fetchImpl: async (input) => {
        requestedUrl = input instanceof Request ? input.url : String(input);
        return new Response(bytes, {
          status: 200,
          headers: {
            "content-type": "application/octet-stream",
            "X-ClawHub-Artifact-Sha256": sha256Hex,
          },
        });
      },
    });

    try {
      expect(new URL(requestedUrl).pathname).toBe(
        "/api/v1/packages/demo/versions/1.2.3/artifact/download",
      );
      expect(path.basename(archive.archivePath)).toBe("demo-1.2.3.tgz");
      expect(archive.artifact).toBe("clawpack");
      expect(archive.sha256Hex).toBe(sha256Hex);
      expect(archive.clawpackHeaderSha256).toBe(sha256Hex);
      expect(archive.npmIntegrity).toMatch(/^sha512-/);
      expect(archive.npmShasum).toBe(sha1Hex);
      await expect(fs.readFile(archive.archivePath)).resolves.toEqual(Buffer.from(bytes));
    } finally {
      const archiveDir = path.dirname(archive.archivePath);
      await archive.cleanup();
      await expectPathMissing(archiveDir);
    }
  });

  it("rejects ClawPack package artifacts when the declared digest does not match the bytes", async () => {
    await expect(
      downloadClawHubPackageArchive({
        name: "demo",
        version: "1.2.3",
        artifact: "clawpack",
        fetchImpl: async () =>
          new Response(new Uint8Array([7, 8, 9]), {
            status: 200,
            headers: {
              "content-type": "application/octet-stream",
              "X-ClawHub-Artifact-Sha256": "0".repeat(64),
            },
          }),
      }),
    ).rejects.toThrow(/declared sha256/);
  });

  it.each(oversizedArchiveCases)(
    "rejects and cancels oversized $name downloads",
    async ({ headers, download, expectedResource }) => {
      const oversized = createOversizedArchiveResponse({ headers });

      await expect(download(oversized.response)).rejects.toThrow(
        `ClawHub ${expectedResource} exceeded 268435456 bytes (268959744 bytes declared)`,
      );
      expect(oversized.cancel).toHaveBeenCalledTimes(1);
    },
  );

  it("uses decoded stream bytes instead of encoded content length", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const archive = await downloadClawHubPackageArchive({
      name: "encoded-package",
      version: "1.0.0",
      fetchImpl: async () =>
        new Response(bytes, {
          status: 200,
          headers: {
            "content-encoding": "gzip",
            "content-length": String(256 * 1024 * 1024 + 1),
            "content-type": "application/zip",
          },
        }),
    });
    try {
      await expect(fs.readFile(archive.archivePath)).resolves.toEqual(Buffer.from(bytes));
    } finally {
      await archive.cleanup();
    }
  });

  it("annotates 429 errors with the reset hint and a sign-in hint when unauthenticated", async () => {
    process.env.CLAWHUB_CONFIG_PATH = path.join(os.tmpdir(), "openclaw-no-clawhub-config");
    await expect(
      searchClawHubSkills({
        query: "calendar",
        fetchImpl: async () =>
          new Response("Rate limit exceeded", {
            status: 429,
            headers: {
              "RateLimit-Limit": "30",
              "RateLimit-Remaining": "0",
              "RateLimit-Reset": "42",
            },
          }),
      }),
    ).rejects.toThrow(/Rate limit exceeded \(resets in 42s\) Sign in for higher rate limits\.$/);
  });

  it("degrades gracefully on 429 when the response carries no rate-limit headers", async () => {
    process.env.CLAWHUB_CONFIG_PATH = path.join(os.tmpdir(), "openclaw-no-clawhub-config");
    await expect(
      searchClawHubSkills({
        query: "calendar",
        fetchImpl: async () => new Response("Rate limit exceeded", { status: 429 }),
      }),
    ).rejects.toThrow(/Rate limit exceeded Sign in for higher rate limits\.$/);
  });

  it("retries transient ClawHub reads and honors Retry-After", async () => {
    const cancel = vi.fn();
    let attempts = 0;
    await expect(
      searchClawHubSkills({
        query: "calendar",
        fetchImpl: async () => {
          attempts += 1;
          if (attempts === 1) {
            return new Response(
              new ReadableStream<Uint8Array>({
                cancel() {
                  cancel();
                },
              }),
              {
                status: 503,
                headers: { "Retry-After": "0" },
              },
            );
          }
          return new Response(JSON.stringify({ results: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      }),
    ).resolves.toStrictEqual([]);

    expect(attempts).toBe(2);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("preserves the final ClawHub error body after transient retries are exhausted", async () => {
    let attempts = 0;
    await expect(
      searchClawHubSkills({
        query: "calendar",
        fetchImpl: async () => {
          attempts += 1;
          return new Response("Rate limit temporarily unavailable", {
            status: 503,
            headers: { "Retry-After": "0" },
          });
        },
      }),
    ).rejects.toThrow("ClawHub /api/v1/search failed (503): Rate limit temporarily unavailable");

    expect(attempts).toBe(4);
  });

  it("does not retry non-idempotent ClawHub requests", async () => {
    let attempts = 0;
    await expect(
      fetchClawHubSkillSecurityVerdicts({
        items: [],
        skipAuth: true,
        fetchImpl: async () => {
          attempts += 1;
          return new Response("temporarily unavailable", { status: 503 });
        },
      }),
    ).rejects.toThrow("ClawHub /api/v1/skills/-/security-verdicts failed (503)");
    expect(attempts).toBe(1);
  });

  it("wraps malformed successful ClawHub JSON responses", async () => {
    await expect(
      searchClawHubSkills({
        query: "calendar",
        fetchImpl: async () =>
          new Response("{not json", {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      }),
    ).rejects.toThrow("ClawHub /api/v1/search returned malformed JSON");
  });

  it("times out and cancels stalled successful ClawHub JSON bodies", async () => {
    const stalled = createStalledBodyResponse({
      firstChunk: new TextEncoder().encode('{"results":['),
      headers: { "content-type": "application/json" },
    });

    await expect(
      searchClawHubSkills({
        query: "calendar",
        timeoutMs: 5,
        fetchImpl: async () => stalled.response,
      }),
    ).rejects.toThrow(/ClawHub \/api\/v1\/search response stalled after 5ms/);
    expect(stalled.cancel).toHaveBeenCalledTimes(1);
    expect(stalled.cancel.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it("times out and cancels stalled ClawHub error bodies", async () => {
    const stalled = createStalledBodyResponse({
      firstChunk: new TextEncoder().encode("partial error"),
      headers: { "content-type": "text/plain" },
      status: 500,
      statusText: "Server Error",
    });

    await expect(
      searchClawHubSkills({
        query: "calendar",
        timeoutMs: 5,
        fetchImpl: async () => stalled.response,
      }),
    ).rejects.toThrow("ClawHub /api/v1/search failed (500): Server Error");
    expect(stalled.cancel).toHaveBeenCalledTimes(1);
    expect(stalled.cancel.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it("bounds oversized successful ClawHub JSON responses and cancels the stream", async () => {
    const cancel = vi.fn();
    const chunk = new Uint8Array(512 * 1024).fill("x".charCodeAt(0));
    const overshootChunks = 34; // 34 * 512 KiB = 17 MiB > 16 MiB cap
    let emitted = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emitted >= overshootChunks) {
          controller.close();
          return;
        }
        emitted += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        cancel();
      },
    });

    await expect(
      searchClawHubSkills({
        query: "calendar",
        fetchImpl: async () =>
          new Response(body, {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      }),
    ).rejects.toThrow(/ClawHub \/api\/v1\/search response exceeded 16777216 bytes/);
    // The reader is cancelled at the cap so the oversized stream releases its
    // socket/buffer instead of being drained into memory.
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("bounds oversized ClawHub error bodies to a short collapsed snippet", async () => {
    const oversized = "boom ".repeat(64 * 1024); // ~320 KiB error body
    let error: unknown;
    try {
      await searchClawHubSkills({
        query: "calendar",
        fetchImpl: async () => new Response(oversized, { status: 500 }),
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message.startsWith("ClawHub /api/v1/search failed (500): ")).toBe(true);
    expect(message.endsWith("…")).toBe(true);
    // prefix + 400-char snippet + "…" stays far below the raw ~320 KiB body.
    expect(message.length).toBeLessThanOrEqual(500);
  });

  it("bounds oversized ClawHub install-resolution JSON responses and cancels the stream", async () => {
    const cancel = vi.fn();
    const chunk = new Uint8Array(512 * 1024).fill("x".charCodeAt(0));
    const overshootChunks = 34; // 34 * 512 KiB = 17 MiB > 16 MiB cap
    let emitted = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emitted >= overshootChunks) {
          controller.close();
          return;
        }
        emitted += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        cancel();
      },
    });

    await expect(
      fetchClawHubSkillInstallResolution({
        slug: "weather",
        fetchImpl: async () =>
          new Response(body, {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      }),
    ).rejects.toThrow(
      /ClawHub \/api\/v1\/skills\/weather\/install response exceeded 16777216 bytes/,
    );
    // Same bounded reader covers the sibling install-resolution JSON path so a
    // hostile install response cannot exhaust memory either.
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("annotates 429 errors with the reset hint but no sign-in hint when authenticated", async () => {
    process.env.CLAWHUB_TOKEN = "env-token-123";
    await expect(
      searchClawHubSkills({
        query: "calendar",
        fetchImpl: async () =>
          new Response("Rate limit exceeded", {
            status: 429,
            headers: {
              "RateLimit-Limit": "180",
              "RateLimit-Remaining": "0",
              "RateLimit-Reset": "10",
            },
          }),
      }),
    ).rejects.toThrow(/Rate limit exceeded \(resets in 10s\)$/);
  });

  it("skips the reset suffix on 429 when Retry-After is an HTTP-date", async () => {
    process.env.CLAWHUB_TOKEN = "env-token-123";
    await expect(
      searchClawHubSkills({
        query: "calendar",
        fetchImpl: async () =>
          new Response("Rate limit exceeded", {
            status: 429,
            headers: { "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" },
          }),
      }),
    ).rejects.toThrow(/Rate limit exceeded$/);
  });

  it("times out and cancels stalled skill archive body reads", async () => {
    const stalled = createStalledBodyResponse({
      firstChunk: new Uint8Array([4]),
      headers: { "content-type": "application/zip" },
    });

    await expect(
      downloadClawHubSkillArchive({
        slug: "agentreceipt",
        version: "1.0.0",
        timeoutMs: 5,
        fetchImpl: async () => stalled.response,
      }),
    ).rejects.toThrow(/skill archive download for agentreceipt body stalled after 5ms/i);
    expect(stalled.cancel).toHaveBeenCalledTimes(1);
    expect(stalled.cancel.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it("times out and cancels stalled package archive body reads", async () => {
    const stalled = createStalledBodyResponse({
      firstChunk: new Uint8Array([1]),
      headers: { "content-type": "application/zip" },
    });

    await expect(
      downloadClawHubPackageArchive({
        name: "@hyf/zai-external-alpha",
        version: "0.0.1",
        timeoutMs: 5,
        fetchImpl: async () => stalled.response,
      }),
    ).rejects.toThrow(
      /package archive download for @hyf\/zai-external-alpha body stalled after 5ms/i,
    );
    expect(stalled.cancel).toHaveBeenCalledTimes(1);
    expect(stalled.cancel.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it("times out and cancels stalled ClawPack artifact body reads", async () => {
    const stalled = createStalledBodyResponse({
      firstChunk: new Uint8Array([7]),
      headers: { "content-type": "application/octet-stream" },
    });

    await expect(
      downloadClawHubPackageArchive({
        name: "demo",
        version: "1.2.3",
        artifact: "clawpack",
        timeoutMs: 5,
        fetchImpl: async () => stalled.response,
      }),
    ).rejects.toThrow(/ClawPack download for demo@1.2.3 body stalled after 5ms/i);
    expect(stalled.cancel).toHaveBeenCalledTimes(1);
    expect(stalled.cancel.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it("downloads skill archives to sanitized temp paths and cleans them up", async () => {
    const archive = await downloadClawHubSkillArchive({
      slug: "agentreceipt",
      version: "1.0.0",
      fetchImpl: async () =>
        new Response(new Uint8Array([4, 5, 6]), {
          status: 200,
          headers: { "content-type": "application/zip" },
        }),
    });

    try {
      expect(path.basename(archive.archivePath)).toBe("agentreceipt.zip");
      await expect(fs.readFile(archive.archivePath)).resolves.toEqual(Buffer.from([4, 5, 6]));
    } finally {
      const archiveDir = path.dirname(archive.archivePath);
      await archive.cleanup();
      await expectPathMissing(archiveDir);
    }
  });

  it("sends owner-qualified skill archive downloads as slug plus ownerHandle", async () => {
    let requestedUrl = "";
    const archive = await downloadClawHubSkillArchive({
      slug: "weather",
      ownerHandle: "demo-owner",
      version: "1.0.0",
      fetchImpl: async (input) => {
        requestedUrl = input instanceof Request ? input.url : String(input);
        return new Response(new Uint8Array([7, 8, 9]), {
          status: 200,
          headers: { "content-type": "application/zip" },
        });
      },
    });

    try {
      const url = new URL(requestedUrl);
      expect(url.pathname).toBe("/api/v1/download");
      expect(url.searchParams.get("slug")).toBe("weather");
      expect(url.searchParams.get("ownerHandle")).toBe("demo-owner");
      expect(url.searchParams.get("version")).toBe("1.0.0");
    } finally {
      await archive.cleanup();
    }
  });

  it("does not send ambient ClawHub auth tokens to off-registry resolver archive URLs", async () => {
    process.env.CLAWHUB_TOKEN = "env-token-123";
    let requestedUrl = "";
    let requestedInit: RequestInit | undefined;

    const archive = await downloadClawHubSkillArchiveUrl({
      baseUrl: "https://clawhub.ai",
      url: "https://codeload.github.com/NVIDIA/skills/zip/abcdef",
      fetchImpl: async (input, init) => {
        requestedUrl = input instanceof Request ? input.url : String(input);
        requestedInit = init;
        return new Response(new Uint8Array([7, 8, 9]), {
          status: 200,
          headers: { "content-type": "application/zip" },
        });
      },
    });

    try {
      expect(requestedUrl).toBe("https://codeload.github.com/NVIDIA/skills/zip/abcdef");
      expect(new Headers(requestedInit?.headers).get("Authorization")).toBeNull();
      await expect(fs.readFile(archive.archivePath)).resolves.toEqual(Buffer.from([7, 8, 9]));
    } finally {
      const archiveDir = path.dirname(archive.archivePath);
      await archive.cleanup();
      await expectPathMissing(archiveDir);
    }
  });
});
