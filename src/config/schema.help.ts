// Defines user-facing config field help text for docs and UI surfaces.
import { AGENT_FIELD_HELP } from "./schema.help.agents.js";
import { AUTOMATION_FIELD_HELP } from "./schema.help.automation.js";
import { CORE_FIELD_HELP } from "./schema.help.core.js";
import { MODEL_FIELD_HELP } from "./schema.help.models.js";
import { RUNTIME_FIELD_HELP } from "./schema.help.runtime.js";

export const FIELD_HELP: Record<string, string> = {
  ...CORE_FIELD_HELP,
  ...RUNTIME_FIELD_HELP,
  ...MODEL_FIELD_HELP,
  ...AGENT_FIELD_HELP,
  ...AUTOMATION_FIELD_HELP,
};
