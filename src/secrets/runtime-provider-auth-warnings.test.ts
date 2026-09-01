/** Tests provider-auth warning projection during scoped credential refreshes. */
import { describe, expect, it } from "vitest";
import { mergeProviderAuthRuntimeWarnings } from "./runtime-provider-auth-warnings.js";
import type { SecretResolverWarning } from "./runtime-shared.js";

describe("provider-auth runtime warning projection", () => {
  it("replaces provider-auth warnings while retaining unrelated active warnings", () => {
    const warning = (
      path: string,
      message = "redacted fixture warning",
    ): SecretResolverWarning => ({
      code: "SECRETS_OWNER_UNAVAILABLE",
      path,
      message,
    });

    expect(
      mergeProviderAuthRuntimeWarnings(
        [
          warning("models.providers.openai.apiKey", "old provider warning"),
          warning("channels.discord.accounts.ops.token", "active transport warning"),
          warning("plugins.entries.brave.config.webSearch.apiKey", "active web warning"),
        ],
        [
          warning("models.providers.openai.apiKey", "current provider warning"),
          warning("/tmp/agent.auth-profiles.openai:default.key", "current auth warning"),
          warning("channels.discord.accounts.ops.token", "discarded candidate warning"),
        ],
      ),
    ).toEqual([
      warning("channels.discord.accounts.ops.token", "active transport warning"),
      warning("plugins.entries.brave.config.webSearch.apiKey", "active web warning"),
      warning("models.providers.openai.apiKey", "current provider warning"),
      warning("/tmp/agent.auth-profiles.openai:default.key", "current auth warning"),
    ]);
  });
});
