import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionAccessScope } from "../config/sessions/session-accessor.types.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadRequesterLifecycleRevision, testing } from "./subagent-requester-lifecycle.js";

const loadSessionEntry = vi.fn<(scope: SessionAccessScope) => SessionEntry | undefined>();
const resolveStorePath = vi.fn(() => "/tmp/sessions.json");

function setDefaultDeps() {
  testing.setDepsForTest({
    getRuntimeConfig: () => ({ session: { mainKey: "main" } }) as OpenClawConfig,
    resolveAgentIdFromSessionKey: () => "main",
    resolveStorePath,
    loadSessionEntry,
    resolveDefaultAgentId: () => "main",
    resolveRequesterStoreKey: (_cfg: OpenClawConfig, key: string) =>
      key.startsWith("agent:") ? key : `agent:main:${key}`,
  });
}

describe("loadRequesterLifecycleRevision", () => {
  beforeEach(() => {
    loadSessionEntry.mockReset();
    resolveStorePath.mockReset().mockReturnValue("/tmp/sessions.json");
    setDefaultDeps();
  });

  afterEach(() => {
    testing.setDepsForTest();
  });

  it("resolves the canonical requester key and returns the persisted lifecycle revision", () => {
    loadSessionEntry.mockReturnValue({ lifecycleRevision: "revision-1" } as SessionEntry);

    expect(loadRequesterLifecycleRevision("main")).toBe("revision-1");
    expect(loadSessionEntry).toHaveBeenCalledWith({
      storePath: "/tmp/sessions.json",
      sessionKey: "agent:main:main",
      clone: false,
    });
    expect(resolveStorePath).toHaveBeenCalledWith(undefined, { agentId: "main" });
  });

  it("passes an already-canonical requester key through unchanged", () => {
    loadSessionEntry.mockReturnValue({ lifecycleRevision: "revision-2" } as SessionEntry);

    expect(loadRequesterLifecycleRevision("agent:main:main")).toBe("revision-2");
    expect(loadSessionEntry).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: "agent:main:main" }),
    );
  });

  it("returns undefined when the session entry has no lifecycle revision", () => {
    loadSessionEntry.mockReturnValue({} as SessionEntry);

    expect(loadRequesterLifecycleRevision("main")).toBeUndefined();
  });

  it("returns undefined without reading the session store for an empty key", () => {
    expect(loadRequesterLifecycleRevision("  ")).toBeUndefined();
    expect(loadSessionEntry).not.toHaveBeenCalled();
  });
});
