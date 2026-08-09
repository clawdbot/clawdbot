import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ warn: mocks.warn }),
}));

import { requireActivePluginChannelRegistry } from "./runtime.js";
import {
  clearSessionDiscussionProvider,
  getSessionDiscussionProvider,
  registerSessionDiscussionProvider,
  type SessionDiscussionProvider,
} from "./session-discussion-registry.js";

function provider(id: string): SessionDiscussionProvider {
  return {
    id,
    info: vi.fn().mockResolvedValue({ state: "available" }),
    open: vi.fn().mockResolvedValue({ state: "open" }),
  };
}

describe("session discussion provider registry", () => {
  beforeEach(() => {
    mocks.warn.mockClear();
    clearSessionDiscussionProvider();
  });

  it("keeps providers owner-keyed without silently displacing the first owner", () => {
    const first = provider("first");
    const second = provider("second");

    registerSessionDiscussionProvider(first);
    expect(getSessionDiscussionProvider()).toBe(first);
    expect(mocks.warn).not.toHaveBeenCalled();

    registerSessionDiscussionProvider(second);
    expect(getSessionDiscussionProvider()).toBe(first);
    expect([...requireActivePluginChannelRegistry().sessionDiscussionProviders.keys()]).toEqual([
      "first",
      "second",
    ]);
    expect(mocks.warn).toHaveBeenCalledWith(
      "session discussion provider second registered alongside first; retaining first as the default",
    );
  });
});
