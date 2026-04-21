import { describe, expect, it } from "vitest";
import {
  INVALID_EXEC_SECRET_REF_IDS,
  VALID_EXEC_SECRET_REF_IDS,
} from "../test-utils/secret-ref-test-vectors.js";
import { validateConfigObjectRaw } from "./validation.js";

function validateOpenAiApiKeyRef(apiKey: unknown) {
  return validateConfigObjectRaw({
    models: {
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          apiKey,
          models: [{ id: "gpt-5", name: "gpt-5" }],
        },
      },
    },
  });
}

describe("config secret refs schema", () => {
  it("accepts top-level secrets sources and model apiKey refs", () => {
    const result = validateConfigObjectRaw({
      secrets: {
        providers: {
          default: { source: "env" },
          filemain: {
            source: "file",
            path: "~/.openclaw/secrets.json",
            mode: "json",
            timeoutMs: 10_000,
          },
          vault: {
            source: "exec",
            command: "/usr/local/bin/openclaw-secret-resolver",
            args: ["resolve"],
            allowSymlinkCommand: true,
          },
        },
      },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
            models: [{ id: "gpt-5", name: "gpt-5" }],
          },
        },
      },
    });

    expect(result.ok).toBe(true);
  });

  it("accepts openai-codex-responses as a model api value", () => {
    const result = validateConfigObjectRaw({
      models: {
        providers: {
          "openai-codex": {
            baseUrl: "https://chatgpt.com/backend-api",
            api: "openai-codex-responses",
            models: [{ id: "gpt-5.4", name: "gpt-5.4" }],
          },
        },
      },
    });

    expect(result.ok).toBe(true);
  });

  it("accepts skills entry apiKey refs", () => {
    const result = validateConfigObjectRaw({
      skills: {
        entries: {
          "review-pr": {
            enabled: true,
            apiKey: { source: "env", provider: "default", id: "SKILL_REVIEW_PR_API_KEY" },
          },
        },
      },
    });

    expect(result.ok).toBe(true);
  });

  it("accepts media request secret refs for auth, headers, and tls material", () => {
    const result = validateConfigObjectRaw({
      tools: {
        media: {
          audio: {
            enabled: true,
            request: {
              headers: {
                "X-Tenant": { source: "env", provider: "default", id: "MEDIA_TENANT_HEADER" },
              },
              auth: {
                mode: "authorization-bearer",
                token: { source: "env", provider: "default", id: "MEDIA_AUDIO_TOKEN" },
              },
              proxy: {
                mode: "explicit-proxy",
                url: "http://proxy.example:8080",
                tls: {
                  ca: { source: "file", provider: "filemain", id: "/tls/proxy-ca" },
                },
              },
              tls: {
                cert: { source: "file", provider: "filemain", id: "/tls/client-cert" },
                key: { source: "file", provider: "filemain", id: "/tls/client-key" },
                passphrase: { source: "exec", provider: "vault", id: "media/audio/passphrase" },
              },
            },
            models: [{ provider: "openai", model: "gpt-4o-mini-transcribe" }],
          },
        },
      },
    });

    expect(result.ok).toBe(true);
  });

  it("accepts model provider request secret refs for auth, headers, and tls material", () => {
    const result = validateConfigObjectRaw({
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            request: {
              headers: {
                "X-Tenant": { source: "env", provider: "default", id: "OPENAI_TENANT_HEADER" },
              },
              auth: {
                mode: "authorization-bearer",
                token: { source: "env", provider: "default", id: "OPENAI_PROVIDER_TOKEN" },
              },
              proxy: {
                mode: "explicit-proxy",
                url: "http://proxy.example:8080",
                tls: {
                  ca: { source: "file", provider: "filemain", id: "/tls/provider-proxy-ca" },
                },
              },
              tls: {
                cert: { source: "file", provider: "filemain", id: "/tls/provider-cert" },
                key: { source: "file", provider: "filemain", id: "/tls/provider-key" },
              },
            },
            models: [{ id: "gpt-5", name: "gpt-5" }],
          },
        },
      },
    });

    expect(result.ok).toBe(true);
  });

  it("accepts model provider header SecretRef values", () => {
    const result = validateConfigObjectRaw({
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            api: "openai-completions",
            headers: {
              Authorization: {
                source: "env",
                provider: "default",
                id: "OPENAI_HEADER_TOKEN",
              },
            },
            models: [],
          },
        },
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.models?.providers?.openai?.headers?.Authorization).toEqual({
        source: "env",
        provider: "default",
        id: "OPENAI_HEADER_TOKEN",
      });
    }
  });

  it("rejects model provider request proxy url secret refs", () => {
    const result = validateConfigObjectRaw({
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            request: {
              proxy: {
                mode: "explicit-proxy",
                url: { source: "env", provider: "default", id: "PROVIDER_PROXY_URL" },
              },
            },
            models: [{ id: "gpt-5", name: "gpt-5" }],
          },
        },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some((issue) => issue.path.includes("models.providers.openai.request.proxy")),
      ).toBe(true);
    }
  });

  it('accepts file refs with id "value" for singleValue mode providers', () => {
    const result = validateConfigObjectRaw({
      secrets: {
        providers: {
          rawfile: {
            source: "file",
            path: "~/.openclaw/token.txt",
            mode: "singleValue",
          },
        },
      },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: { source: "file", provider: "rawfile", id: "value" },
            models: [{ id: "gpt-5", name: "gpt-5" }],
          },
        },
      },
    });

    expect(result.ok).toBe(true);
  });

  it("rejects invalid secret ref id", () => {
    const result = validateOpenAiApiKeyRef({
      source: "env",
      provider: "default",
      id: "bad id with spaces",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some((issue) => issue.path.includes("models.providers.openai.apiKey")),
      ).toBe(true);
    }
  });

  it("rejects env refs that are not env var names", () => {
    const result = validateOpenAiApiKeyRef({
      source: "env",
      provider: "default",
      id: "/providers/openai/apiKey",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some(
          (issue) =>
            issue.path.includes("models.providers.openai.apiKey") &&
            issue.message.includes("Env secret reference id"),
        ),
      ).toBe(true);
    }
  });

  it("rejects file refs that are not absolute JSON pointers", () => {
    const result = validateOpenAiApiKeyRef({
      source: "file",
      provider: "default",
      id: "providers/openai/apiKey",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some(
          (issue) =>
            issue.path.includes("models.providers.openai.apiKey") &&
            issue.message.includes("absolute JSON pointer"),
        ),
      ).toBe(true);
    }
  });

  it("accepts valid exec secret reference ids", () => {
    for (const id of VALID_EXEC_SECRET_REF_IDS) {
      const result = validateOpenAiApiKeyRef({
        source: "exec",
        provider: "vault",
        id,
      });
      expect(result.ok, `expected valid exec ref id: ${id}`).toBe(true);
    }
  });

  it("rejects invalid exec secret reference ids", () => {
    for (const id of INVALID_EXEC_SECRET_REF_IDS) {
      const result = validateOpenAiApiKeyRef({
        source: "exec",
        provider: "vault",
        id,
      });
      expect(result.ok, `expected invalid exec ref id: ${id}`).toBe(false);
      if (!result.ok) {
        expect(
          result.issues.some((issue) => issue.path.includes("models.providers.openai.apiKey")),
        ).toBe(true);
      }
    }
  });
});
