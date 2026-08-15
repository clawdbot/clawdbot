import { describe, expect, it } from "vitest";
import { scanPolicyDataHandling, scanPolicySecrets } from "./policy-state-data.js";

describe("scanPolicyDataHandling", () => {
  it("reports canonical per-agent memory overrides from agents.entries", () => {
    const evidence = scanPolicyDataHandling({
      memory: { search: { experimental: { sessionMemory: false } } },
      agents: {
        entries: {
          support: {
            memory: {
              search: { sources: ["sessions"], experimental: { sessionMemory: true } },
            },
          },
        },
      },
    });

    expect(evidence).toContainEqual(
      expect.objectContaining({
        kind: "memorySessionTranscriptIndexing",
        source:
          "oc://openclaw.config/agents/entries/support/memory/search/experimental/sessionMemory",
        scope: "agent",
        agentId: "support",
        value: true,
      }),
    );
  });

  it("scans canonical per-agent memory headers", () => {
    const evidence = scanPolicySecrets({
      agents: {
        entries: {
          support: {
            memory: {
              search: {
                remote: {
                  headers: {
                    Authorization: { source: "env", provider: "default", id: "MEMORY_HEADER" },
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(evidence.some((entry) => entry.source.includes("agents/entries/support"))).toBe(true);
  });

  it("keeps legacy-list policy evidence visible during doctor compatibility", () => {
    const evidence = scanPolicyDataHandling({
      memory: { search: { experimental: { sessionMemory: false } } },
      agents: {
        list: [
          {
            id: "support",
            memory: {
              search: { sources: ["sessions"], experimental: { sessionMemory: true } },
            },
          },
        ],
      },
    });

    expect(evidence).toContainEqual(
      expect.objectContaining({
        source: "oc://openclaw.config/agents/list/#0/memory/search/experimental/sessionMemory",
        agentId: "support",
        value: true,
      }),
    );
  });
});
