import fs from "node:fs";
import path from "node:path";
import { bundledPluginRoot } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildOfficialChannelCatalog,
  OFFICIAL_CHANNEL_CATALOG_RELATIVE_PATH,
  writeOfficialChannelCatalog,
} from "../scripts/write-official-channel-catalog.mjs";
import { describePluginInstallSource } from "../src/plugins/install-source-info.js";
import { cleanupTempDirs, makeTempRepoRoot, writeJsonFile } from "./helpers/temp-repo.js";

const tempDirs: string[] = [];

function makeRepoRoot(prefix: string): string {
  return makeTempRepoRoot(tempDirs, prefix);
}

function writeJson(filePath: string, value: unknown): void {
  writeJsonFile(filePath, value);
}

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

describe("buildOfficialChannelCatalog", () => {
  it("includes publishable official channel plugins and skips non-publishable entries", () => {
    const repoRoot = makeRepoRoot("openclaw-official-channel-catalog-");
    writeJson(path.join(repoRoot, "extensions", "whatsapp", "package.json"), {
      name: "@openclaw/whatsapp",
      version: "2026.3.23",
      description: "OpenClaw WhatsApp channel plugin",
      openclaw: {
        channel: {
          id: "whatsapp",
          label: "WhatsApp",
          selectionLabel: "WhatsApp (QR link)",
          detailLabel: "WhatsApp Web",
          docsPath: "/channels/whatsapp",
          blurb: "works with your own number; recommend a separate phone + eSIM.",
        },
        install: {
          npmSpec: "@openclaw/whatsapp",
          localPath: bundledPluginRoot("whatsapp"),
          defaultChoice: "npm",
        },
        release: {
          publishToNpm: true,
        },
      },
    });
    writeJson(path.join(repoRoot, "extensions", "local-only", "package.json"), {
      name: "@openclaw/local-only",
      openclaw: {
        channel: {
          id: "local-only",
          label: "Local Only",
          selectionLabel: "Local Only",
          docsPath: "/channels/local-only",
          blurb: "dev only",
        },
        install: {
          localPath: bundledPluginRoot("local-only"),
        },
        release: {
          publishToNpm: false,
        },
      },
    });

    expect(buildOfficialChannelCatalog({ repoRoot }).entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "@wecom/wecom-openclaw-plugin",
          openclaw: expect.objectContaining({
            plugin: {
              id: "wecom-openclaw-plugin",
              label: "WeCom",
            },
            channel: expect.objectContaining({
              id: "wecom",
              label: "WeCom",
            }),
            install: {
              npmSpec: "@wecom/wecom-openclaw-plugin@2026.4.23",
              defaultChoice: "npm",
              expectedIntegrity:
                "sha512-bnzfdIEEu1/LFvcdyjaTkyxt27w6c7dqhkPezU62OWaqmcdFsUGR3T55USK/O9pIKsNcnL1Tnu1pqKYCWHFgWQ==",
            },
          }),
        }),
        expect.objectContaining({
          name: "openclaw-plugin-yuanbao",
          openclaw: expect.objectContaining({
            plugin: {
              id: "openclaw-plugin-yuanbao",
              label: "Yuanbao",
            },
            channel: expect.objectContaining({
              id: "yuanbao",
              label: "Yuanbao",
            }),
            install: {
              npmSpec: "openclaw-plugin-yuanbao@2.11.0",
              defaultChoice: "npm",
              expectedIntegrity:
                "sha512-lYmBrU71ox3v7dzRqaltvzTXPcMjjgYrNqpBj5HIBkXgEFkXRRG8wplXg9Fub41/FjsSPn3WAbYpdTc+k+jsHg==",
            },
          }),
        }),
        expect.objectContaining({
          name: "@openclaw/whatsapp",
          description: "OpenClaw WhatsApp channel plugin",
          source: "official",
          openclaw: expect.objectContaining({
            channel: expect.objectContaining({
              id: "whatsapp",
              label: "WhatsApp",
              selectionLabel: "WhatsApp (QR link)",
              detailLabel: "WhatsApp Web",
              docsPath: "/channels/whatsapp",
            }),
            install: expect.objectContaining({
              npmSpec: "@openclaw/whatsapp",
              defaultChoice: "npm",
            }),
          }),
        }),
      ]),
    );
  });

  it("keeps third-party official external catalog npm sources exactly pinned", () => {
    const repoRoot = makeRepoRoot("openclaw-official-channel-catalog-policy-");
    const entries = buildOfficialChannelCatalog({ repoRoot }).entries.filter(
      (entry) => entry.source === "external" && !entry.name?.startsWith("@openclaw/"),
    );

    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const installSource = describePluginInstallSource(entry.openclaw?.install ?? {});
      expect(installSource.warnings).toEqual([]);
      expect(installSource.npm?.pinState).toBe("exact-with-integrity");
    }
  });

  it("allows official OpenClaw channel npm specs without integrity during launch", () => {
    const repoRoot = makeRepoRoot("openclaw-official-channel-catalog-openclaw-policy-");
    const twitch = buildOfficialChannelCatalog({ repoRoot }).entries.find(
      (entry) => entry.openclaw?.channel?.id === "twitch",
    );

    expect(twitch).toEqual(
      expect.objectContaining({
        name: "@openclaw/twitch",
        openclaw: expect.objectContaining({
          install: {
            npmSpec: "@openclaw/twitch",
            defaultChoice: "npm",
            minHostVersion: ">=2026.4.10",
          },
        }),
      }),
    );
    const installSource = describePluginInstallSource(twitch?.openclaw?.install ?? {});
    expect(installSource.npm?.pinState).toBe("floating-without-integrity");
    expect(installSource.warnings).toEqual(["npm-spec-floating", "npm-spec-missing-integrity"]);
  });

  it("writes the official catalog under dist", () => {
    const repoRoot = makeRepoRoot("openclaw-official-channel-catalog-write-");
    writeJson(path.join(repoRoot, "extensions", "whatsapp", "package.json"), {
      name: "@openclaw/whatsapp",
      openclaw: {
        channel: {
          id: "whatsapp",
          label: "WhatsApp",
          selectionLabel: "WhatsApp",
          docsPath: "/channels/whatsapp",
          blurb: "wa",
        },
        install: {
          npmSpec: "@openclaw/whatsapp",
        },
        release: {
          publishToNpm: true,
        },
      },
    });

    writeOfficialChannelCatalog({ repoRoot });

    const outputPath = path.join(repoRoot, OFFICIAL_CHANNEL_CATALOG_RELATIVE_PATH);
    expect(fs.existsSync(outputPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(outputPath, "utf8")).entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "@wecom/wecom-openclaw-plugin",
        }),
        expect.objectContaining({
          name: "openclaw-plugin-yuanbao",
        }),
        expect.objectContaining({
          name: "@openclaw/whatsapp",
          source: "official",
          openclaw: expect.objectContaining({
            channel: expect.objectContaining({
              id: "whatsapp",
              label: "WhatsApp",
              selectionLabel: "WhatsApp (QR link)",
              docsPath: "/channels/whatsapp",
            }),
            install: expect.objectContaining({
              npmSpec: "@openclaw/whatsapp",
              defaultChoice: "npm",
            }),
          }),
        }),
      ]),
    );
    const whatsappEntries = JSON.parse(fs.readFileSync(outputPath, "utf8")).entries.filter(
      (entry: { openclaw?: { channel?: { id?: string } } }) =>
        entry.openclaw?.channel?.id === "whatsapp",
    );
    expect(whatsappEntries).toHaveLength(1);
  });
});
