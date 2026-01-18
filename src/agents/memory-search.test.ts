import { describe, expect, it } from "vitest";

import { resolveMemorySearchConfig } from "./memory-search.js";

describe("memory search config", () => {
  it("returns null when disabled", () => {
    const cfg = {
      agents: {
        defaults: {
          memorySearch: { enabled: true },
        },
        list: [
          {
            id: "main",
            default: true,
            memorySearch: { enabled: false },
          },
        ],
      },
    };
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved).toBeNull();
  });

  it("merges defaults and overrides", () => {
    const cfg = {
      agents: {
        defaults: {
          memorySearch: {
            provider: "openai",
            model: "text-embedding-3-small",
            store: {
              vector: {
                enabled: false,
                extensionPath: "/opt/sqlite-vec.dylib",
              },
            },
            chunking: { tokens: 500, overlap: 100 },
            query: { maxResults: 4, minScore: 0.2 },
          },
        },
        list: [
          {
            id: "main",
            default: true,
            memorySearch: {
              chunking: { tokens: 320 },
              query: { maxResults: 8 },
              store: {
                vector: {
                  enabled: true,
                },
              },
            },
          },
        ],
      },
    };
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved?.provider).toBe("openai");
    expect(resolved?.model).toBe("text-embedding-3-small");
    expect(resolved?.chunking.tokens).toBe(320);
    expect(resolved?.chunking.overlap).toBe(100);
    expect(resolved?.query.maxResults).toBe(8);
    expect(resolved?.query.minScore).toBe(0.2);
    expect(resolved?.store.vector.enabled).toBe(true);
    expect(resolved?.store.vector.extensionPath).toBe("/opt/sqlite-vec.dylib");
  });

  it("includes batch defaults for openai without remote overrides", () => {
    const cfg = {
      agents: {
        defaults: {
          memorySearch: {
            provider: "openai",
          },
        },
      },
    };
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved?.remote?.batch).toEqual({
      enabled: true,
      wait: true,
      concurrency: 2,
      pollIntervalMs: 2000,
      timeoutMinutes: 60,
    });
  });

  it("keeps remote unset for local provider without overrides", () => {
    const cfg = {
      agents: {
        defaults: {
          memorySearch: {
            provider: "local",
          },
        },
      },
    };
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved?.remote).toBeUndefined();
  });

  it("merges remote defaults with agent overrides", () => {
    const cfg = {
      agents: {
        defaults: {
          memorySearch: {
            remote: {
              baseUrl: "https://default.example/v1",
              apiKey: "default-key",
              headers: { "X-Default": "on" },
            },
          },
        },
        list: [
          {
            id: "main",
            default: true,
            memorySearch: {
              remote: {
                baseUrl: "https://agent.example/v1",
              },
            },
          },
        ],
      },
    };
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved?.remote).toEqual({
      baseUrl: "https://agent.example/v1",
      apiKey: "default-key",
      headers: { "X-Default": "on" },
      batch: {
        enabled: true,
        wait: true,
        concurrency: 2,
        pollIntervalMs: 2000,
        timeoutMinutes: 60,
      },
    });
  });

  it("gates session sources behind experimental flag", () => {
    const cfg = {
      agents: {
        defaults: {
          memorySearch: {
            sources: ["memory", "sessions"],
          },
        },
        list: [
          {
            id: "main",
            default: true,
            memorySearch: {
              experimental: { sessionMemory: false },
            },
          },
        ],
      },
    };
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved?.sources).toEqual(["memory"]);
  });

  it("allows session sources when experimental flag is enabled", () => {
    const cfg = {
      agents: {
        defaults: {
          memorySearch: {
            sources: ["memory", "sessions"],
            experimental: { sessionMemory: true },
          },
        },
      },
    };
    const resolved = resolveMemorySearchConfig(cfg, "main");
    expect(resolved?.sources).toContain("sessions");
  });
});
