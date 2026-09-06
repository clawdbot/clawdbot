/**
 * Claude CLI provider discovery descriptor. It exposes subscription-backed
 * synthetic auth for catalog/runtime discovery without full Anthropic registration.
 */
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { probeClaudeCliAuthStatus } from "./cli-auth-seam.js";
import { CLAUDE_CLI_BACKEND_ID, CLAUDE_CLI_NATIVE_AUTH_MARKER } from "./cli-constants.js";

type NativeAvailability = ReturnType<typeof probeClaudeCliAuthStatus>;
const availability = new WeakMap<object, WeakMap<object, WeakMap<object, NativeAvailability>>>();

const anthropicProviderDiscovery: ProviderPlugin = {
  id: CLAUDE_CLI_BACKEND_ID,
  label: "Claude CLI",
  docsPath: "/providers/models",
  auth: [],
  async prepareSyntheticAuth({ config, provider, env = process.env, signal }) {
    signal?.throwIfAborted();
    if (!config || normalizeLowercaseStringOrEmpty(provider) !== CLAUDE_CLI_BACKEND_ID) {
      return undefined;
    }
    const environments =
      availability.get(config) ?? new WeakMap<object, WeakMap<object, NativeAvailability>>();
    availability.set(config, environments);
    const captures = environments.get(env) ?? new WeakMap<object, NativeAvailability>();
    environments.set(env, captures);
    // Native login is independent of workspace; fresh captures and cancellation own their probes.
    const owner = signal ?? config;
    const pending = captures.get(owner) ?? probeClaudeCliAuthStatus({ env, signal });
    captures.set(owner, pending);
    const result = await pending;
    signal?.throwIfAborted();
    return result.status === "available"
      ? { apiKey: CLAUDE_CLI_NATIVE_AUTH_MARKER, source: "Claude CLI native auth", mode: "oauth" }
      : undefined;
  },
};

export default anthropicProviderDiscovery;
