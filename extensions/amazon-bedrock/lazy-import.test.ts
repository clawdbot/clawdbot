import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

function mockBedrockSdkImportTripwire(): () => number {
  let importCount = 0;
  vi.doMock("@aws-sdk/client-bedrock", () => {
    importCount += 1;
    throw new Error("Bedrock SDK should not load during plugin registration");
  });
  return () => importCount;
}

describe("amazon-bedrock lazy imports", () => {
  afterEach(() => {
    vi.doUnmock("@aws-sdk/client-bedrock");
    vi.resetModules();
  });

  it("registers the runtime plugin without loading the Bedrock SDK", async () => {
    const getImportCount = mockBedrockSdkImportTripwire();
    const { default: amazonBedrockPlugin } = await import("./index.js");

    const provider = await registerSingleProviderPlugin(amazonBedrockPlugin);

    expect(provider.id).toBe("amazon-bedrock");
    expect(provider.resolveConfigApiKey?.({ env: { AWS_PROFILE: "default" } } as never)).toBe(
      "AWS_PROFILE",
    );
    expect(getImportCount()).toBe(0);
  });

  it("registers the setup entry without loading the Bedrock SDK", async () => {
    const getImportCount = mockBedrockSdkImportTripwire();
    const { default: setupPlugin } = await import("./setup-api.js");
    const providers: Array<{
      id: string;
      resolveConfigApiKey?: (params: never) => string | undefined;
    }> = [];

    setupPlugin.register({
      registerProvider(provider: {
        id: string;
        resolveConfigApiKey?: (params: never) => string | undefined;
      }) {
        providers.push(provider);
      },
      registerConfigMigration() {},
    } as never);

    expect(providers.map((provider) => provider.id)).toEqual(["amazon-bedrock"]);
    expect(providers[0]?.resolveConfigApiKey?.({ env: { AWS_PROFILE: "default" } } as never)).toBe(
      "AWS_PROFILE",
    );
    expect(getImportCount()).toBe(0);
  });
});
