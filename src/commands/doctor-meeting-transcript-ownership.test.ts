import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import type { TranscriptSourceProvider } from "../transcripts/provider-types.js";
import { TranscriptsStore } from "../transcripts/store.js";
import {
  applyMeetingTranscriptOwnershipRepairs,
  inspectMeetingTranscriptOwnership,
  noteMeetingTranscriptOwnership,
} from "./doctor-meeting-transcript-ownership.js";

const { getTranscriptSourceProviderMock } = vi.hoisted(() => ({
  getTranscriptSourceProviderMock: vi.fn(),
}));

vi.mock("../transcripts/provider-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../transcripts/provider-registry.js")>()),
  getTranscriptSourceProvider: getTranscriptSourceProviderMock,
}));

const tempDirs = createTempDirTracker();

function createFixture() {
  const stateDir = tempDirs.make("openclaw-doctor-transcript-ownership-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  return {
    env,
    store: new TranscriptsStore(path.join(stateDir, "transcripts"), { env }),
  };
}

function provider(params: {
  infer?: TranscriptSourceProvider["inferLegacyOwnership"];
  channels?: string[];
}): TranscriptSourceProvider {
  return {
    id: "account-bound",
    name: "Account Bound",
    sourceKinds: ["live-audio"],
    accountBindingChannels: params.channels ?? ["discord"],
    ...(params.infer ? { inferLegacyOwnership: params.infer } : {}),
  };
}

