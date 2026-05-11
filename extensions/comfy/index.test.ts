import fs from "node:fs";
import {
  registerSingleProviderPlugin,
  resolveProviderPluginChoice,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

type ComfyManifest = {
  providerAuthChoices?: Array<{ choiceId?: string; method?: string; provider?: string }>;
};

function readManifest(): ComfyManifest {
  return JSON.parse(
    fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
  ) as ComfyManifest;
}

describe("comfy provider plugin", () => {
  it("registers cloud API-key auth metadata", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(provider.id).toBe("comfy");
    expect(provider.envVars).toEqual(["COMFY_API_KEY", "COMFY_CLOUD_API_KEY"]);
    expect(provider.auth?.map((method) => method.id)).toEqual(["cloud-api-key"]);

    const choice = resolveProviderPluginChoice({
      providers: [provider],
      choice: "comfy-cloud-api-key",
    });
    expect(choice?.provider.id).toBe("comfy");
    expect(choice?.method.id).toBe("cloud-api-key");
    expect(readManifest().providerAuthChoices).toEqual([
      {
        provider: "comfy",
        method: "cloud-api-key",
        choiceId: "comfy-cloud-api-key",
        choiceLabel: "Comfy Cloud API key",
        choiceHint: "Required for cloud workflows",
        cliOption: "--comfy-api-key <key>",
        cliFlag: "--comfy-api-key",
        cliDescription: "Comfy Cloud API key",
        optionKey: "comfyApiKey",
        groupId: "comfy",
        groupLabel: "ComfyUI",
        groupHint: "Local or cloud workflows",
        onboardingScopes: ["image-generation"],
      },
    ]);
  });
});
