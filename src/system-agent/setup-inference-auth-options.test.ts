import { describe, expect, it } from "vitest";
import type { ProviderInstallCatalogEntry } from "../plugins/provider-install-catalog.js";
import {
  listSetupInferenceAuthOptions,
  listSetupInferenceInstallOptions,
} from "./setup-inference-auth-options.js";

const metaEntry: ProviderInstallCatalogEntry = {
  pluginId: "meta",
  providerId: "meta",
  methodId: "api-key",
  choiceId: "meta-api-key",
  choiceLabel: "Meta API key",
  choiceHint: "Meta Responses API",
  groupId: "meta",
  groupLabel: "Meta",
  onboardingScopes: ["text-inference"],
  label: "Meta",
  origin: "bundled",
  install: { npmSpec: "@openclaw/meta-provider", defaultChoice: "npm" },
};

describe("setup inference install options", () => {
  it("offers a provider-owned wizard without app-specific auth metadata", () => {
    expect(listSetupInferenceAuthOptions([metaEntry])).toEqual([
      expect.objectContaining({ id: "meta-api-key", kind: "install" }),
    ]);
  });
  it("surfaces uninstalled text providers as managed install choices", () => {
    expect(listSetupInferenceInstallOptions([metaEntry], [])).toEqual([
      {
        id: "meta-api-key",
        brandId: "meta",
        label: "Meta API key",
        hint: "Meta Responses API",
        groupLabel: "Meta",
        kind: "install",
        featured: false,
      },
    ]);
  });

  it("does not duplicate choices already supplied by an installed manifest", () => {
    expect(
      listSetupInferenceInstallOptions(
        [metaEntry],
        [
          {
            pluginId: "meta",
            providerId: "meta",
            methodId: "api-key",
            choiceId: "meta-api-key",
            choiceLabel: "Meta API key",
          },
        ],
      ),
    ).toEqual([]);
  });
});
