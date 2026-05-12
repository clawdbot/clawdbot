import type { CliBackendPlugin } from "openclaw/plugin-sdk/cli-backend";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { describe, expect, it } from "vitest";
import setupEntry from "./setup-api.js";

describe("google setup entry", () => {
  it("registers setup runtime providers declared by the manifest", () => {
    const providerIds: string[] = [];
    const cliBackendIds: string[] = [];

    setupEntry.register({
      registerProvider(provider: ProviderPlugin) {
        providerIds.push(provider.id);
      },
      registerCliBackend(backend: CliBackendPlugin) {
        cliBackendIds.push(backend.id);
      },
    } as never);

    expect(providerIds).toEqual(["google-vertex"]);
    expect(cliBackendIds).toEqual(["google-gemini-cli"]);
  });
});
