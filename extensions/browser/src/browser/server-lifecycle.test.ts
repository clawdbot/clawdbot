// Browser tests cover server lifecycle plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";

const beginProfileTransitionMock = vi.hoisted(() => vi.fn());

vi.mock("./server-context.lifecycle.js", () => ({
  beginProfileTransition: beginProfileTransitionMock,
}));

const { stopKnownBrowserProfiles } = await import("./server-lifecycle.js");

beforeEach(() => {
  beginProfileTransitionMock.mockReset();
});

describe("stopKnownBrowserProfiles", () => {
  it("invalidates every profile before awaiting either drain", async () => {
    const releases: Array<() => void> = [];
    beginProfileTransitionMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          releases.push(() => resolve({ stopped: true }));
        }),
    );
    const runtimes = [{ profile: { name: "openclaw" } }, { profile: { name: "user" } }];
    const state = { profiles: new Map(runtimes.map((runtime) => [runtime.profile.name, runtime])) };

    const stopping = stopKnownBrowserProfiles({
      current: state as never,
      closeSharedAdapters: true,
      onWarn: vi.fn(),
    });

    expect(beginProfileTransitionMock).toHaveBeenCalledTimes(2);
    expect(releases).toHaveLength(2);
    for (const release of releases) {
      release();
    }
    await stopping;
  });

  it("warns after parallel drains when one profile cleanup fails", async () => {
    beginProfileTransitionMock
      .mockResolvedValueOnce({ stopped: true })
      .mockRejectedValueOnce(new Error("profile stop failed"));
    const runtimes = [{ profile: { name: "openclaw" } }, { profile: { name: "user" } }];
    const state = { profiles: new Map(runtimes.map((runtime) => [runtime.profile.name, runtime])) };
    const onWarn = vi.fn();

    await expect(
      stopKnownBrowserProfiles({
        current: state as never,
        closeSharedAdapters: true,
        onWarn,
      }),
    ).rejects.toThrow("profile stop failed");

    expect(onWarn).toHaveBeenCalledWith("openclaw browser stop failed: Error: profile stop failed");
  });
});
