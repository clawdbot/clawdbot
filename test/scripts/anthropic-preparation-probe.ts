import assert from "node:assert/strict";
import { coerceToFailoverError } from "../../src/agents/failover-error.js";
import { loadPluginRegistryHandle } from "../../src/plugins/loader.js";
import { getPluginModuleLoaderStats } from "../../src/plugins/plugin-module-loader-cache.js";
import { getActivePluginRegistry } from "../../src/plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../../src/plugins/runtime/gateway-request-scope.js";

assert.equal(getActivePluginRegistry(), null);
const classify = () =>
  coerceToFailoverError(
    { code: "API_ERROR", message: "provider failure" },
    { provider: "anthropic" },
  );
assert.equal(classify(), null, "error handling must not discover a provider");
const started = performance.now();
const registry = loadPluginRegistryHandle({
  config: { plugins: { entries: { anthropic: { enabled: true } } } },
  onlyPluginIds: ["anthropic"],
});
const loadMs = performance.now() - started;
assert.ok(
  registry.providers.some((entry) => entry.provider.id === "anthropic"),
  JSON.stringify({ plugins: registry.plugins, diagnostics: registry.diagnostics }),
);
const loader = getPluginModuleLoaderStats();
// The loader deliberately selects Jiti on Bun and native require on Node.
const isBun = Boolean(process.versions.bun);
assert.deepEqual(
  {
    calls: loader.calls,
    nativeHits: loader.nativeHits,
    nativeMisses: loader.nativeMisses,
    sourceTransformForced: loader.sourceTransformForced,
    sourceTransformFallbacks: loader.sourceTransformFallbacks,
  },
  {
    calls: 1,
    nativeHits: isBun ? 0 : 1,
    nativeMisses: 0,
    sourceTransformForced: isBun ? 1 : 0,
    sourceTransformFallbacks: 0,
  },
  "prepared provider loading must follow the runtime policy",
);
const result = withPluginRuntimeRegistryScope(registry, classify);
assert.equal(result?.reason, "server_error");
assert.equal(result?.provider, "anthropic");
assert.equal(getActivePluginRegistry(), null);
console.log(JSON.stringify({ loadMs, loader, reason: result.reason, provider: result.provider }));
