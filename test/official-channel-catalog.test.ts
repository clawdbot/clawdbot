// Official channel catalog tests validate catalog metadata and entries.
import fs from "node:fs";
import path from "node:path";
import { bundledPluginRoot } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildOfficialChannelDocsCatalog,
  buildOfficialChannelCatalog,
  checkOfficialChannelDocsIndex,
  checkOfficialChannelCatalogSource,
  findDuplicateOfficialChannelDocsNavRoutes,
  findMissingOfficialChannelDocsNavRoutes,
  findUnexpectedOfficialChannelDocsNavRoutes,
  OFFICIAL_CHANNEL_CATALOG_RELATIVE_PATH,
  OFFICIAL_CHANNEL_CATALOG_SOURCE_RELATIVE_PATH,
  OFFICIAL_CHANNEL_DOCS_INDEX_RELATIVE_PATH,
  renderOfficialChannelDocsIndex,
  writeOfficialChannelCatalog,
  writeOfficialChannelDocsIndex,
  writeOfficialChannelCatalogSource,
} from "../scripts/write-official-channel-catalog.mts";
import { describePluginInstallSource } from "../src/plugins/install-source-info.js";
import { cleanupTempDirs, makeTempDir as makeTempRepoRoot } from "./helpers/temp-dir.js";
import { writeJsonFile } from "./helpers/temp-repo.js";

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

