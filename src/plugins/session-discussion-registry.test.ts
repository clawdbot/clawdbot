import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ warn: mocks.warn }),
}));

import {
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
  });

  it("returns the registered provider and warns when replacing it", () => {
    const first = provider("first");
    const second = provider("second");

    registerSessionDiscussionProvider(first);
    expect(getSessionDiscussionProvider()).toBe(first);
    expect(mocks.warn).not.toHaveBeenCalled();

    registerSessionDiscussionProvider(second);
    expect(getSessionDiscussionProvider()).toBe(second);
    expect(mocks.warn).toHaveBeenCalledWith(
      "replacing session discussion provider first with second",
    );
  });
});
