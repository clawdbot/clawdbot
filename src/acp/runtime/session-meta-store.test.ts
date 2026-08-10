import { beforeEach, describe, expect, it, vi } from "vitest";
import { retainLegacyDefaultAgentId } from "../../config/legacy.default-agent-owner.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

const mocks = vi.hoisted(() => ({
  listSessionEntryKeysReadOnly: vi.fn((): string[] => []),
  loadExactSessionEntryReadOnly: vi.fn(),
}));

vi.mock("../../config/sessions/session-accessor.js", () => ({
  listSessionEntryKeysReadOnly: mocks.listSessionEntryKeysReadOnly,
  loadExactSessionEntryReadOnly: mocks.loadExactSessionEntryReadOnly,
}));

vi.mock("../../config/sessions/paths.js", () => ({
  resolveStorePath: (_store: string | undefined, params: { agentId?: string }) =>
    `/stores/${params.agentId ?? "main"}.json`,
}));

const { readSessionEntryFromStore, resolveSessionStorePathForAcp } =
  await import("./session-meta-store.js");

function explicitFleet(): OpenClawConfig {
  return {
    agents: {
      ownership: "explicit",
      entries: { ops: {}, research: {} },
    },
  };
}

describe("ACP session metadata store ownership", () => {
  beforeEach(() => {
    mocks.listSessionEntryKeysReadOnly.mockClear();
    mocks.loadExactSessionEntryReadOnly.mockReset();
  });

  it("does not read a physical fallback store for an ownerless bare key", () => {
    const result = readSessionEntryFromStore({
      cfg: explicitFleet(),
      sessionKey: "global",
    });

    expect(result).toMatchObject({ storeSessionKey: "global" });
    expect(result.storePath).toBeUndefined();
    expect(mocks.loadExactSessionEntryReadOnly).not.toHaveBeenCalled();
  });

  it("reads a retained owner's store for a bare key", () => {
    const cfg = retainLegacyDefaultAgentId(explicitFleet(), "ops");
    mocks.loadExactSessionEntryReadOnly.mockReturnValue({
      entry: { sessionId: "ops-session" },
    });

    const result = readSessionEntryFromStore({ cfg, sessionKey: "global" });

    expect(result).toMatchObject({
      agentId: "ops",
      storePath: "/stores/ops.json",
      entry: { sessionId: "ops-session" },
    });
    expect(mocks.loadExactSessionEntryReadOnly).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "ops", storePath: "/stores/ops.json" }),
    );
  });

  it("rejects a supplied agent that conflicts with an agent-qualified key", () => {
    expect(() =>
      resolveSessionStorePathForAcp({
        cfg: explicitFleet(),
        agentId: "ops",
        sessionKey: "agent:research:work",
      }),
    ).toThrow('Agent id "ops" does not match session key agent "research".');
  });
});
