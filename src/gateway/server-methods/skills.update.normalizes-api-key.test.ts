import { describe, expect, it, vi } from "vitest";
import { REDACTED_SENTINEL } from "../../config/redact-snapshot.js";

let writtenConfig: unknown = null;
let loadedConfig: unknown = {
  skills: {
    entries: {},
  },
};

vi.mock("../../config/config.js", () => {
  return {
    loadConfig: () => loadedConfig,
    getRuntimeConfig: () => loadedConfig,
    writeConfigFile: async (cfg: unknown) => {
      writtenConfig = cfg;
    },
    replaceConfigFile: async ({ nextConfig }: { nextConfig: unknown }) => {
      writtenConfig = nextConfig;
    },
  };
});

const { skillsHandlers } = await import("./skills.js");

describe("skills.update", () => {
  it("strips embedded CR/LF from apiKey", async () => {
    writtenConfig = null;
    loadedConfig = {
      skills: {
        entries: {},
      },
    };

    let ok: boolean | null = null;
    let error: unknown = null;
    await skillsHandlers["skills.update"]({
      params: {
        skillKey: "brave-search",
        apiKey: "abc\r\ndef",
      },
      req: {} as never,
      client: null as never,
      isWebchatConnect: () => false,
      context: { getRuntimeConfig: () => ({ skills: { entries: {} } }) } as never,
      respond: (success, _result, err) => {
        ok = success;
        error = err;
      },
    });

    expect(ok).toBe(true);
    expect(error).toBeUndefined();
    expect(writtenConfig).toMatchObject({
      skills: {
        entries: {
          "brave-search": {
            apiKey: "abcdef",
          },
        },
      },
    });
  });

  it("redacts apiKey and secret env values from the response but writes full values to config", async () => {
    writtenConfig = null;
    loadedConfig = {
      skills: {
        entries: {},
      },
    };

    let responseResult: unknown = null;
    await skillsHandlers["skills.update"]({
      params: {
        skillKey: "demo-skill",
        apiKey: "secret-api-key-123",
        env: {
          GEMINI_API_KEY: "secret-env-key-456",
          BRAVE_REGION: "us",
        },
      },
      req: {} as never,
      client: null as never,
      isWebchatConnect: () => false,
      context: { getRuntimeConfig: () => loadedConfig } as never,
      respond: (_success, result, _err) => {
        responseResult = result;
      },
    });

    // Full values must be persisted to config
    expect(writtenConfig).toMatchObject({
      skills: {
        entries: {
          "demo-skill": {
            apiKey: "secret-api-key-123",
            env: {
              GEMINI_API_KEY: "secret-env-key-456",
              BRAVE_REGION: "us",
            },
          },
        },
      },
    });

    // Response must not expose plaintext secrets
    const config = (responseResult as { config: Record<string, unknown> }).config;
    expect(config.apiKey).toBe(REDACTED_SENTINEL);
    const env = config.env as Record<string, string>;
    expect(env.GEMINI_API_KEY).toBe(REDACTED_SENTINEL);
    // Non-secret env values should still be present
    expect(env.BRAVE_REGION).toBe("us");
  });

  it("keeps existing secrets when clients submit redacted sentinel values", async () => {
    writtenConfig = null;
    loadedConfig = {
      skills: {
        entries: {
          "demo-skill": {
            apiKey: "secret-api-key-123",
            env: {
              GEMINI_API_KEY: "secret-env-key-456",
              BRAVE_REGION: "us",
            },
          },
        },
      },
    };

    await skillsHandlers["skills.update"]({
      params: {
        skillKey: "demo-skill",
        apiKey: REDACTED_SENTINEL,
        env: {
          GEMINI_API_KEY: REDACTED_SENTINEL,
          BRAVE_REGION: "eu",
        },
      },
      req: {} as never,
      client: null as never,
      isWebchatConnect: () => false,
      context: { getRuntimeConfig: () => loadedConfig } as never,
      respond: () => {},
    });

    expect(writtenConfig).toMatchObject({
      skills: {
        entries: {
          "demo-skill": {
            apiKey: "secret-api-key-123",
            env: {
              GEMINI_API_KEY: "secret-env-key-456",
              BRAVE_REGION: "eu",
            },
          },
        },
      },
    });
  });
});
