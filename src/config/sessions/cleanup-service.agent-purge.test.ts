import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLogger } from "../../logging/logger.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { purgeAgentSessionStoreEntries } from "./cleanup-service.js";

const sessionAccessorMocks = vi.hoisted(() => ({
  applySessionEntryLifecycleMutation: vi.fn(async () => ({
    removedEntries: 0,
    removedSessionKeys: [],
    archivedTranscriptDirectories: [],
    afterCount: 0,
  })),
  purgeDeletedAgentSessionEntries: vi.fn(async () => ({
    removedEntries: 0,
    removedSessionKeys: [],
    archivedTranscriptDirectories: [],
    afterCount: 0,
  })),
}));

vi.mock("./session-accessor.js", () => sessionAccessorMocks);

describe("purgeAgentSessionStoreEntries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

    await expect(purgeAgentSessionStoreEntries(cfg, "ops")).resolves.toBe(false);

    expect(sessionAccessorMocks.purgeDeletedAgentSessionEntries).toHaveBeenCalledWith({
      cfg,
      agentId: "ops",
      storeAgentId: "main",
      storePath: "/tmp/openclaw-agent-purge-sessions.json",
    });
    expect(sessionAccessorMocks.applySessionEntryLifecycleMutation).not.toHaveBeenCalled();
  });

  it("treats an absent store as an already successful purge", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    await expect(purgeAgentSessionStoreEntries({}, "ops")).resolves.toBe(false);

    expect(sessionAccessorMocks.purgeDeletedAgentSessionEntries).not.toHaveBeenCalled();
  });

  it("records a bounded warning and failure fact when storage purge fails", async () => {
    const storePath = "/tmp/openclaw-agent-purge-failure-sessions.json";
    const cfg = { session: { store: storePath } } satisfies OpenClawConfig;
    const error = new Error("injected purge failure");
    sessionAccessorMocks.purgeDeletedAgentSessionEntries.mockRejectedValueOnce(error);
    const warn = vi.spyOn(getLogger(), "warn").mockImplementation(() => {});

    await expect(purgeAgentSessionStoreEntries(cfg, "ops")).resolves.toBe(true);

    expect(warn).toHaveBeenCalledWith("session store purge failed during agent deletion", {
      agentId: "ops",
      error,
      storePath,
    });
  });
});
