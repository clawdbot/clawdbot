// Covers API-key discovery from environment and key files.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureEnv, withEnvAsync } from "../test-utils/env.js";

const envKeys = [
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_CLOUD_PROJECT",
  "KIMI_API_KEY",
  "KIMICODE_API_KEY",
  "MOONSHOT_API_KEY",
] as const;

const originalEnv = captureEnv([...envKeys]);
const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  originalEnv.restore();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  vi.resetModules();
});

describe("getEnvApiKey", () => {
  it("returns no env auth in browser contexts without process", async () => {
    vi.resetModules();
    const { findEnvKeys, getEnvApiKey } = await import("./env-api-keys.js");
    vi.stubGlobal("process", undefined);

    expect(findEnvKeys("openai")).toBeUndefined();
    expect(getEnvApiKey("openai")).toBeUndefined();
    expect(getEnvApiKey("google-vertex")).toBeUndefined();
    expect(getEnvApiKey("amazon-bedrock")).toBeUndefined();
  });

  it("detects Google Vertex ADC credentials on the first synchronous lookup", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openclaw-vertex-adc-"));
    tempDirs.push(dir);
    const credentialsPath = join(dir, "application_default_credentials.json");
    await writeFile(credentialsPath, "{}", "utf-8");
    await withEnvAsync(
      {
        GOOGLE_APPLICATION_CREDENTIALS: credentialsPath,
        GOOGLE_CLOUD_LOCATION: "us-central1",
        GOOGLE_CLOUD_PROJECT: "vertex-project",
      },
      async () => {
        vi.resetModules();
        const { getEnvApiKey } = await import("./env-api-keys.js");

        expect(getEnvApiKey("google-vertex")).toBe("<authenticated>");
      },
    );
  });

  it("detects canonical Moonshot and Kimi provider credentials", async () => {
    await withEnvAsync(
      {
        MOONSHOT_API_KEY: "moonshot-key",
        KIMI_API_KEY: "kimi-key",
        KIMICODE_API_KEY: "kimicode-key",
      },
      async () => {
        vi.resetModules();
        const { findEnvKeys, getEnvApiKey } = await import("./env-api-keys.js");

        expect(findEnvKeys("moonshot")).toEqual(["MOONSHOT_API_KEY", "KIMI_API_KEY"]);
        expect(getEnvApiKey("moonshot")).toBe("moonshot-key");
        expect(findEnvKeys("kimi")).toEqual(["KIMI_API_KEY", "KIMICODE_API_KEY"]);
        expect(getEnvApiKey("kimi")).toBe("kimi-key");
        expect(findEnvKeys("kimi-coding")).toEqual(["KIMI_API_KEY", "KIMICODE_API_KEY"]);
        expect(getEnvApiKey("kimi-coding")).toBe("kimi-key");
      },
    );
  });

  it("falls back to alternate canonical Kimi env vars", async () => {
    await withEnvAsync({ KIMICODE_API_KEY: "kimicode-key" }, async () => {
      vi.resetModules();
      const { findEnvKeys, getEnvApiKey } = await import("./env-api-keys.js");

      expect(findEnvKeys("kimi")).toEqual(["KIMICODE_API_KEY"]);
      expect(getEnvApiKey("kimi")).toBe("kimicode-key");
    });
  });

  it("does not cache missing Google Vertex ADC credentials", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openclaw-vertex-adc-"));
    tempDirs.push(dir);
    const credentialsPath = join(dir, "application_default_credentials.json");
    await withEnvAsync(
      {
        GOOGLE_APPLICATION_CREDENTIALS: credentialsPath,
        GOOGLE_CLOUD_LOCATION: "us-central1",
        GOOGLE_CLOUD_PROJECT: "vertex-project",
      },
      async () => {
        vi.resetModules();
        const { getEnvApiKey } = await import("./env-api-keys.js");

        expect(getEnvApiKey("google-vertex")).toBeUndefined();
        await writeFile(credentialsPath, "{}", "utf-8");
        expect(getEnvApiKey("google-vertex")).toBe("<authenticated>");
      },
    );
  });
});