function writeChannelDocContent(repoRoot: string, docsPath: string, content: string): void {
  const route = docsPath.replace(/^\/+/u, "");
  const filePath = path.join(repoRoot, "docs", `${route}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function writeChannelDoc(repoRoot: string, docsPath: string, title: string, summary: string): void {
  writeChannelDocContent(
    repoRoot,
    docsPath,
    `---\nsummary: ${JSON.stringify(summary)}\ntitle: ${JSON.stringify(title)}\n---\n`,
  );
}

function writeExternalChannelDocs(repoRoot: string): void {
  const seed = JSON.parse(
    fs.readFileSync(path.resolve("scripts/lib/official-external-channel-seed.json"), "utf8"),
  ) as {
    entries: Array<{
      openclaw?: { channel?: { docsPath?: string; id?: string; label?: string } };
    }>;
  };
  for (const entry of seed.entries) {
    const channel = entry.openclaw?.channel;
    if (!channel?.docsPath || !channel.label) {
      continue;
    }
    const title = channel.id === "openclaw-weixin" ? "WeChat" : channel.label;
    writeChannelDoc(repoRoot, channel.docsPath, title, `${title} test summary`);
  }
  writeChannelDoc(repoRoot, "/web/webchat", "WebChat", "Gateway WebChat UI over WebSocket");
}

function writeEnglishDocsNavigation(
  repoRoot: string,
  channelPages: string[],
  otherPages: string[] = [],
): void {
  writeJson(path.join(repoRoot, "docs", "docs.json"), {
    navigation: {
      languages: [
        {
          language: "en",
          tabs: [
            {
              tab: "Channels",
              groups: [{ group: "Test channels", pages: channelPages }],
            },
            {
              tab: "Other",
              groups: [{ group: "Other pages", pages: otherPages }],
            },
          ],
        },
      ],
    },
  });
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
    const catalog = buildOfficialChannelCatalog({ repoRoot: process.cwd() });
    const serialized = fs.readFileSync(OFFICIAL_CHANNEL_CATALOG_SOURCE_RELATIVE_PATH, "utf8");
    const lines = serialized.split("\n");

    expect(JSON.parse(serialized)).toEqual(catalog);
    expect(lines).toHaveLength(catalog.entries.length + 5);
    expect(lines.slice(2, -3)).toEqual(
      catalog.entries.map(
        (entry, index) =>
          `    ${JSON.stringify(entry)}${index === catalog.entries.length - 1 ? "" : ","}`,
      ),
    );
    expect(lines.at(-1)).toBe("");
  });

  it("keeps the generated channel docs index and navigation synchronized", () => {
    expect(checkOfficialChannelDocsIndex({ repoRoot: process.cwd() })).toBe(true);
    expect(findMissingOfficialChannelDocsNavRoutes({ repoRoot: process.cwd() })).toEqual([]);
    expect(findUnexpectedOfficialChannelDocsNavRoutes({ repoRoot: process.cwd() })).toEqual([]);
    expect(findDuplicateOfficialChannelDocsNavRoutes({ repoRoot: process.cwd() })).toEqual([]);

    const entries = buildOfficialChannelDocsCatalog({ repoRoot: process.cwd() }).entries;
    expect(entries.find((entry) => entry.id === "openclaw-weixin")).toMatchObject({
      label: "WeChat",
      summary: "WeChat channel setup through the external openclaw-weixin plugin",
    });
    expect(entries.map((entry) => entry.id)).toEqual(
      expect.arrayContaining(["reef", "telegram", "webchat"]),
    );
    expect(entries.map((entry) => entry.id)).not.toEqual(
      expect.arrayContaining(["qa-channel", "voice-call"]),
    );
    const rendered = renderOfficialChannelDocsIndex({ repoRoot: process.cwd() });
    expect(rendered).toContain(
      "[Voice Call](/plugins/voice-call) - Telephony via Plivo, Telnyx, or Twilio",
    );
    expect(rendered).not.toContain("Very well supported right now");
    expect(rendered).not.toContain('David Reagans: "Hop on Discord."');
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
        docsPath: "/channels/yuanbao",
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
        npmSpec: "openclaw-plugin-yuanbao@2.18.2",
        defaultChoice: "npm",
        expectedIntegrity:
          "sha512-cL85zWLePhi/GWRsXL8ogS4tejNuCE/J0V/OYhDFJzElF2TmndVCUAXaJdssgv/ULJ9sBaic88wAzRllIgZIwA==",
      },
    });
    expect(
      summarizeCatalogEntry(
        findCatalogEntry(entries, (entry) => entry.name === "@tencent-connect/openclaw-qqbot"),
      ),
    ).toMatchObject({
      name: "@tencent-connect/openclaw-qqbot",
      source: "external",
      plugin: {
        id: "openclaw-qqbot",
        label: "QQ Bot",
      },
      contracts: {
        tools: ["qqbot_platform_api", "qqbot_remind"],
      },
      channel: {
        id: "qqbot",
        docsPath: "/channels/qqbot",
        approvalFlags: ["native"],
      },
      install: {
        npmSpec: "@tencent-connect/openclaw-qqbot@2.0.1",
        defaultChoice: "npm",
        expectedIntegrity:
          "sha512-2010PaCummeQaxerLtaGfQ/5HChiXaW/KpTERid7V/1zyTs46S2ACi0hgZQ1SB7tH0t1InWr8tzVBJV/pLss3Q==",
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

  it("projects bundled, external, and built-in channels into docs while hiding source-only channels", () => {
    const repoRoot = makeRepoRoot("openclaw-official-channel-docs-");
    writeJson(path.join(repoRoot, "package.json"), {
      files: ["dist/extensions/**", "!dist/extensions/hidden/**"],
    });
    writeJson(path.join(repoRoot, "extensions", "bundled", "package.json"), {
      name: "@openclaw/bundled",
      openclaw: {
        channel: {
          id: "bundled",
          label: "Bundled",
          docsPath: "/channels/bundled",
          blurb: "bundled test channel",
        },
      },
    });
    writeJson(path.join(repoRoot, "extensions", "hidden", "package.json"), {
      name: "@openclaw/hidden",
      openclaw: {
        channel: {
          id: "hidden",
          label: "Hidden",
          docsPath: "/channels/hidden",
          blurb: "hidden test channel",
          exposure: {
            docs: false,
          },
        },
      },
    });
    writeExternalChannelDocs(repoRoot);
    writeChannelDoc(repoRoot, "/channels/bundled", "Bundled Chat", "Public bundled summary");

    const entries = buildOfficialChannelDocsCatalog({ repoRoot }).entries;

    expect(entries.find((entry) => entry.id === "bundled")).toEqual({
      id: "bundled",
      label: "Bundled Chat",
      docsPath: "/channels/bundled",
      summary: "Public bundled summary",
      source: "bundled",
    });
    expect(entries.some((entry) => entry.id === "hidden")).toBe(false);
    expect(entries.find((entry) => entry.id === "webchat")).toEqual({
      id: "webchat",
      label: "WebChat",
      docsPath: "/web/webchat",
      summary: "Gateway WebChat UI over WebSocket",
      source: "built-in",
    });
    expect(entries.find((entry) => entry.id === "wecom")?.docsPath).toBe("/channels/wecom");
    expect(entries.find((entry) => entry.id === "yuanbao")?.docsPath).toBe("/channels/yuanbao");
    expect(entries.find((entry) => entry.id === "qqbot")?.source).toBe("official");
  });

  it("uses the canonical channel docs route when a manifest omits docsPath", () => {
    const repoRoot = makeRepoRoot("openclaw-default-channel-docs-route-");
    writeJson(path.join(repoRoot, "extensions", "defaulted", "package.json"), {
      name: "@openclaw/defaulted",
      openclaw: {
        channel: {
          id: "defaulted",
          label: "Defaulted",
        },
      },
    });
    writeExternalChannelDocs(repoRoot);
    writeChannelDoc(repoRoot, "/channels/defaulted", "Defaulted Chat", "Default route summary");

    expect(
      buildOfficialChannelDocsCatalog({ repoRoot }).entries.find(
        (entry) => entry.id === "defaulted",
      ),
    ).toEqual({
      id: "defaulted",
      label: "Defaulted Chat",
      docsPath: "/channels/defaulted",
      summary: "Default route summary",
      source: "bundled",
    });
  });

  it("rejects docs-visible source-only channels", () => {
    const repoRoot = makeRepoRoot("openclaw-source-only-channel-docs-");
    writeJson(path.join(repoRoot, "package.json"), {
      files: ["dist/extensions/**", "!dist/extensions/source-only/**"],
    });
    writeJson(path.join(repoRoot, "extensions", "source-only", "package.json"), {
      name: "@openclaw/source-only",
      openclaw: {
        channel: {
          id: "source-only",
          label: "Source Only",
          docsPath: "/channels/source-only",
        },
      },
    });

    expect(() => buildOfficialChannelDocsCatalog({ repoRoot })).toThrow(
      "docs-visible channel source-only is neither bundled nor installable",
    );
  });

  it.each([
    {
      name: "missing docs file",
      content: null,
      error: "channel frontmatter-test docs route does not resolve",
    },
    {
      name: "missing frontmatter",
      content: "# Frontmatter test\n",
      error: "docs/channels/frontmatter-test.md is missing YAML frontmatter",
    },
    {
      name: "missing title",
      content: '---\nsummary: "Summary"\n---\n',
      error: "docs/channels/frontmatter-test.md must define title and summary",
    },
    {
      name: "missing summary",
      content: '---\ntitle: "Frontmatter test"\n---\n',
      error: "docs/channels/frontmatter-test.md must define title and summary",
    },
  ])("rejects channel docs with $name", ({ content, error }) => {
    const repoRoot = makeRepoRoot("openclaw-channel-docs-frontmatter-");
    writeJson(path.join(repoRoot, "extensions", "frontmatter-test", "package.json"), {
      name: "@openclaw/frontmatter-test",
      openclaw: {
        channel: {
          id: "frontmatter-test",
          label: "Manifest label",
          docsPath: "/channels/frontmatter-test",
          blurb: "Manifest blurb",
        },
      },
    });
    writeExternalChannelDocs(repoRoot);
    if (content !== null) {
      writeChannelDocContent(repoRoot, "/channels/frontmatter-test", content);
    }

    expect(() => buildOfficialChannelDocsCatalog({ repoRoot })).toThrow(error);
  });

  it("writes the generated docs block and reports missing or hidden navigation routes", () => {
    const repoRoot = makeRepoRoot("openclaw-official-channel-docs-write-");
    writeJson(path.join(repoRoot, "extensions", "bundled", "package.json"), {
      name: "@openclaw/bundled",
      openclaw: {
        channel: {
          id: "bundled",
          label: "Bundled",
          docsPath: "/channels/bundled",
          blurb: "bundled test channel",
        },
      },
    });
    writeJson(path.join(repoRoot, "extensions", "hidden", "package.json"), {
      name: "@openclaw/hidden",
      openclaw: {
        channel: {
          id: "hidden",
          label: "Hidden",
          docsPath: "/channels/hidden",
          exposure: {
            docs: false,
          },
        },
      },
    });
    writeExternalChannelDocs(repoRoot);
    writeChannelDoc(repoRoot, "/channels/bundled", "Bundled Chat", "Public bundled summary");
    const docsIndexPath = path.join(repoRoot, OFFICIAL_CHANNEL_DOCS_INDEX_RELATIVE_PATH);
    fs.mkdirSync(path.dirname(docsIndexPath), { recursive: true });
    fs.writeFileSync(
      docsIndexPath,
      [
        "# Channels",
        "",
        "<!-- BEGIN GENERATED: official channel catalog -->",
        "- stale",
        "<!-- END GENERATED: official channel catalog -->",
        "",
        "Footer",
        "",
      ].join("\n"),
      "utf8",
    );
    writeEnglishDocsNavigation(repoRoot, ["channels/hidden"], ["web/webchat", "channels/bundled"]);

    expect(checkOfficialChannelDocsIndex({ repoRoot })).toBe(false);
    expect(renderOfficialChannelDocsIndex({ repoRoot })).toContain(
      "- [Bundled Chat](/channels/bundled) - Public bundled summary (bundled plugin).",
    );
    expect(writeOfficialChannelDocsIndex({ repoRoot })).toBe(true);
    expect(writeOfficialChannelDocsIndex({ repoRoot })).toBe(false);
    expect(checkOfficialChannelDocsIndex({ repoRoot })).toBe(true);
    const generatedIndex = fs.readFileSync(docsIndexPath, "utf8");
    expect(generatedIndex).toMatch(/^# Channels\n/u);
    expect(generatedIndex).toContain("\nFooter\n");
    expect(findMissingOfficialChannelDocsNavRoutes({ repoRoot })).toContain("channels/bundled");
    expect(findUnexpectedOfficialChannelDocsNavRoutes({ repoRoot })).toEqual(["channels/hidden"]);
    expect(findDuplicateOfficialChannelDocsNavRoutes({ repoRoot })).toEqual([]);

    writeEnglishDocsNavigation(repoRoot, ["channels/bundled", "channels/bundled"], ["web/webchat"]);
    expect(findDuplicateOfficialChannelDocsNavRoutes({ repoRoot })).toEqual(["channels/bundled"]);
  });

  it("rejects missing or duplicate generated docs markers", () => {
    const repoRoot = makeRepoRoot("openclaw-official-channel-docs-markers-");
    writeExternalChannelDocs(repoRoot);
    const docsIndexPath = path.join(repoRoot, OFFICIAL_CHANNEL_DOCS_INDEX_RELATIVE_PATH);
    fs.mkdirSync(path.dirname(docsIndexPath), { recursive: true });
    fs.writeFileSync(docsIndexPath, "# Channels\n", "utf8");

    expect(() => renderOfficialChannelDocsIndex({ repoRoot })).toThrow(
      "must contain exactly one generated channel marker pair",
    );

    fs.writeFileSync(
      docsIndexPath,
      [
        "<!-- BEGIN GENERATED: official channel catalog -->",
        "<!-- BEGIN GENERATED: official channel catalog -->",
        "<!-- END GENERATED: official channel catalog -->",
      ].join("\n"),
      "utf8",
    );
    expect(() => renderOfficialChannelDocsIndex({ repoRoot })).toThrow(
      "must contain exactly one generated channel marker pair",
    );
  });

  it("keeps third-party official external catalog npm sources pinned unless they track latest", () => {
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
