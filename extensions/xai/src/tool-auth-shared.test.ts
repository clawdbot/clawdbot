import { NON_ENV_SECRETREF_MARKER } from "openclaw/plugin-sdk/provider-auth-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isXaiToolEnabled,
  resolveFallbackXaiAuth,
  resolveFallbackXaiApiKey,
  resolveXaiToolApiKey,
} from "./tool-auth-shared.js";

describe("xai tool auth helpers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prefers plugin web search keys over legacy grok keys", () => {
    expect(
      resolveFallbackXaiApiKey({
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: {
                  apiKey: "plugin-key", // pragma: allowlist secret
                },
              },
            },
          },
        },
        tools: {
          web: {
            search: {
              grok: {
                apiKey: "legacy-key", // pragma: allowlist secret
              },
            },
          },
        },
      }),
    ).toBe("plugin-key");
  });

  it("returns source metadata and managed markers for fallback auth", () => {
    expect(
      resolveFallbackXaiAuth({
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: {
                  apiKey: { source: "file", provider: "vault", id: "/xai/tool-key" },
                },
              },
            },
          },
        },
      }),
    ).toEqual({
      apiKey: NON_ENV_SECRETREF_MARKER,
      source: "plugins.entries.xai.config.webSearch.apiKey",
    });

    expect(
      resolveFallbackXaiAuth({
        tools: {
          web: {
            search: {
              grok: {
                apiKey: "legacy-key", // pragma: allowlist secret
              },
            },
          },
        },
      }),
    ).toEqual({
      apiKey: "legacy-key",
      source: "tools.web.search.grok.apiKey",
    });
  });

  it("falls back to runtime, then source config, then env for tool auth", () => {
    vi.stubEnv("XAI_API_KEY", "env-key");

    expect(
      resolveXaiToolApiKey({
        runtimeConfig: {
          plugins: {
            entries: {
              xai: {
                config: {
                  webSearch: {
                    apiKey: "runtime-key", // pragma: allowlist secret
                  },
                },
              },
            },
          },
        },
        sourceConfig: {
          plugins: {
            entries: {
              xai: {
                config: {
                  webSearch: {
                    apiKey: "source-key", // pragma: allowlist secret
                  },
                },
              },
            },
          },
        },
      }),
    ).toBe("runtime-key");

    expect(
      resolveXaiToolApiKey({
        sourceConfig: {
          plugins: {
            entries: {
              xai: {
                config: {
                  webSearch: {
                    apiKey: "source-key", // pragma: allowlist secret
                  },
                },
              },
            },
          },
        },
      }),
    ).toBe("source-key");

    expect(resolveXaiToolApiKey({})).toBe("env-key");
  });

  it("honors explicit disabled flags before auth fallback", () => {
    vi.stubEnv("XAI_API_KEY", "env-key");
    expect(isXaiToolEnabled({ enabled: false })).toBe(false);
    expect(isXaiToolEnabled({ enabled: true })).toBe(true);
  });

  it("does not use env fallback when a non-env SecretRef is configured but unavailable", () => {
    vi.stubEnv("XAI_API_KEY", "env-key");

    expect(
      resolveXaiToolApiKey({
        sourceConfig: {
          plugins: {
            entries: {
              xai: {
                config: {
                  webSearch: {
                    apiKey: {
                      source: "file",
                      provider: "vault",
                      id: "/xai/tool-key",
                    },
                  },
                },
              },
            },
          },
        },
      }),
    ).toBeUndefined();
  });

  it("resolves env SecretRefs from source config when runtime snapshot is unavailable", () => {
    vi.stubEnv("XAI_API_KEY", "xai-secretref-key");

    expect(
      resolveXaiToolApiKey({
        sourceConfig: {
          plugins: {
            entries: {
              xai: {
                config: {
                  webSearch: {
                    apiKey: {
                      source: "env",
                      provider: "default",
                      id: "XAI_API_KEY",
                    },
                  },
                },
              },
            },
          },
        },
      }),
    ).toBe("xai-secretref-key");
  });

  it("does not read arbitrary env SecretRef ids for xAI tool auth", () => {
    vi.stubEnv("UNRELATED_SECRET", "should-not-be-read");

    expect(
      resolveXaiToolApiKey({
        sourceConfig: {
          plugins: {
            entries: {
              xai: {
                config: {
                  webSearch: {
                    apiKey: {
                      source: "env",
                      provider: "default",
                      id: "UNRELATED_SECRET",
                    },
                  },
                },
              },
            },
          },
        },
      }),
    ).toBeUndefined();
  });

  it("does not resolve env SecretRefs when provider allowlist excludes XAI_API_KEY", () => {
    vi.stubEnv("XAI_API_KEY", "xai-secretref-key");

    expect(
      resolveXaiToolApiKey({
        sourceConfig: {
          secrets: {
            providers: {
              "xai-env": {
                source: "env",
                allowlist: ["OTHER_XAI_API_KEY"],
              },
            },
          },
          plugins: {
            entries: {
              xai: {
                config: {
                  webSearch: {
                    apiKey: {
                      source: "env",
                      provider: "xai-env",
                      id: "XAI_API_KEY",
                    },
                  },
                },
              },
            },
          },
        },
      }),
    ).toBeUndefined();
  });

  it("does not resolve env SecretRefs when provider source is not env", () => {
    vi.stubEnv("XAI_API_KEY", "xai-secretref-key");

    expect(
      resolveXaiToolApiKey({
        sourceConfig: {
          secrets: {
            providers: {
              "xai-env": {
                source: "file",
                path: "/tmp/secrets.json",
              },
            },
          },
          plugins: {
            entries: {
              xai: {
                config: {
                  webSearch: {
                    apiKey: {
                      source: "env",
                      provider: "xai-env",
                      id: "XAI_API_KEY",
                    },
                  },
                },
              },
            },
          },
        },
      }),
    ).toBeUndefined();
  });
});
