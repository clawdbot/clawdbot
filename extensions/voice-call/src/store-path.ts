// Voice Call plugin module resolves its default persistence root.
import path from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";

/** Resolve the plugin-owned store below OpenClaw's canonical state directory. */
export function resolveDefaultVoiceCallStoreDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "voice-calls");
}
