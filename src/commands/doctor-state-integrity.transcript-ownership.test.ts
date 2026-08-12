import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import type { TranscriptSourceProvider } from "../transcripts/provider-types.js";
import { TranscriptsStore } from "../transcripts/store.js";
import { noteStateIntegrity } from "./doctor-state-integrity.js";

const { getTranscriptSourceProviderMock } = vi.hoisted(() => ({
  getTranscriptSourceProviderMock: vi.fn(),
}));

vi.mock("../transcripts/provider-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../transcripts/provider-registry.js")>()),
  getTranscriptSourceProvider: getTranscriptSourceProviderMock,
}));

vi.mock("../channels/plugins/bundled-ids.js", () => ({
  listBundledChannelIds: () => ["matrix", "whatsapp"],
  listBundledChannelPluginIds: () => ["matrix", "whatsapp"],
}));

vi.mock("../channels/plugins/persisted-auth-state.js", () => ({
  listBundledChannelIdsWithPersistedAuthState: () => ["matrix", "whatsapp"],
  hasBundledChannelPersistedAuthState: () => false,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("Doctor transcript ownership integration", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  let stateDir = "";

  beforeEach(() => {
    getTranscriptSourceProviderMock.mockReset();
    envSnapshot = captureEnv(["HOME", "OPENCLAW_HOME", "OPENCLAW_STATE_DIR"]);
    stateDir = tempDirs.make("openclaw-doctor-transcript-ownership-integration-");
    setTestEnvValue("HOME", stateDir);
    setTestEnvValue("OPENCLAW_HOME", stateDir);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
  });

  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    envSnapshot.restore();
  });

  it("normalizes global ownership with an ambiguous agent roster", async () => {
    const provider = {
      id: "account-bound",
      name: "Account Bound",
      sourceKinds: ["live-audio"],
      accountBindingChannels: ["discord"],
      inferLegacyOwnership: (source) =>
        source.accountId
          ? { ownerChannel: "discord", ownerAccountId: source.accountId }
          : undefined,
    } satisfies TranscriptSourceProvider;
    getTranscriptSourceProviderMock.mockReturnValue(provider);
    const store = new TranscriptsStore(path.join(stateDir, "transcripts"), { env: process.env });
    await store.writeSession({
      sessionId: "legacy-owned-ambiguous-roster",
      startedAt: "2026-07-24T10:00:00.000Z",
      source: { providerId: provider.id, accountId: "work" },
      metadata: { agentId: "main" },
    });

    const notes: Array<[message: unknown, title: string | undefined]> = [];
    await noteStateIntegrity(
      { agents: { entries: { alpha: {}, beta: {} } } },
      {
        confirmRuntimeRepair: vi.fn(async ({ message }) => message.startsWith("Normalize ")),
        note: (message, title) => notes.push([message, title]),
      },
    );

    expect(notes).toContainEqual([
      expect.stringContaining("Skipped default-agent session"),
      "State integrity",
    ]);
    expect(notes).toContainEqual([
      expect.stringContaining("Normalized 1 legacy transcript ownership row"),
      "Doctor changes",
    ]);
    await expect(store.readSession("legacy-owned-ambiguous-roster")).resolves.toMatchObject({
      metadata: { agentId: "main", ownerChannel: "discord", ownerAccountId: "work" },
    });
  });
});
