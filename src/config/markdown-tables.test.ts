// Covers markdown table config normalization and channel overrides.
import { describe, expect, it, vi } from "vitest";

const listChannelPluginsMock = vi.hoisted(() =>
  vi.fn(() => [
    { id: "mattermost", messaging: { defaultMarkdownTableMode: "off" as const } },
    { id: "signal", messaging: { defaultMarkdownTableMode: "block" as const } },
    { id: "whatsapp", messaging: { defaultMarkdownTableMode: "bullets" as const } },
  ]),
);
const getActivePluginChannelRegistryVersionMock = vi.hoisted(() => vi.fn(() => 1));

vi.mock("../channels/plugins/registry.js", async () => {
  const actual = await vi.importActual<typeof import("../channels/plugins/registry.js")>(
    "../channels/plugins/registry.js",
  );
  return {
    ...actual,
    listChannelPlugins: () => listChannelPluginsMock(),
    normalizeChannelId: (raw?: string | null) => raw ?? null,
  };
});

vi.mock("../plugins/runtime.js", async () => {
  const actual =
    await vi.importActual<typeof import("../plugins/runtime.js")>("../plugins/runtime.js");
  return {
    ...actual,
    getActivePluginChannelRegistryVersion: () => getActivePluginChannelRegistryVersionMock(),
  };
});

import { resolveMarkdownTableMode } from "./markdown-tables.js";

describe("resolveMarkdownTableMode default modes", () => {
  it("mattermost mode is off", () => {
    expect(resolveMarkdownTableMode({ channel: "mattermost" })).toBe("off");
  });

  it("signal mode is block", () => {
    expect(resolveMarkdownTableMode({ channel: "signal", supportsBlockTables: true })).toBe(
      "block",
    );
  });

  it("whatsapp mode is bullets", () => {
    expect(resolveMarkdownTableMode({ channel: "whatsapp" })).toBe("bullets");
  });

  it("slack has no special default in this seam-only slice", () => {
    expect(resolveMarkdownTableMode({ channel: "slack" })).toBe("code");
  });
});

describe("resolveMarkdownTableMode", () => {
  it("defaults to code for slack", () => {
    expect(resolveMarkdownTableMode({ channel: "slack" })).toBe("code");
  });

  it("coerces explicit block mode to code for slack", () => {
    const cfg = { channels: { slack: { markdown: { tables: "block" as const } } } };
    expect(resolveMarkdownTableMode({ cfg, channel: "slack" })).toBe("code");
  });

  it("keeps block mode behind renderer capability", () => {
    expect(resolveMarkdownTableMode({ channel: "signal" })).toBe("code");
    expect(resolveMarkdownTableMode({ channel: "signal", supportsBlockTables: true })).toBe(
      "block",
    );
    const cfg = { channels: { signal: { markdown: { tables: "code" as const } } } };
    expect(resolveMarkdownTableMode({ cfg, channel: "signal", supportsBlockTables: true })).toBe(
      "code",
    );
  });

  it("allows explicit block mode only for block-aware renderers", () => {
    const cfg = { channels: { telegram: { markdown: { tables: "block" as const } } } };
    expect(resolveMarkdownTableMode({ cfg, channel: "telegram" })).toBe("code");
    expect(resolveMarkdownTableMode({ cfg, channel: "telegram", supportsBlockTables: true })).toBe(
      "block",
    );
  });
});
