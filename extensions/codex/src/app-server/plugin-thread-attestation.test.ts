// Codex tests cover provisional plugin app attestation behavior.
import { describe, expect, it, vi } from "vitest";
import { attestCodexPluginThreadApps } from "./plugin-thread-attestation.js";
import type { v2 } from "./protocol.js";

describe("Codex provisional plugin app attestation", () => {
  it("reads effective app state directly from the newly started thread", async () => {
    const request = vi.fn(async () => installedApps(["linear-app"]));

    await attestCodexPluginThreadApps({
      client: { request } as never,
      threadId: "thread-linear",
      appIds: ["linear-app", "linear-app"],
    });

    expect(request).toHaveBeenCalledExactlyOnceWith(
      "app/installed",
      {
        threadId: "thread-linear",
        forceRefresh: true,
      },
      { signal: undefined },
    );
  });

  it.each([
    {
      state: "missing",
      response: installedApps([]),
      failure: "linear-app:missing",
    },
    {
      state: "disabled",
      response: installedApps(["linear-app"], { enabled: false, callable: false }),
      failure: "linear-app:disabled",
    },
    {
      state: "not callable",
      response: installedApps(["linear-app"], { callable: false }),
      failure: "linear-app:not-callable",
    },
  ])("fails closed when a provisional app is $state", async ({ response, failure }) => {
    await expect(
      attestCodexPluginThreadApps({
        client: { request: vi.fn(async () => response) } as never,
        threadId: "thread-linear",
        appIds: ["linear-app"],
      }),
    ).rejects.toMatchObject({
      name: "CodexPluginThreadAppAttestationError",
      message: expect.stringContaining(failure),
    });
  });
});

function installedApps(
  appIds: string[],
  state: { enabled?: boolean; callable?: boolean } = {},
): v2.AppsInstalledResponse {
  return {
    apps: appIds.map((id) => ({
      id,
      runtimeName: id,
      enabled: state.enabled ?? true,
      callable: state.callable ?? true,
    })),
  };
}
