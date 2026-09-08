const COMMUNICATION_SECTION_KEYS = ["messages", "tts", "transcripts"] as const;

// Curated Talk home: catalog-driven provider/model/voice pickers render above
// the talk schema section (talk.ts / talk-page.ts).
const TALK_SECTION_KEYS = ["talk"] as const;

const APPEARANCE_SECTION_KEYS = ["__appearance__", "ui"] as const;

const NOTIFICATION_SECTION_KEYS = ["__notifications__"] as const;

// Curated Privacy & Security home: the schema-backed security/approvals policy
// sections render here, below the curated status rows (security.ts).
const SECURITY_SECTION_KEYS = ["security", "approvals"] as const;

const AUTOMATION_SECTION_KEYS = ["commands", "hooks", "bindings", "cron", "plugins"] as const;

const INFRASTRUCTURE_SECTION_KEYS = ["gateway", "browser", "nodeHost", "discovery", "acp"] as const;

const UPDATE_SECTION_KEYS = ["update"] as const;

const MCP_SECTION_KEYS = ["mcp"] as const;

// Curated Memory home: engine/backend/add-on rows plus the Dreaming tab render
// above the memory schema section (memory.ts). Memory stays separate from Agent
// Defaults because the engine choice and dreaming's global cron are not defaults.
const MEMORY_SECTION_KEYS = ["memory"] as const;

const AI_AGENTS_SECTION_KEYS = ["agents", "skills", "tools", "session"] as const;

// Advanced renders without an include list: it shows every section that has no
// curated home (config-page computes its exclude list).
// Each curated page opens at its first section.
const CONFIG_SECTION_KEYS_BY_PAGE = {
  communications: COMMUNICATION_SECTION_KEYS,
  appearance: APPEARANCE_SECTION_KEYS,
  notifications: NOTIFICATION_SECTION_KEYS,
  security: SECURITY_SECTION_KEYS,
  automation: AUTOMATION_SECTION_KEYS,
  mcp: MCP_SECTION_KEYS,
  memory: MEMORY_SECTION_KEYS,
  talk: TALK_SECTION_KEYS,
  infrastructure: INFRASTRUCTURE_SECTION_KEYS,
  updates: UPDATE_SECTION_KEYS,
  "ai-agents": AI_AGENTS_SECTION_KEYS,
  advanced: undefined,
} as const satisfies Record<string, readonly string[] | undefined>;

export type ConfigPageId = keyof typeof CONFIG_SECTION_KEYS_BY_PAGE;

// Search and page rendering must agree on section ownership, or a result can
// open a page whose editor rejects the section it promised to reveal.
const CONFIG_PAGE_BY_SECTION = new Map<string, ConfigPageId>(
  Object.entries(CONFIG_SECTION_KEYS_BY_PAGE).flatMap(([pageId, sectionKeys]) =>
    (sectionKeys ?? []).map((sectionKey) => [sectionKey, pageId as ConfigPageId] as const),
  ),
);

export const SCOPED_CONFIG_SECTION_KEYS = new Set(CONFIG_PAGE_BY_SECTION.keys());

export function configSectionKeysForPage(pageId: ConfigPageId): readonly string[] | undefined {
  return CONFIG_SECTION_KEYS_BY_PAGE[pageId];
}

export function configPageForSection(sectionKey: string): ConfigPageId {
  // Sections without a curated home render on the Advanced page.
  return CONFIG_PAGE_BY_SECTION.get(sectionKey) ?? "advanced";
}
