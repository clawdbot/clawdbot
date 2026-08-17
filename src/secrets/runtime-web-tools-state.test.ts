/** Tests clone isolation for active web-tool metadata state. */
import { afterEach, describe, expect, it } from "vitest";
import {
  clearActiveRuntimeWebToolsMetadata,
  getActiveRuntimeWebToolsMetadataFromState,
  setActiveRuntimeWebToolsMetadata,
} from "./runtime-web-tools-state.js";

describe("runtime web tools state", () => {
  afterEach(() => {
    clearActiveRuntimeWebToolsMetadata();
  });

  it("exposes active runtime web tool metadata as a defensive clone", () => {
    setActiveRuntimeWebToolsMetadata({
      search: {
        providerConfigured: "gemini",
        providerSource: "configured",
        selectedProvider: "gemini",
        selectedProviderKeySource: "secretRef",
        diagnostics: [],
      },
      fetch: {
        providerSource: "none",
        diagnostics: [],
      },
      diagnostics: [],
    });

    const first = getActiveRuntimeWebToolsMetadataFromState();
    if (!first) {
      throw new Error("missing runtime web tools metadata");
    }
    expect(first.search.providerConfigured).toBe("gemini");
    expect(first.search.selectedProvider).toBe("gemini");
    expect(first.search.selectedProviderKeySource).toBe("secretRef");
    first.search.providerConfigured = "brave";
    first.search.selectedProvider = "brave";

    const second = getActiveRuntimeWebToolsMetadataFromState();
    if (!second) {
      throw new Error("missing cloned runtime web tools metadata");
    }
    expect(second.search.providerConfigured).toBe("gemini");
    expect(second.search.selectedProvider).toBe("gemini");
  });
});
