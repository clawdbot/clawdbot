// Official channel catalog tests validate catalog metadata and entries.
import fs from "node:fs";
import path from "node:path";
import { bundledPluginRoot } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildOfficialChannelCatalog,
  checkOfficialChannelCatalogSource,
  OFFICIAL_CHANNEL_CATALOG_RELATIVE_PATH,
  OFFICIAL_CHANNEL_CATALOG_SOURCE_RELATIVE_PATH,
  writeOfficialChannelCatalog,
  writeOfficialChannelCatalogSource,
} from "../scripts/write-official-channel-catalog.mjs";
import { describePluginInstallSource } from "../src/plugins/install-source-info.js";
import { cleanupTempDirs, makeTempRepoRoot, writeJsonFile } from "./helpers/temp-repo.js";

const tempDirs: string[] = [];

type OfficialChannelCatalogEntry = ReturnType<
  typeof buildOfficialChannelCatalog
>["entries"][number];
type OfficialChannelInstall = NonNullable<
  NonNullable<OfficialChannelCatalogEntry["openclaw"]>["install"]
>;

function makeRepoRoot(prefix: string): string {
  return makeTempRepoRoot(tempDirs, prefix);
}

function writeJson(filePath: string, value: unknown): void {
  writeJsonFile(filePath, value);
}

function requireInstall(entry: OfficialChannelCatalogEntry | undefined): OfficialChannelInstall {
  const install = entry?.openclaw?.install;
  if (!install) {
    throw new Error("expected official channel install config");
  }
  return install;
}

function requireNpmInstallSource(source: ReturnType<typeof describePluginInstallSource>) {
  if (!source.npm) {
    throw new Error("expected npm install source");
  }
  return source.npm;
}

function findCatalogEntry(
  entries: OfficialChannelCatalogEntry[],
  predicate: (entry: OfficialChannelCatalogEntry) => boolean,
): OfficialChannelCatalogEntry {
  const entry = entries.find(predicate);
  if (!entry) {
    throw new Error("expected official channel catalog entry");
  }
  return entry;
}

function summarizeCatalogEntry(entry: OfficialChannelCatalogEntry) {
  return {
    name: entry.name,
    description: entry.description,
    source: entry.source,
    plugin: entry.openclaw?.plugin,
    catalog: entry.openclaw?.catalog,
    contracts: entry.openclaw?.contracts,
    channel: entry.openclaw?.channel,
    channelConfigs: entry.openclaw?.channelConfigs,
    providerEndpoints: entry.openclaw?.providerEndpoints,
    install: entry.openclaw?.install,
  };
}

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

