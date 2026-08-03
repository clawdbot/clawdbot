import { describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import type { ProviderFailoverErrorContext } from "../../plugins/types.js";
import { createCliOutputFailoverError } from "./output-error.js";

describe("createCliOutputFailoverError", () => {
  it("classifies CLI prose through a provider hook alias", () => {
    const errorMessage = "You've hit your session limit \u00b7 resets 1:50pm";
    const classifyFailoverReason = vi.fn(
      ({ provider, errorMessage: message }: ProviderFailoverErrorContext) =>
        provider === "claude-cli" && message === errorMessage ? "rate_limit" : undefined,
    );
    const unrelatedHook = vi.fn(() => "billing" as const);
    const registry = createEmptyPluginRegistry();
    registry.providers.push(
      {
        pluginId: "other",
        provider: {
          id: "other",
          label: "Other",
          auth: [],
          classifyFailoverReason: unrelatedHook,
        },
        source: "test",
      },
      {
        pluginId: "anthropic",
        provider: {
          id: "anthropic",
          label: "Anthropic",
          hookAliases: ["claude-cli"],
          auth: [],
          classifyFailoverReason,
        },
        source: "test",
      },
    );

    const error = withPluginRuntimeRegistryScope(registry, () =>
      createCliOutputFailoverError({
        output: { text: "", errorText: errorMessage },
        provider: "claude-cli",
        model: "claude-sonnet-4-6",
      }),
    );

    expect(error).toMatchObject({
      reason: "rate_limit",
      status: 429,
      provider: "claude-cli",
      model: "claude-sonnet-4-6",
      rawError: errorMessage,
    });
    expect(classifyFailoverReason).toHaveBeenCalledWith({
      provider: "claude-cli",
      errorMessage,
    });
    expect(classifyFailoverReason).toHaveBeenCalledTimes(1);
    expect(unrelatedHook).not.toHaveBeenCalled();
  });
});
