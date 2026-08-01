// Voice Call plugin module implements core bridge behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginApi } from "../api.js";

// Narrow core runtime/config contracts consumed by the voice-call plugin.

/** Core config subset read by voice-call helpers. */
export type CoreConfig = OpenClawConfig;

/** Agent runtime API subset exposed through the plugin SDK. */
export type CoreAgentDeps = OpenClawPluginApi["runtime"]["agent"];
