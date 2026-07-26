import { describe, expect, it } from "vitest";
import { resolveMemorySearchConfig } from "../../agents/memory-search.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { MemorySearchConfig } from "../../config/types.tools.js";
import { buildCronAgentDefaultsConfig } from "./run-config.js";

describe("buildCronAgentDefaultsConfig memory search preservation", () => {
  it("keeps global memory search defaults when the agent override is partial", () => {
    const defaultMemorySearch = {
      enabled: true,
      provider: "openai",
      model: "text-embedding-3-large",
      sources: ["memory", "sessions"],
      remote: { apiKey: "redacted" },
      query: { maxResults: 6 },
    } satisfies MemorySearchConfig;
    const agentMemorySearch = {
      rememberAcrossConversations: true,
      query: { maxResults: 10 },
    } satisfies MemorySearchConfig;
    const agentDefaults = buildCronAgentDefaultsConfig({
      defaults: {},
      agentConfigOverride: { memory: { search: agentMemorySearch } },
    });
    const runCfg: OpenClawConfig = {
      plugins: { enabled: false },
      agents: {
        defaults: agentDefaults,
        list: [{ id: "main", default: true, memory: { search: agentMemorySearch } }],
      },
      memory: { search: defaultMemorySearch },
    };

    expect(agentDefaults).not.toHaveProperty("memory");
    expect(resolveMemorySearchConfig(runCfg, "main")).toMatchObject({
      provider: "openai",
      model: "text-embedding-3-large",
      sources: ["memory", "sessions"],
      remote: { apiKey: "redacted" },
      rememberAcrossConversations: true,
      query: { maxResults: 10 },
    });
  });
});
