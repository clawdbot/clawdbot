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
assert.equal(loader.nativeHits, 1, "the real provider must load its prepared JavaScript");
assert.equal(loader.sourceTransformForced + loader.sourceTransformFallbacks, 0);
const result = withPluginRuntimeRegistryScope(registry, classify);
assert.equal(result?.reason, "server_error");
assert.equal(result?.provider, "anthropic");
assert.equal(getActivePluginRegistry(), null);
console.log(JSON.stringify({ loadMs, loader, reason: result.reason, provider: result.provider }));
