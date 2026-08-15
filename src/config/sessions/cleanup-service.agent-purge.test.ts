import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../types.openclaw.js";
import { purgeAgentSessionStoreEntries } from "./cleanup-service.js";

const sessionAccessorMocks = vi.hoisted(() => ({
  applySessionEntryLifecycleMutation: vi.fn(async () => ({
    removedEntries: 0,
    removedSessionKeys: [],
    archivedTranscriptDirectories: [],
    unreferencedArtifacts: null,
    maintenanceReport: null,
    afterCount: 0,
  })),
  purgeDeletedAgentSessionEntries: vi.fn(async () => ({
    removedEntries: 0,
    removedSessionKeys: [],
    archivedTranscriptDirectories: [],
    unreferencedArtifacts: null,
    maintenanceReport: null,
    afterCount: 0,
  })),
}));

vi.mock("./session-accessor.js", () => sessionAccessorMocks);

describe("purgeAgentSessionStoreEntries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("purges deleted-agent entries through the storage boundary", async () => {
    const cfg = {
      session: { store: "/tmp/openclaw-agent-purge-sessions.json" },
      agents: {
        list: [
          { id: "main", workspace: "/workspace/main" },
          { id: "ops", workspace: "/workspace/ops" },
        ],
      },
    } satisfies OpenClawConfig;

    await purgeAgentSessionStoreEntries(cfg, "ops");

    expect(sessionAccessorMocks.purgeDeletedAgentSessionEntries).toHaveBeenCalledWith({
      cfg,
      agentId: "ops",
      storeAgentId: "main",
      storePath: "/tmp/openclaw-agent-purge-sessions.json",
    });
    expect(sessionAccessorMocks.applySessionEntryLifecycleMutation).not.toHaveBeenCalled();
  });
});
