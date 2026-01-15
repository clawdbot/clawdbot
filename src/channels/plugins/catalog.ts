import type { ChannelMeta } from "./types.js";

export type ChannelPluginCatalogEntry = {
  id: string;
  meta: ChannelMeta;
  install: {
    npmSpec: string;
    localPath?: string;
    defaultChoice?: "npm" | "local";
  };
};

const CATALOG: ChannelPluginCatalogEntry[] = [
  {
    id: "matrix",
    meta: {
      id: "matrix",
      label: "Matrix",
      selectionLabel: "Matrix (plugin)",
      docsPath: "/channels/matrix",
      docsLabel: "matrix",
      blurb: "open protocol; install the plugin to enable.",
      order: 70,
      quickstartAllowFrom: true,
    },
    install: {
      npmSpec: "@clawdbot/matrix",
      localPath: "extensions/matrix",
      defaultChoice: "npm",
    },
  },
  {
    id: "zalo",
    meta: {
      id: "zalo",
      label: "Zalo",
      selectionLabel: "Zalo (Bot API)",
      docsPath: "/channels/zalo",
      docsLabel: "zalo",
      blurb: "Vietnam-focused messaging platform with Bot API.",
      aliases: ["zl"],
      order: 80,
      quickstartAllowFrom: true,
    },
    install: {
      npmSpec: "@clawdbot/zalo",
      localPath: "extensions/zalo",
    },
  },
];

export function listChannelPluginCatalogEntries(): ChannelPluginCatalogEntry[] {
  return [...CATALOG];
}

export function getChannelPluginCatalogEntry(id: string): ChannelPluginCatalogEntry | undefined {
  const trimmed = id.trim();
  if (!trimmed) return undefined;
  return CATALOG.find((entry) => entry.id === trimmed);
}
