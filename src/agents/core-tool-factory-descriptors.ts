/**
 * Static identity for names that select core agent factory families before assembly.
 */

export type CoreToolFactoryFamily = "base-coding" | "shell" | "openclaw";

type CoreToolFactoryDescriptor = {
  name: string;
  family: CoreToolFactoryFamily;
};

export const CORE_TOOL_FACTORY_DESCRIPTORS = [
  { name: "edit", family: "base-coding" },
  { name: "read", family: "base-coding" },
  { name: "write", family: "base-coding" },
  { name: "apply_patch", family: "shell" },
  { name: "exec", family: "shell" },
  { name: "process", family: "shell" },
  { name: "agents_list", family: "openclaw" },
  { name: "crestodian", family: "openclaw" },
  { name: "computer", family: "openclaw" },
  { name: "continue_delegate", family: "openclaw" },
  { name: "continue_work", family: "openclaw" },
  { name: "cron", family: "openclaw" },
  { name: "gateway", family: "openclaw" },
  { name: "get_goal", family: "openclaw" },
  { name: "heartbeat_respond", family: "openclaw" },
  { name: "heartbeat_response", family: "openclaw" },
  { name: "image", family: "openclaw" },
  { name: "image_generate", family: "openclaw" },
  { name: "message", family: "openclaw" },
  { name: "music_generate", family: "openclaw" },
  { name: "nodes", family: "openclaw" },
  { name: "pdf", family: "openclaw" },
  { name: "session_status", family: "openclaw" },
  { name: "sessions_history", family: "openclaw" },
  { name: "sessions_list", family: "openclaw" },
  { name: "sessions_search", family: "openclaw" },
  { name: "sessions_send", family: "openclaw" },
  { name: "sessions_spawn", family: "openclaw" },
  { name: "sessions_yield", family: "openclaw" },
  { name: "skill_workshop", family: "openclaw" },
  { name: "spawn_task", family: "openclaw" },
  { name: "create_goal", family: "openclaw" },
  { name: "subagents", family: "openclaw" },
  { name: "request_compaction", family: "openclaw" },
  { name: "transcripts", family: "openclaw" },
  { name: "tts", family: "openclaw" },
  { name: "update_goal", family: "openclaw" },
  { name: "update_plan", family: "openclaw" },
  { name: "dismiss_task", family: "openclaw" },
  { name: "video_generate", family: "openclaw" },
  { name: "web_fetch", family: "openclaw" },
  { name: "web_search", family: "openclaw" },
] as const satisfies readonly CoreToolFactoryDescriptor[];

const CORE_TOOL_FACTORY_FAMILY_BY_NAME = new Map<string, CoreToolFactoryFamily>(
  CORE_TOOL_FACTORY_DESCRIPTORS.map(({ name, family }) => [name, family]),
);

export type OpenClawCodingToolConstructionPlan = {
  includeBaseCodingTools: boolean;
  includeShellTools: boolean;
  includeChannelTools: boolean;
  includeOpenClawTools: boolean;
  includePluginTools: boolean;
};

export function resolveCoreToolFactoryFamily(name: string): CoreToolFactoryFamily | undefined {
  return CORE_TOOL_FACTORY_FAMILY_BY_NAME.get(name);
}
