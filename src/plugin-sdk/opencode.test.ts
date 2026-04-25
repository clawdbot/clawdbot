import { describe, expect, it } from "vitest";
import { createOpencodeCatalogApiKeyAuthMethod } from "./opencode.js";

describe("createOpencodeCatalogApiKeyAuthMethod", () => {
  it("locks the shared OpenCode auth contract", () => {
    const method = createOpencodeCatalogApiKeyAuthMethod({
      providerId: "opencode-go",
      label: "OpenCode Go catalog",
      optionKey: "opencodeGoApiKey",
      flagName: "--opencode-go-api-key",
      defaultModel: "opencode-go/kimi-k2.6",
      applyConfig: (cfg) => cfg,
      noteMessage: "OpenCode uses one API key across the Zen and Go catalogs.",
      choiceId: "opencode-go",
      choiceLabel: "OpenCode Go catalog",
    });

    expect(method).toMatchObject({
      id: "api-key",
      label: "OpenCode Go catalog",
      hint: "Shared API key for Zen + Go catalogs",
      kind: "api_key",
      wizard: {
        choiceId: "opencode-go",
        choiceLabel: "OpenCode Go catalog",
        groupId: "opencode",
        groupLabel: "OpenCode",
        groupHint: "Shared API key for Zen + Go catalogs",
      },
    });
  });
});
