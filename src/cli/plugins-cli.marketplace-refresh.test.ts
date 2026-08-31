// Covers the hosted OpenClaw marketplace feed refresh command.
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushDiagnosticsTimeline } from "../infra/diagnostics-timeline.js";
import { createHostedMarketplaceFeedFixture } from "./plugins-marketplace-feed.test-support.js";

const mocks = vi.hoisted(() => {
  const defaultRuntime = {
    error: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`exit ${code}`);
    }),
    log: vi.fn(),
    writeJson: vi.fn(),
  };
  return {
    clearManagedPluginOfficialCatalogCache: vi.fn(),
    defaultRuntime,
    getRuntimeConfig: vi.fn(),
    loadConfiguredHostedOfficialExternalPluginCatalogEntries: vi.fn(),
    notifyGatewayPluginMetadataChanged: vi.fn(),
  };
});

vi.mock("../config/config.js", () => ({
  assertConfigWriteAllowedInCurrentMode: vi.fn(),
  getRuntimeConfig: mocks.getRuntimeConfig,
  readConfigFileSnapshot: vi.fn(),
  replaceConfigFile: vi.fn(),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.defaultRuntime,
}));

vi.mock("../plugins/official-external-plugin-catalog.js", () => ({
  loadConfiguredHostedOfficialExternalPluginCatalogEntries:
    mocks.loadConfiguredHostedOfficialExternalPluginCatalogEntries,
}));

vi.mock("../plugins/management-service.js", () => ({
  clearManagedPluginOfficialCatalogCache: mocks.clearManagedPluginOfficialCatalogCache,
}));

vi.mock("./plugins-update-gateway-signal.js", () => ({
  notifyGatewayPluginMetadataChanged: mocks.notifyGatewayPluginMetadataChanged,
}));

async function createTimelinePath(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "openclaw-marketplace-refresh-"));
  return path.join(dir, "timeline.jsonl");
}

