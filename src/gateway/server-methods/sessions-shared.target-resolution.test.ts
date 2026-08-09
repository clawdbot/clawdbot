import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveCanonicalSessionEntryFromStoreKeys: vi.fn(),
  resolveGatewaySessionStoreTarget: vi.fn(),
  resolveGatewaySessionStoreTargetWithStore: vi.fn(),
}));

vi.mock("../session-utils.js", () => mocks);

import { resolveGatewaySessionTargetFromKey } from "./sessions-shared.js";

const cfg = {};
const target = {
  agentId: "main",
  canonicalKey: "agent:main:target",
  storeKeys: ["agent:main:target"],
  storePath: "/tmp/openclaw-target.sqlite",
};

describe("resolveGatewaySessionTargetFromKey", () => {
  beforeEach(() => {
    mocks.resolveGatewaySessionStoreTarget.mockReset().mockReturnValue(target);
    mocks.resolveGatewaySessionStoreTargetWithStore
      .mockReset()
      .mockReturnValue({ ...target, store: {} });
  });

  it("keeps ordinary delete/compact target resolution on the cheap resolver", () => {
    expect(
      resolveGatewaySessionTargetFromKey("agent:main:target", cfg, { agentId: "main" }),
    ).toEqual({ cfg, target, storePath: target.storePath });
    expect(mocks.resolveGatewaySessionStoreTarget).toHaveBeenCalledOnce();
    expect(mocks.resolveGatewaySessionStoreTargetWithStore).not.toHaveBeenCalled();
  });

  it.each([
    ["exact read", { exactRead: true }],
    ["store cache", { storeCache: new Map() }],
    ["discovery cache", { targetDiscoveryCache: new Map() }],
  ])("uses hydrated resolution for %s", (_name, options) => {
    const resolved = resolveGatewaySessionTargetFromKey("agent:main:target", cfg, options);

    expect(resolved.target).toMatchObject({ ...target, store: {} });
    expect(mocks.resolveGatewaySessionStoreTargetWithStore).toHaveBeenCalledOnce();
    expect(mocks.resolveGatewaySessionStoreTarget).not.toHaveBeenCalled();
  });
});
