import { beforeEach, describe, expect, it, vi } from "vitest";
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

  it("reads a persisted fixed-store owner's store after restart", () => {
    const cfg = {
      ...explicitFleet(),
      session: { store: "/stores/shared.sqlite" },
      agents: {
        ...explicitFleet().agents,
        defaults: { sessionStore: { agentId: "ops" } },
      },
    } satisfies OpenClawConfig;
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

  it("does not read a bare key when the persisted fixed-store owner is retired", () => {
    const cfg = {
      ...explicitFleet(),
      session: { store: "/stores/shared.sqlite" },
      agents: {
        ...explicitFleet().agents,
        defaults: { sessionStore: { agentId: "retired" } },
      },
    } satisfies OpenClawConfig;

    const result = readSessionEntryFromStore({ cfg, sessionKey: "global" });

    expect(result).toMatchObject({ storeSessionKey: "global" });
    expect(result.storePath).toBeUndefined();
    expect(() =>
      readSessionEntryFromStore({ cfg, agentId: "research", sessionKey: "global" }),
    ).toThrowError(expect.objectContaining({ code: "AGENT_SELECTION_REQUIRED" }));
    expect(mocks.loadExactSessionEntryReadOnly).not.toHaveBeenCalled();
  });

  it("rejects a supplied agent that conflicts with a bare fixed-store owner", () => {
    const cfg = {
      ...explicitFleet(),
      session: { store: "/stores/shared.sqlite" },
      agents: {
        ...explicitFleet().agents,
        defaults: { sessionStore: { agentId: "ops" } },
      },
    } satisfies OpenClawConfig;

    expect(() =>
      readSessionEntryFromStore({ cfg, agentId: "research", sessionKey: "global" }),
    ).toThrowError(expect.objectContaining({ code: "AGENT_SELECTION_REQUIRED" }));
    expect(mocks.loadExactSessionEntryReadOnly).not.toHaveBeenCalled();
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
