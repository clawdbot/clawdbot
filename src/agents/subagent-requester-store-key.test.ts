import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveRequesterStoreKey } from "./subagent-requester-store-key.js";

describe("resolveRequesterStoreKey", () => {
  it("scopes a custom main alias to the persisted fixed-store owner", () => {
    const cfg = {
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
      session: { mainKey: "work", store: "/tmp/openclaw-shared-sessions.sqlite" },
    } satisfies OpenClawConfig;

    expect(resolveRequesterStoreKey(cfg, "work")).toBe("agent:ops:work");
  });
});