async function readTimeline(pathname: string): Promise<Record<string, unknown>[]> {
  flushDiagnosticsTimeline();
  const content = await readFile(pathname, "utf8");
  return content
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("plugins marketplace refresh", () => {
  beforeEach(() => {
    mocks.defaultRuntime.error.mockClear();
    mocks.defaultRuntime.exit.mockClear();
    mocks.defaultRuntime.log.mockClear();
    mocks.defaultRuntime.writeJson.mockClear();
    mocks.getRuntimeConfig.mockReset();
    mocks.loadConfiguredHostedOfficialExternalPluginCatalogEntries.mockReset();
    mocks.clearManagedPluginOfficialCatalogCache.mockReset();
    mocks.notifyGatewayPluginMetadataChanged.mockReset().mockResolvedValue(true);
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    flushDiagnosticsTimeline();
    vi.unstubAllEnvs();
  });

  it("refreshes an explicitly selected marketplace feed and prints JSON", async () => {
    const config = {};
    mocks.getRuntimeConfig.mockReturnValue(config);
    mocks.loadConfiguredHostedOfficialExternalPluginCatalogEntries.mockResolvedValue(
      createHostedMarketplaceFeedFixture({
        entries: [{ name: "@acme/calendar" }, { name: "@acme/docs" }],
        etag: '"abc"',
      }),
    );

    const { runPluginMarketplaceRefreshCommand } = await import("./plugins-cli.runtime.js");
    await runPluginMarketplaceRefreshCommand({
      feedProfile: "acme",
      expectedSha256: "feed-sha",
      json: true,
    });

    expect(mocks.loadConfiguredHostedOfficialExternalPluginCatalogEntries).toHaveBeenCalledWith({
      feedProfile: "acme",
      expectedSha256: "feed-sha",
      requireSnapshotWrite: true,
    });
    expect(mocks.notifyGatewayPluginMetadataChanged).toHaveBeenCalledWith(config);
    expect(mocks.defaultRuntime.writeJson).toHaveBeenCalledWith({
      source: "hosted",
      entries: 2,
      feed: {
        id: "acme-marketplace",
        generatedAt: "2026-06-23T00:00:00.000Z",
        sequence: 7,
      },
      metadata: {
        url: "https://packages.acme.example/openclaw/feed",
        status: 200,
        checksum: "feed-sha",
        etag: '"abc"',
      },
      trust: {
        mode: "signed",
        signedBy: "acme-root-2026",
        signatureCount: 1,
        threshold: 1,
        verifiedAt: "2026-06-23T00:01:02.000Z",
      },
    });
  });

  it("prints bounded signed feed trust state in text output", async () => {
    mocks.getRuntimeConfig.mockReturnValue({});
    mocks.loadConfiguredHostedOfficialExternalPluginCatalogEntries.mockResolvedValue(
      createHostedMarketplaceFeedFixture({ entries: [{ name: "@acme/calendar" }] }),
    );

    const { runPluginMarketplaceRefreshCommand } = await import("./plugins-cli.runtime.js");
    await runPluginMarketplaceRefreshCommand({});

    const output = mocks.defaultRuntime.log.mock.calls.map(([value]) => String(value)).join("\n");
    expect(output).toContain("Trust:");
    expect(output).toContain("signed by acme-root-2026 (1/1)");
    expect(output).toContain("2026-06-23T00:01:02.000Z");
    expect(output).not.toContain("publicKey");
    expect(output).not.toContain("signature:");
  });

  it("normalizes bare SHA-256 pins before refreshing", async () => {
    const config = {};
    mocks.getRuntimeConfig.mockReturnValue(config);
    mocks.loadConfiguredHostedOfficialExternalPluginCatalogEntries.mockResolvedValue(
      createHostedMarketplaceFeedFixture({
        entries: [{ name: "@acme/calendar" }],
        checksum: "sha256:abcdef",
        includeTrust: false,
      }),
    );

    const { runPluginMarketplaceRefreshCommand } = await import("./plugins-cli.runtime.js");
    await runPluginMarketplaceRefreshCommand({
      feedProfile: "acme",
      expectedSha256: "ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789",
      json: true,
    });

    expect(mocks.loadConfiguredHostedOfficialExternalPluginCatalogEntries).toHaveBeenCalledWith({
      feedProfile: "acme",
      expectedSha256: "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      requireSnapshotWrite: true,
    });

    mocks.loadConfiguredHostedOfficialExternalPluginCatalogEntries.mockClear();

    await runPluginMarketplaceRefreshCommand({
      feedProfile: "acme",
      expectedSha256: "sha256:ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789",
      json: true,
    });

    expect(mocks.loadConfiguredHostedOfficialExternalPluginCatalogEntries).toHaveBeenCalledWith({
      feedProfile: "acme",
      expectedSha256: "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      requireSnapshotWrite: true,
    });
  });

  it("reports bundled fallback without failing the command", async () => {
    mocks.getRuntimeConfig.mockReturnValue({});
    mocks.loadConfiguredHostedOfficialExternalPluginCatalogEntries.mockResolvedValue({
      source: "bundled-fallback",
      entries: [{ name: "@openclaw/acpx" }],
      error: "hosted catalog feed returned HTTP 503",
      metadata: {
        url: "https://clawhub.ai/v1/feeds/plugins",
        status: 503,
      },
    });

    const { runPluginMarketplaceRefreshCommand } = await import("./plugins-cli.runtime.js");
    await runPluginMarketplaceRefreshCommand({});

    const output = mocks.defaultRuntime.log.mock.calls.map(([value]) => String(value)).join("\n");
    expect(output).toContain("bundled fallback");
    expect(output).toContain("hosted catalog feed returned HTTP 503");
    expect(mocks.notifyGatewayPluginMetadataChanged).not.toHaveBeenCalled();
    expect(mocks.defaultRuntime.exit).not.toHaveBeenCalled();
  });

  it("keeps pinned snapshot JSON clean when the Gateway cannot refresh", async () => {
    const config = {};
    mocks.getRuntimeConfig.mockReturnValue(config);
    mocks.loadConfiguredHostedOfficialExternalPluginCatalogEntries.mockResolvedValue(
      createHostedMarketplaceFeedFixture({ source: "hosted-snapshot" }),
    );
    mocks.notifyGatewayPluginMetadataChanged.mockResolvedValue(false);

    const { runPluginMarketplaceRefreshCommand } = await import("./plugins-cli.runtime.js");
    await expect(
      runPluginMarketplaceRefreshCommand({ expectedSha256: "sha256:expected", json: true }),
    ).rejects.toThrow("exit 1");

    expect(mocks.notifyGatewayPluginMetadataChanged).toHaveBeenCalledWith(config);
    expect(mocks.defaultRuntime.writeJson).toHaveBeenCalledOnce();
    expect(mocks.defaultRuntime.log).not.toHaveBeenCalled();
    expect(mocks.defaultRuntime.error.mock.calls.map(([message]) => message)).toEqual([
      expect.stringContaining('Run "openclaw gateway restart" to apply the current catalog state.'),
      "Pinned marketplace feed refresh did not accept a fresh hosted payload (source: hosted-snapshot).",
    ]);
    expect(mocks.defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("keeps a hosted refresh successful and prints restart guidance when the Gateway is offline", async () => {
    mocks.getRuntimeConfig.mockReturnValue({});
    mocks.loadConfiguredHostedOfficialExternalPluginCatalogEntries.mockResolvedValue(
      createHostedMarketplaceFeedFixture(),
    );
    mocks.notifyGatewayPluginMetadataChanged.mockResolvedValue(false);

    const { runPluginMarketplaceRefreshCommand } = await import("./plugins-cli.runtime.js");
    await runPluginMarketplaceRefreshCommand({});

    expect(mocks.defaultRuntime.log).toHaveBeenCalledWith(
      expect.stringContaining('Run "openclaw gateway restart" to apply the current catalog state.'),
    );
    expect(mocks.defaultRuntime.error).not.toHaveBeenCalled();
    expect(mocks.defaultRuntime.exit).not.toHaveBeenCalled();
  });

  it("keeps JSON stdout clean when an offline Gateway needs a restart", async () => {
    mocks.getRuntimeConfig.mockReturnValue({});
    mocks.loadConfiguredHostedOfficialExternalPluginCatalogEntries.mockResolvedValue(
      createHostedMarketplaceFeedFixture(),
    );
    mocks.notifyGatewayPluginMetadataChanged.mockResolvedValue(false);

    const { runPluginMarketplaceRefreshCommand } = await import("./plugins-cli.runtime.js");
    await runPluginMarketplaceRefreshCommand({ json: true });

    expect(mocks.defaultRuntime.writeJson).toHaveBeenCalledOnce();
    expect(mocks.defaultRuntime.log).not.toHaveBeenCalled();
    expect(mocks.defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining('Run "openclaw gateway restart" to apply the current catalog state.'),
    );
    expect(mocks.defaultRuntime.exit).not.toHaveBeenCalled();
  });

  it("redacts query-bearing feed URLs from refresh output", async () => {
    mocks.getRuntimeConfig.mockReturnValue({});
    mocks.loadConfiguredHostedOfficialExternalPluginCatalogEntries.mockResolvedValue({
      source: "bundled-fallback",
      entries: [{ name: "@openclaw/acpx" }],
      error:
        "hosted catalog feed fetch failed for https://clawhub.ai/v1/feeds/plugins?token=secret#frag",
      metadata: {
        url: "https://clawhub.ai/v1/feeds/plugins?token=secret#frag",
        status: 503,
      },
    });

    const { runPluginMarketplaceRefreshCommand } = await import("./plugins-cli.runtime.js");
    await runPluginMarketplaceRefreshCommand({
      feedUrl: "https://clawhub.ai/v1/feeds/plugins?token=secret#frag",
      json: true,
    });

    expect(mocks.defaultRuntime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ url: "https://clawhub.ai/v1/feeds/plugins" }),
        error: "hosted catalog feed fetch failed for https://clawhub.ai/v1/feeds/plugins",
      }),
    );

    mocks.defaultRuntime.writeJson.mockClear();
    mocks.defaultRuntime.log.mockClear();

    await runPluginMarketplaceRefreshCommand({
      feedUrl: "https://clawhub.ai/v1/feeds/plugins?token=secret#frag",
    });

    const output = mocks.defaultRuntime.log.mock.calls.map(([value]) => String(value)).join("\n");
    expect(output).toContain("https://clawhub.ai/v1/feeds/plugins");
    expect(output).not.toContain("token=secret");
    expect(output).not.toContain("#frag");
  });

  it("fails checksum-pinned refreshes that fall back", async () => {
    mocks.getRuntimeConfig.mockReturnValue({});
    mocks.loadConfiguredHostedOfficialExternalPluginCatalogEntries.mockResolvedValue({
      source: "bundled-fallback",
      entries: [{ name: "@openclaw/acpx" }],
      error: "hosted catalog feed checksum mismatch: expected sha256:expected",
      metadata: {
        url: "https://clawhub.ai/v1/feeds/plugins",
        status: 200,
        checksum: "sha256:actual",
      },
    });

    const { runPluginMarketplaceRefreshCommand } = await import("./plugins-cli.runtime.js");
    await expect(
      runPluginMarketplaceRefreshCommand({ expectedSha256: "sha256:expected", json: true }),
    ).rejects.toThrow("exit 1");

    expect(mocks.defaultRuntime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({ source: "bundled-fallback" }),
    );
    expect(mocks.defaultRuntime.error).toHaveBeenCalledWith(
      "Pinned marketplace feed refresh did not accept a fresh hosted payload (source: bundled-fallback).",
    );
    expect(mocks.defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("emits bounded diagnostics for refresh without raw feed URLs", async () => {
    const timelinePath = await createTimelinePath();
    vi.stubEnv("OPENCLAW_DIAGNOSTICS_TIMELINE_PATH", timelinePath);
    const config = {
      diagnostics: { flags: ["timeline"] },
    };
    mocks.getRuntimeConfig.mockReturnValue(config);
    mocks.loadConfiguredHostedOfficialExternalPluginCatalogEntries.mockResolvedValue(
      createHostedMarketplaceFeedFixture({
        entries: [{ name: "@acme/calendar" }, { name: "@acme/docs" }],
        url: "https://user:secret@packages.acme.example/openclaw/feed?token=leak#frag",
        etag: '"abc"',
      }),
    );

    const { runPluginMarketplaceRefreshCommand } = await import("./plugins-cli.runtime.js");
    await runPluginMarketplaceRefreshCommand({
      expectedSha256: "feed-sha",
      feedProfile: "acme",
      feedUrl: "https://override.example/openclaw/feed?token=override-leak",
    });

    const [event] = await readTimeline(timelinePath);
    expect(mocks.loadConfiguredHostedOfficialExternalPluginCatalogEntries).toHaveBeenCalledWith(
      expect.objectContaining({
        feedUrl: "https://override.example/openclaw/feed?token=override-leak",
      }),
    );
    expect(event?.name).toBe("plugins.marketplace.feed.refresh");
    expect(event?.phase).toBe("plugin-marketplace");
    expect(event?.attributes).toMatchObject({
      command: "refresh",
      entries: 2,
      expectedSha256Provided: true,
      feedIdPresent: true,
      feedProfileProvided: true,
      feedSequence: 7,
      feedTrustMode: "signed",
      feedTrustSignatureCount: 1,
      feedTrustThreshold: 1,
      feedTrustVerified: true,
      feedUrlOverride: true,
      hasEtag: true,
      payloadChecksumPresent: true,
      source: "hosted",
    });
    expect(JSON.stringify(event)).not.toContain("packages.acme.example");
    expect(JSON.stringify(event)).not.toContain("acme-marketplace");
    expect(JSON.stringify(event)).not.toContain("feed-sha");
    expect(JSON.stringify(event)).not.toContain("acme-root-2026");
    expect(JSON.stringify(event)).not.toContain("secret");
    expect(JSON.stringify(event)).not.toContain("token=leak");
    expect(JSON.stringify(event)).not.toContain("override-leak");
  });
});
