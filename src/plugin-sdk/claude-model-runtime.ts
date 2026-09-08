// Provider policy artifacts load eagerly; keep Claude identity and thinking
// helpers on their leaf owners so policy resolution does not load transports.
export {
  resolveClaudeFable5ModelIdentity,
  resolveClaudeModelIdentity,
  resolveClaudeMythos5ModelIdentity,
  resolveClaudeOpus5ModelIdentity,
  resolveClaudeSonnet5ModelIdentity,
  supportsClaudeFastMode,
} from "@openclaw/llm-core";
export { resolveClaudeThinkingProfile } from "../plugins/provider-claude-thinking.js";
