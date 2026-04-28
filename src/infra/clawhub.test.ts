import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  downloadClawHubPackageArchive,
  downloadClawHubSkillArchive,
  normalizeClawHubSha256Integrity,
  normalizeClawHubSha256Hex,
  parseClawHubPluginSpec,
  resolveClawHubAuthToken,
  resolveLatestVersionFromPackage,
  satisfiesGatewayMinimum,
  satisfiesPluginApiRange,
  searchClawHubSkills,
} from "./clawhub.js";

describe("clawhub helpers", () => {
  const originalHome = process.env.HOME;

  afterEach(() => {
    delete process.env.OPENCLAW_CLAWHUB_TOKEN;
    delete process.env.CLAWHUB_TOKEN;
    delete process.env.CLAWHUB_AUTH_TOKEN;
    delete process.env.OPENCLAW_CLAWHUB_CONFIG_PATH;
    delete process.env.CLAWHUB_CONFIG_PATH;
    delete process.env.CLAWDHUB_CONFIG_PATH;
    delete process.env.XDG_CONFIG_HOME;
    if (originalHome == null) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
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

  it("checks plugin api ranges without semver dependency", () => {
    expect(satisfiesPluginApiRange("1.2.3", "^1.2.0")).toBe(true);
    expect(satisfiesPluginApiRange("1.9.0", ">=1.2.0 <2.0.0")).toBe(true);
    expect(satisfiesPluginApiRange("2.0.0", "^1.2.0")).toBe(false);
    expect(satisfiesPluginApiRange("1.1.9", ">=1.2.0")).toBe(false);
    expect(satisfiesPluginApiRange("2026.3.22", ">=2026.3.22")).toBe(true);
    expect(satisfiesPluginApiRange("2026.3.21", ">=2026.3.22")).toBe(false);
    expect(satisfiesPluginApiRange("invalid", "^1.2.0")).toBe(false);
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

  it("resolves ClawHub auth token from config.json", async () => {
    await withTempDir({ prefix: "openclaw-clawhub-config-" }, async (configRoot) => {
      const configPath = path.join(configRoot, "clawhub", "config.json");
      process.env.OPENCLAW_CLAWHUB_CONFIG_PATH = configPath;
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, JSON.stringify({ auth: { token: "cfg-token-123" } }), "utf8");

      await expect(resolveClawHubAuthToken()).resolves.toBe("cfg-token-123");
    });
  });

  it("resolves ClawHub auth token from the legacy config path override", async () => {
    await withTempDir({ prefix: "openclaw-clawdhub-config-" }, async (configRoot) => {
      const configPath = path.join(configRoot, "config.json");
      process.env.CLAWDHUB_CONFIG_PATH = configPath;
      await fs.writeFile(configPath, JSON.stringify({ token: "legacy-token-123" }), "utf8");

      await expect(resolveClawHubAuthToken()).resolves.toBe("legacy-token-123");
    });
  });

  it.runIf(process.platform === "darwin")(
    "resolves ClawHub auth token from the macOS Application Support path",
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

          await expect(resolveClawHubAuthToken()).resolves.toBe("macos-token-123");
        } finally {
          homedirSpy.mockRestore();
        }
      });
    },
  );

  it.runIf(process.platform === "darwin")(
    "falls back to XDG_CONFIG_HOME on macOS when Application Support has no config",
    async () => {
      await withTempDir({ prefix: "openclaw-clawhub-home-" }, async (fakeHome) => {
        await withTempDir({ prefix: "openclaw-clawhub-xdg-" }, async (xdgRoot) => {
          const configPath = path.join(xdgRoot, "clawhub", "config.json");
          const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
          process.env.XDG_CONFIG_HOME = xdgRoot;
          try {
            await fs.mkdir(path.dirname(configPath), { recursive: true });
            await fs.writeFile(configPath, JSON.stringify({ token: "xdg-token-123" }), "utf8");

            await expect(resolveClawHubAuthToken()).resolves.toBe("xdg-token-123");
          } finally {
            homedirSpy.mockRestore();
          }
        });
      });
    },
  );

  it("injects resolved auth token into ClawHub requests", async () => {
    process.env.OPENCLAW_CLAWHUB_TOKEN = "env-token-123";
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      expect(url).toContain("/api/v1/search");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer env-token-123");
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await expect(searchClawHubSkills({ query: "calendar", fetchImpl })).resolves.toEqual([]);
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
      await expect(fs.stat(archiveDir)).rejects.toThrow();
    }
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
      await expect(fs.stat(archiveDir)).rejects.toThrow();
    }
  });
});
