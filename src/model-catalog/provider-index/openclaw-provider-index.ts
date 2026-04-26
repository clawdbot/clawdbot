import type { OpenClawProviderIndex } from "./types.js";

// OpenClaw-owned preview metadata for providers whose plugins may not be
// installed yet. Installed plugin manifests remain authoritative; this index is
// a fallback for installable-provider and pre-install model picker surfaces.
// Preview catalogs use the shared model catalog type, but intentionally keep to
// stable display fields unless runtime adapter metadata is kept in sync with
// the installed plugin manifest.
// When a bundled provider moves to an external package, keep its provider id
// here and add plugin package metadata so pre-install surfaces do not disappear
// before the user installs the new package.
export const OPENCLAW_PROVIDER_INDEX = {
  version: 1,
  providers: {
    moonshot: {
      id: "moonshot",
      name: "Moonshot AI",
      plugin: {
        id: "moonshot",
      },
      docs: "/providers/moonshot",
      categories: ["cloud", "llm"],
      previewCatalog: {
        models: [
          {
            id: "kimi-k2.6",
            name: "Kimi K2.6",
            input: ["text", "image"],
            contextWindow: 262144,
          },
        ],
      },
    },
    deepseek: {
      id: "deepseek",
      name: "DeepSeek",
      plugin: {
        id: "deepseek",
      },
      docs: "/providers/deepseek",
      categories: ["cloud", "llm"],
      previewCatalog: {
        models: [
          {
            id: "deepseek-chat",
            name: "DeepSeek Chat",
            input: ["text"],
            contextWindow: 131072,
          },
          {
            id: "deepseek-reasoner",
            name: "DeepSeek Reasoner",
            input: ["text"],
            reasoning: true,
            contextWindow: 131072,
          },
        ],
      },
    },
  },
} satisfies OpenClawProviderIndex;
