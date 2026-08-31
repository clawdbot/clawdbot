// Runtime facade for chat command discovery without importing the full discovery module.
export {
  expandExplicitSkillReferences,
  hasSkillReferenceCandidate,
  listSkillCommandsForAgents,
  listSkillCommandsForWorkspace,
} from "./chat-commands.js";
export { resolveEffectiveAgentSkillFilter } from "./agent-filter.js";
