// Ordinary runtime tests receive config after load-time roster migration.
// Keep raw-roster contract tests explicitly unadapted instead of reintroducing a production fallback.
import { setAgentRosterTestConfigAdapter } from "../src/agents/agent-scope-config.js";
import { materializeTestAgentRoster } from "./agent-roster-fixture.js";

setAgentRosterTestConfigAdapter(materializeTestAgentRoster);