describe("Doctor meeting transcript ownership normalization", () => {
  beforeEach(() => {
    getTranscriptSourceProviderMock.mockReset();
  });

  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    tempDirs.cleanup();
  });

  it("normalizes a provider-proven legacy owner once", async () => {
    const fixture = createFixture();
    getTranscriptSourceProviderMock.mockReturnValue(
      provider({
        infer: (source) =>
          source.accountId
            ? { ownerChannel: "discord", ownerAccountId: source.accountId }
            : undefined,
      }),
    );
    await fixture.store.writeSession({
      sessionId: "legacy-owned",
      startedAt: "2026-07-24T10:00:00.000Z",
      source: { providerId: "account-bound", accountId: "work" },
      metadata: { agentId: "main", retained: true },
    });

    const inspection = inspectMeetingTranscriptOwnership({ cfg: {}, env: fixture.env });
    expect(inspection).toMatchObject({ unresolved: 0 });
    expect(inspection.repairs).toHaveLength(1);
    const warnings: string[] = [];
    const changes: string[] = [];
    const confirmRuntimeRepair = vi.fn().mockResolvedValue(true);
    await noteMeetingTranscriptOwnership({
      cfg: {},
      env: fixture.env,
      prompter: { confirmRuntimeRepair },
      warnings,
      changes,
    });
    expect(confirmRuntimeRepair).toHaveBeenCalledOnce();
    expect(warnings).toEqual([
      "- Found 1 legacy transcript ownership row whose persisted provider facts prove its account owner.",
    ]);
    expect(changes).toEqual([
      "- Normalized 1 legacy transcript ownership row from persisted facts.",
    ]);
    await expect(fixture.store.readSession("legacy-owned")).resolves.toMatchObject({
      metadata: {
        agentId: "main",
        ownerAccountId: "work",
        ownerChannel: "discord",
        retained: true,
      },
    });

    expect(inspectMeetingTranscriptOwnership({ cfg: {}, env: fixture.env })).toEqual({
      repairs: [],
      unresolved: 0,
    });
  });

  it("leaves incomplete or unproven ownership on local recovery", async () => {
    const fixture = createFixture();
    const providers = new Map<string, TranscriptSourceProvider | undefined>([
      [
        "accountless",
        provider({
          infer: (source) =>
            source.accountId
              ? { ownerChannel: "discord", ownerAccountId: source.accountId }
              : undefined,
        }),
      ],
      ["no-opt-in", provider({})],
      [
        "wrong-channel",
        provider({
          infer: () => ({ ownerChannel: "slack", ownerAccountId: "work" }),
        }),
      ],
      ["unavailable", undefined],
      ["partial", provider({ infer: () => ({ ownerChannel: "discord", ownerAccountId: "work" }) })],
      [
        "malformed-inference",
        provider({
          infer: (() => ({
            ownerAccountId: "work",
          })) as TranscriptSourceProvider["inferLegacyOwnership"],
        }),
      ],
    ]);
    getTranscriptSourceProviderMock.mockImplementation((providerId: string) =>
      providers.get(providerId),
    );
    const cases = [
      { providerId: "accountless", source: {}, metadata: { agentId: "main" } },
      { providerId: "no-opt-in", source: { accountId: "work" }, metadata: { agentId: "main" } },
      {
        providerId: "wrong-channel",
        source: { accountId: "work" },
        metadata: { agentId: "main" },
      },
      {
        providerId: "unavailable",
        source: { accountId: "work" },
        metadata: { agentId: "main" },
      },
      {
        providerId: "partial",
        source: { accountId: "work" },
        metadata: { agentId: "main", ownerChannel: "discord" },
      },
      {
        providerId: "malformed-inference",
        source: { accountId: "work" },
        metadata: { agentId: "main" },
      },
    ];
    for (const [index, entry] of cases.entries()) {
      await fixture.store.writeSession({
        sessionId: `unproven-${index}`,
        startedAt: `2026-07-2${index}T10:00:00.000Z`,
        source: { providerId: entry.providerId, ...entry.source },
        metadata: entry.metadata,
      });
    }

<<<<<<< HEAD
    const inspection = inspectMeetingTranscriptOwnership({ cfg: {}, env: fixture.env });
    expect(inspection.repairs).toEqual([]);
    expect(inspection.unresolved).toBe(4);
=======
    const warnings: string[] = [];
    const changes: string[] = [];
    const confirmRuntimeRepair = vi.fn().mockResolvedValue(true);
    await noteMeetingTranscriptOwnership({
      cfg: {},
      env: fixture.env,
      prompter: { confirmRuntimeRepair },
      warnings,
      changes,
    });
    expect(warnings).toEqual([
      "- Kept 5 legacy transcript ownership rows local-only because account ownership cannot be proven.",
    ]);
    expect(changes).toEqual([]);
    expect(confirmRuntimeRepair).not.toHaveBeenCalled();
>>>>>>> 4fdd840246b (fix(doctor): validate transcript owner inference)
    for (const [index, entry] of cases.entries()) {
      await expect(fixture.store.readSession(`unproven-${index}`)).resolves.toMatchObject({
        metadata: entry.metadata,
      });
    }
  });

  it("does not overwrite a row that changes after inspection", async () => {
    const fixture = createFixture();
    getTranscriptSourceProviderMock.mockReturnValue(
      provider({
        infer: (source) =>
          source.accountId
            ? { ownerChannel: "discord", ownerAccountId: source.accountId }
            : undefined,
      }),
    );
    const session = {
      sessionId: "concurrent-owner",
      startedAt: "2026-07-24T11:00:00.000Z",
      source: { providerId: "account-bound", accountId: "work" },
      metadata: { agentId: "main" },
    };
    await fixture.store.writeSession(session);
    const inspection = inspectMeetingTranscriptOwnership({ cfg: {}, env: fixture.env });
    await fixture.store.writeSession({
      ...session,
      metadata: {
        agentId: "main",
        ownerChannel: "discord",
        ownerAccountId: "new-owner",
      },
    });

    expect(
      applyMeetingTranscriptOwnershipRepairs({ repairs: inspection.repairs, env: fixture.env }),
    ).toBe(0);
    await expect(fixture.store.readSession("concurrent-owner")).resolves.toMatchObject({
      metadata: { ownerAccountId: "new-owner", ownerChannel: "discord" },
    });
  });
});
