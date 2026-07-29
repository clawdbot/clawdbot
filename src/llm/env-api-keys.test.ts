// Covers API-key discovery from environment and key files.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureEnv, withEnvAsync } from "../test-utils/env.js";

const envKeys = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_OAUTH_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_PROFILE",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_CLOUD_PROJECT",
  "KIMI_API_KEY",
  "KIMICODE_API_KEY",
  "MOONSHOT_API_KEY",
  "OPENAI_API_KEY",
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
    const { findEnvKeys, getEnvApiKey } = await import("@openclaw/ai/internal/runtime");
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
        const { getEnvApiKey } = await import("@openclaw/ai/internal/runtime");

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
        const { findEnvKeys, getEnvApiKey } = await import("@openclaw/ai/internal/runtime");

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
      const { findEnvKeys, getEnvApiKey } = await import("@openclaw/ai/internal/runtime");

      expect(findEnvKeys("kimi")).toEqual(["KIMICODE_API_KEY"]);
      expect(getEnvApiKey("kimi")).toBe("kimicode-key");
    });
  });

  it("skips blank API keys and trims the selected fallback", async () => {
    const env = {
      ANTHROPIC_OAUTH_TOKEN: "  ",
      OPENAI_API_KEY: " \t ",
    } as NodeJS.ProcessEnv;
    Reflect.set(env, "ANTHROPIC_API_KEY", "  test-anthropic-key  ");

    await withEnvAsync(env, async () => {
      vi.resetModules();
      const { findEnvKeys, getEnvApiKey } = await import("@openclaw/ai/internal/runtime");

      expect(findEnvKeys("anthropic")).toEqual(["ANTHROPIC_API_KEY"]);
      expect(getEnvApiKey("anthropic")).toBe("test-anthropic-key");
      expect(findEnvKeys("openai")).toBeUndefined();
      expect(getEnvApiKey("openai")).toBeUndefined();
    });
  });

  it("does not report blank AWS credential markers as authentication", async () => {
    await withEnvAsync(
      {
        AWS_ACCESS_KEY_ID: " ",
        AWS_SECRET_ACCESS_KEY: "\t",
        AWS_PROFILE: "  ",
        AWS_BEARER_TOKEN_BEDROCK: "\n",
        AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: " ",
        AWS_CONTAINER_CREDENTIALS_FULL_URI: " ",
        AWS_WEB_IDENTITY_TOKEN_FILE: " ",
      },
      async () => {
        vi.resetModules();
        const { getEnvApiKey } = await import("@openclaw/ai/internal/runtime");

        expect(getEnvApiKey("amazon-bedrock")).toBeUndefined();
      },
    );
  });

  it("keeps non-blank AWS profile authentication available", async () => {
    await withEnvAsync({ AWS_PROFILE: "  production  " }, async () => {
      vi.resetModules();
      const { getEnvApiKey } = await import("@openclaw/ai/internal/runtime");

      expect(getEnvApiKey("amazon-bedrock")).toBe("<authenticated>");
    });
  });

  it("requires non-blank Google Vertex project and location markers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openclaw-vertex-adc-"));
    tempDirs.push(dir);
    const credentialsPath = join(dir, "application_default_credentials.json");
    await writeFile(credentialsPath, "{}", "utf-8");
    const env = {
      GOOGLE_CLOUD_LOCATION: "  ",
      GOOGLE_CLOUD_PROJECT: "\t",
    } as NodeJS.ProcessEnv;
    Reflect.set(env, "GOOGLE_APPLICATION_CREDENTIALS", credentialsPath);

    await withEnvAsync(env, async () => {
      vi.resetModules();
      const { getEnvApiKey } = await import("@openclaw/ai/internal/runtime");

      expect(getEnvApiKey("google-vertex")).toBeUndefined();
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
        const { getEnvApiKey } = await import("@openclaw/ai/internal/runtime");

        // With the relaxed auth gate, GOOGLE_CLOUD_PROJECT alone is sufficient
        // to return "<authenticated>" even without a credentials file on disk.
        // The downstream transport (vertex-adc.ts) handles actual credential
        // resolution at request time via google-auth-library.
        expect(getEnvApiKey("google-vertex")).toBe("<authenticated>");
        await writeFile(credentialsPath, "{}", "utf-8");
        expect(getEnvApiKey("google-vertex")).toBe("<authenticated>");
      },
    );
  });

  it("trims the Google Vertex credentials path before checking it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openclaw-vertex-adc-"));
    tempDirs.push(dir);
    const credentialsPath = join(dir, "application_default_credentials.json");
    await writeFile(credentialsPath, "{}", "utf-8");
    const env = {
      GOOGLE_CLOUD_LOCATION: "us-central1",
      GOOGLE_CLOUD_PROJECT: "vertex-project",
    } as NodeJS.ProcessEnv;
    Reflect.set(env, "GOOGLE_APPLICATION_CREDENTIALS", `  ${credentialsPath}  `);

    await withEnvAsync(env, async () => {
      vi.resetModules();
      const { getEnvApiKey } = await import("@openclaw/ai/internal/runtime");

      expect(getEnvApiKey("google-vertex")).toBe("<authenticated>");
    });
  });
});