describe("buildOfficialChannelCatalog", () => {
  it("keeps the committed official catalog synchronized with repository manifests", () => {
    expect(checkOfficialChannelCatalogSource({ repoRoot: process.cwd() })).toBe(true);
  });

  it("lets publishable package metadata override same-id seeds and skips non-publishable entries", () => {
    const repoRoot = makeRepoRoot("openclaw-official-channel-catalog-");
    writeJson(path.join(repoRoot, "extensions", "wecom", "package.json"), {
      name: "@openclaw/wecom",
      version: "2026.8.1",
      description: "Repository-owned WeCom channel",
      openclaw: {
        channel: {
          id: "wecom",
          label: "Repository WeCom",
          selectionLabel: "Repository WeCom",
          docsPath: "/channels/wecom",
          blurb: "package metadata wins",
          configuredState: {
            env: {
              anyOf: ["WECOM_BOT_TOKEN"],
            },
          },
        },
        install: {
          npmSpec: "@openclaw/wecom",
          defaultChoice: "npm",
        },
        release: {
          publishToNpm: true,
        },
      },
    });
    writeJson(path.join(repoRoot, "extensions", "wecom", "openclaw.plugin.json"), {
      id: "wecom",
      catalog: {
        featured: true,
        order: 45,
      },
      contracts: {
        tools: ["wecom_tool"],
      },
      channelConfigs: {
        wecom: {
          label: "Repository WeCom",
          description: "Repository WeCom channel.",
          schema: {
            type: "object",
            additionalProperties: true,
          },
        },
      },
      providerEndpoints: [
        {
          endpointClass: "wecom",
          hosts: ["api.example.com"],
        },
      ],
      configSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
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

    const entries = buildOfficialChannelCatalog({ repoRoot }).entries;

    expect(
      summarizeCatalogEntry(
        findCatalogEntry(entries, (entry) => entry.openclaw?.channel?.id === "wecom"),
      ),
    ).toEqual({
      name: "@openclaw/wecom",
      description: "Repository-owned WeCom channel",
      source: "official",
      plugin: undefined,
      catalog: {
        featured: true,
        order: 45,
      },
      contracts: {
        tools: ["wecom_tool"],
      },
      channel: {
        id: "wecom",
        label: "Repository WeCom",
        selectionLabel: "Repository WeCom",
        docsPath: "/channels/wecom",
        blurb: "package metadata wins",
        configuredState: {
          env: {
            anyOf: ["WECOM_BOT_TOKEN"],
          },
        },
      },
      channelConfigs: {
        wecom: {
          label: "Repository WeCom",
          description: "Repository WeCom channel.",
          schema: {
            type: "object",
            additionalProperties: true,
          },
        },
      },
      providerEndpoints: [
        {
          endpointClass: "wecom",
          hosts: ["api.example.com"],
        },
      ],
      install: {
        npmSpec: "@openclaw/wecom",
        defaultChoice: "npm",
      },
    });
    expect(
      summarizeCatalogEntry(
        findCatalogEntry(entries, (entry) => entry.name === "openclaw-plugin-yuanbao"),
      ),
    ).toEqual({
      name: "openclaw-plugin-yuanbao",
      description: "OpenClaw Yuanbao channel plugin by the Tencent Yuanbao team.",
      source: "external",
      plugin: {
        id: "openclaw-plugin-yuanbao",
        label: "Yuanbao",
      },
      catalog: undefined,
      contracts: {
        tools: ["query_group_info", "query_session_members", "yuanbao_remind"],
      },
      channel: {
        id: "yuanbao",
        label: "Yuanbao",
        selectionLabel: "Yuanbao (元宝)",
        detailLabel: "Yuanbao",
        docsLabel: "yuanbao",
        docsPath: "/plugins/community#yuanbao",
        blurb: "Tencent Yuanbao AI assistant conversation channel.",
        order: 85,
        aliases: ["yuanbao", "yb", "tencent-yuanbao", "元宝"],
      },
      channelConfigs: {
        yuanbao: {
          label: "Yuanbao",
          description: "Tencent Yuanbao AI assistant channel.",
          schema: {
            type: "object",
            additionalProperties: true,
          },
        },
      },
      providerEndpoints: undefined,
      install: {
        npmSpec: "openclaw-plugin-yuanbao@2.15.0",
        defaultChoice: "npm",
        expectedIntegrity:
          "sha512-3GD+mf3EjTSUTOAREjTHAyp/deXdpgqB+q+xE0b19Qtat4ADhUV1mHDwFkVCRqTCBY5ATFKtKcipoDejqFj/+w==",
      },
    });
    expect(entries.some((entry) => entry.openclaw?.channel?.id === "local-only")).toBe(false);
  });

  it("preserves manifest-owned fallback metadata for externalized channel packages", () => {
    const entries = buildOfficialChannelCatalog({ repoRoot: process.cwd() }).entries;
    const slack = findCatalogEntry(entries, (entry) => entry.openclaw?.channel?.id === "slack");
    const raft = findCatalogEntry(entries, (entry) => entry.openclaw?.channel?.id === "raft");
    const clickclack = findCatalogEntry(
      entries,
      (entry) => entry.openclaw?.channel?.id === "clickclack",
    );

    expect(slack.openclaw.channelConfigs?.slack?.schema).toEqual({
      type: "object",
      additionalProperties: true,
    });
    expect(raft.openclaw.channelConfigs?.raft?.schema).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
    expect(clickclack.openclaw.contracts?.tools).toEqual(["discussion"]);
  });

  it("rejects duplicate channel ids from repository packages", () => {
    const repoRoot = makeRepoRoot("openclaw-official-channel-catalog-duplicate-");
    for (const dirName of ["first", "second"]) {
      writeJson(path.join(repoRoot, "extensions", dirName, "package.json"), {
        name: `@openclaw/${dirName}`,
        openclaw: {
          channel: {
            id: "duplicate",
            label: dirName,
          },
          install: {
            npmSpec: `@openclaw/${dirName}`,
          },
          release: {
            publishToNpm: true,
          },
        },
      });
    }

    expect(() => buildOfficialChannelCatalog({ repoRoot })).toThrow(
      'duplicate official channel id "duplicate"',
    );
  });

  it("keeps the hand-authored seed limited to out-of-tree external channels", () => {
    const seed = JSON.parse(
      fs.readFileSync(path.resolve("scripts/lib/official-external-channel-seed.json"), "utf8"),
    ) as {
      entries: Array<{
        name?: string;
        source?: string;
        openclaw?: { channel?: { id?: string } };
      }>;
    };
    const publishableChannelIds = new Set(
      fs.readdirSync(path.resolve("extensions")).flatMap((dirName) => {
        const packageJsonPath = path.resolve("extensions", dirName, "package.json");
        if (!fs.existsSync(packageJsonPath)) {
          return [];
        }
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
          openclaw?: {
            channel?: { id?: string };
            release?: { publishToNpm?: boolean };
          };
        };
        const channelId = packageJson.openclaw?.channel?.id;
        return channelId && packageJson.openclaw?.release?.publishToNpm === true ? [channelId] : [];
      }),
    );
    const seedChannelIds = seed.entries.map((entry) => entry.openclaw?.channel?.id?.toLowerCase());

    expect(seed.entries.every((entry) => entry.source === "external")).toBe(true);
    expect(seed.entries.some((entry) => entry.name?.startsWith("@openclaw/"))).toBe(false);
    expect(new Set(seedChannelIds).size).toBe(seedChannelIds.length);
    expect(
      seed.entries.some((entry) => {
        const channelId = entry.openclaw?.channel?.id;
        return channelId ? publishableChannelIds.has(channelId) : false;
      }),
    ).toBe(false);
  });

  it("keeps third-party official external catalog npm sources exactly pinned", () => {
    const repoRoot = makeRepoRoot("openclaw-official-channel-catalog-policy-");
    const entries = buildOfficialChannelCatalog({ repoRoot }).entries.filter(
      (entry) => entry.source === "external" && !entry.name?.startsWith("@openclaw/"),
    );

    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const installSource = describePluginInstallSource(requireInstall(entry));
      expect(installSource.warnings).toStrictEqual([]);
      expect(requireNpmInstallSource(installSource).pinState).toBe("exact-with-integrity");
    }
  });

  it("allows official OpenClaw channel npm specs without integrity during launch", () => {
    const repoRoot = makeRepoRoot("openclaw-official-channel-catalog-openclaw-policy-");
    writeJson(path.join(repoRoot, "extensions", "twitch", "package.json"), {
      name: "@openclaw/twitch",
      openclaw: {
        channel: {
          id: "twitch",
          label: "Twitch",
          docsPath: "/channels/twitch",
        },
        install: {
          npmSpec: "@openclaw/twitch",
          defaultChoice: "npm",
          minHostVersion: ">=2026.4.10",
        },
        release: {
          publishToNpm: true,
        },
      },
    });
    const twitch = buildOfficialChannelCatalog({ repoRoot }).entries.find(
      (entry) => entry.openclaw?.channel?.id === "twitch",
    );

    expect({
      name: twitch?.name,
      install: twitch?.openclaw?.install,
    }).toEqual({
      name: "@openclaw/twitch",
      install: {
        npmSpec: "@openclaw/twitch",
        defaultChoice: "npm",
        minHostVersion: ">=2026.4.10",
      },
    });
    const installSource = describePluginInstallSource(requireInstall(twitch));
    expect(requireNpmInstallSource(installSource).pinState).toBe("floating-without-integrity");
    expect(installSource.warnings).toEqual(["npm-spec-floating", "npm-spec-missing-integrity"]);
  });

  it("keeps iMessage available for cold install after core package externalization", () => {
    const repoRoot = makeRepoRoot("openclaw-official-channel-catalog-imessage-");
    writeJson(path.join(repoRoot, "extensions", "imessage", "package.json"), {
      name: "@openclaw/imessage",
      openclaw: {
        channel: {
          id: "imessage",
          label: "iMessage",
          aliases: ["imsg"],
          docsPath: "/channels/imessage",
        },
        install: {
          clawhubSpec: "clawhub:@openclaw/imessage",
          npmSpec: "@openclaw/imessage",
          defaultChoice: "npm",
          minHostVersion: ">=2026.7.2",
          allowInvalidConfigRecovery: true,
        },
        release: {
          publishToNpm: true,
        },
      },
    });
    const imessage = buildOfficialChannelCatalog({ repoRoot }).entries.find(
      (entry) => entry.openclaw?.channel?.id === "imessage",
    );

    expect({
      name: imessage?.name,
      aliases: imessage?.openclaw?.channel?.aliases,
      install: imessage?.openclaw?.install,
    }).toEqual({
      name: "@openclaw/imessage",
      aliases: ["imsg"],
      install: {
        clawhubSpec: "clawhub:@openclaw/imessage",
        npmSpec: "@openclaw/imessage",
        defaultChoice: "npm",
        minHostVersion: ">=2026.7.2",
        allowInvalidConfigRecovery: true,
      },
    });
  });

  it("preserves ClawHub specs when generating publishable channel catalog entries", () => {
    const repoRoot = makeRepoRoot("openclaw-official-channel-catalog-clawhub-");
    writeJson(path.join(repoRoot, "extensions", "storepack-chat", "package.json"), {
      name: "@openclaw/storepack-chat",
      openclaw: {
        channel: {
          id: "storepack-chat",
          label: "Storepack Chat",
          selectionLabel: "Storepack Chat",
          docsPath: "/channels/storepack-chat",
          blurb: "storepack-first channel",
        },
        install: {
          clawhubSpec: "clawhub:@openclaw/storepack-chat",
          npmSpec: "@openclaw/storepack-chat",
          defaultChoice: "clawhub",
        },
        release: {
          publishToNpm: true,
        },
      },
    });

    const entry = buildOfficialChannelCatalog({ repoRoot }).entries.find(
      (candidate) => candidate.openclaw?.channel?.id === "storepack-chat",
    );

    expect(requireInstall(entry)).toEqual({
      clawhubSpec: "clawhub:@openclaw/storepack-chat",
      npmSpec: "@openclaw/storepack-chat",
      defaultChoice: "clawhub",
    });
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
    const entries = JSON.parse(fs.readFileSync(outputPath, "utf8")).entries;
    expect(entries.map((entry: { name?: string }) => entry.name)).toContain(
      "@wecom/wecom-openclaw-plugin",
    );
    expect(entries.map((entry: { name?: string }) => entry.name)).toContain(
      "openclaw-plugin-yuanbao",
    );
    const whatsappEntry = findCatalogEntry(
      entries,
      (entry: { openclaw?: { channel?: { id?: string } } }) =>
        entry.openclaw?.channel?.id === "whatsapp",
    );
    expect(summarizeCatalogEntry(whatsappEntry)).toEqual({
      name: "@openclaw/whatsapp",
      description: undefined,
      source: "official",
      plugin: undefined,
      catalog: undefined,
      contracts: undefined,
      channel: {
        id: "whatsapp",
        label: "WhatsApp",
        selectionLabel: "WhatsApp",
        docsPath: "/channels/whatsapp",
        blurb: "wa",
      },
      channelConfigs: undefined,
      providerEndpoints: undefined,
      install: {
        npmSpec: "@openclaw/whatsapp",
      },
    });
    const whatsappEntries = entries.filter(
      (entry: { openclaw?: { channel?: { id?: string } } }) =>
        entry.openclaw?.channel?.id === "whatsapp",
    );
    expect(whatsappEntries).toHaveLength(1);
  });

  it("writes and checks the committed official catalog", () => {
    const repoRoot = makeRepoRoot("openclaw-official-channel-catalog-source-");
    writeJson(path.join(repoRoot, "extensions", "demo", "package.json"), {
      name: "@openclaw/demo",
      openclaw: {
        channel: {
          id: "demo",
          label: "Demo",
          docsPath: "/channels/demo",
        },
        install: {
          npmSpec: "@openclaw/demo",
        },
        release: {
          publishToNpm: true,
        },
      },
    });

    expect(checkOfficialChannelCatalogSource({ repoRoot })).toBe(false);
    expect(writeOfficialChannelCatalogSource({ repoRoot })).toBe(true);
    expect(checkOfficialChannelCatalogSource({ repoRoot })).toBe(true);
    expect(writeOfficialChannelCatalogSource({ repoRoot })).toBe(false);

    const sourcePath = path.join(repoRoot, OFFICIAL_CHANNEL_CATALOG_SOURCE_RELATIVE_PATH);
    fs.writeFileSync(sourcePath, "{}\n", "utf8");
    expect(checkOfficialChannelCatalogSource({ repoRoot })).toBe(false);
  });
});
