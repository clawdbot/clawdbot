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
    id: "msteams",
    meta: {
      id: "msteams",
      label: "Microsoft Teams",
      selectionLabel: "Microsoft Teams (Bot Framework)",
      docsPath: "/channels/msteams",
      docsLabel: "msteams",
      blurb: "Bot Framework; enterprise support.",
      aliases: ["teams"],
      order: 60,
    },
    install: {
      npmSpec: "@clawdbot/msteams",
      localPath: "extensions/msteams",
      defaultChoice: "npm",
    },
  },
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
    id: "bluebubbles",
    meta: {
      id: "bluebubbles",
      label: "BlueBubbles",
      selectionLabel: "BlueBubbles (macOS app)",
      docsPath: "/channels/bluebubbles",
      docsLabel: "bluebubbles",
      blurb: "iMessage via the BlueBubbles mac app + REST API.",
      order: 75,
    },
    install: {
      npmSpec: "@clawdbot/bluebubbles",
      localPath: "extensions/bluebubbles",
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
