import fs from "node:fs";
import {
  registerSingleProviderPlugin,
  resolveProviderPluginChoice,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

type NvidiaManifest = {
  providerAuthChoices?: Array<{ choiceId?: string; method?: string; provider?: string }>;
};

function readManifest(): NvidiaManifest {
  return JSON.parse(
    fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
  ) as NvidiaManifest;
}

describe("nvidia provider plugin", () => {
  it("registers API-key auth metadata", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(provider.id).toBe("nvidia");
    expect(provider.envVars).toEqual(["NVIDIA_API_KEY"]);
    expect(provider.auth?.map((method) => method.id)).toEqual(["api-key"]);

    const choice = resolveProviderPluginChoice({
      providers: [provider],
      choice: "nvidia-api-key",
    });
    expect(choice?.provider.id).toBe("nvidia");
    expect(choice?.method.id).toBe("api-key");
    expect(readManifest().providerAuthChoices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "nvidia",
          method: "api-key",
          choiceId: "nvidia-api-key",
        }),
      ]),
    );
  });
});
