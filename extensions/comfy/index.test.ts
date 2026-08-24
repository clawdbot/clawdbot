// Comfy tests cover index plugin behavior.
import fs from "node:fs";
import {
  type JsonSchemaObject,
  validateJsonSchemaValue,
} from "openclaw/plugin-sdk/json-schema-runtime";
import {
  registerSingleProviderPlugin,
  resolveProviderPluginChoice,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

type ComfyManifest = {
  configSchema: JsonSchemaObject;
  providerAuthChoices?: Array<{ choiceId?: string; method?: string; provider?: string }>;
};

function readManifest(): ComfyManifest {
  return JSON.parse(
    fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
  ) as ComfyManifest;
}

describe("comfy provider plugin", () => {
  it.each([
    { source: "env", id: "COMFY_KEY" },
    { source: "file", id: "/comfy/apiKey" },
    { source: "file", id: "value" },
    { source: "file", id: "/comfy~1cloud/api~0key" },
    { source: "exec", id: "comfy/apiKey" },
    { source: "exec", id: "vault/comfy-cloud#api_key" },
    { source: "store", id: "COMFY_KEY" },
  ])("accepts $source SecretRef API keys", ({ source, id }) => {
    expect(
      validateJsonSchemaValue({
        schema: readManifest().configSchema,
        cacheKey: `comfy.manifest.apiKey.${source}`,
        value: { apiKey: { source, provider: "default", id } },
      }).ok,
    ).toBe(true);
  });

  it.each([
    { source: "unknown", provider: "default", id: "COMFY_KEY" },
    { source: "env", id: "COMFY_KEY" },
    { source: "env", provider: "default" },
    { source: "env", provider: "default", id: "COMFY_KEY", extra: true },
    { source: "env", provider: "Default", id: "COMFY_KEY" },
    { source: "env", provider: "", id: "COMFY_KEY" },
    { source: "env", provider: `a${"b".repeat(64)}`, id: "COMFY_KEY" },
    { source: "env", provider: "default", id: "comfy_key" },
    { source: "env", provider: "default", id: "9COMFY_KEY" },
    { source: "env", provider: "default", id: `A${"B".repeat(128)}` },
    { source: "store", provider: "default", id: "comfy_key" },
    { source: "store", provider: "bad alias", id: "COMFY_KEY" },
    { source: "file", provider: "default", id: "comfy/apiKey" },
    { source: "file", provider: "default", id: "/comfy~2/apiKey" },
    { source: "file", provider: "default", id: "/comfy~" },
    { source: "exec", provider: "default", id: "" },
    { source: "exec", provider: "default", id: "/comfy/apiKey" },
    { source: "exec", provider: "default", id: "comfy/../apiKey" },
    { source: "exec", provider: "default", id: "comfy/./apiKey" },
    { source: "exec", provider: "default", id: "comfy apiKey" },
    { source: "exec", provider: "default", id: `a${"b".repeat(256)}` },
  ])("rejects malformed SecretRef API keys", (apiKey) => {
    expect(
      validateJsonSchemaValue({
        schema: readManifest().configSchema,
        cacheKey: "comfy.manifest.apiKey.malformed",
        value: { apiKey },
      }).ok,
    ).toBe(false);
  });

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
