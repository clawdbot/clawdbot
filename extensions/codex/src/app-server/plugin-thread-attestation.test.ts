import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkCodexThreadAppAvailability,
  discardUnattestedCodexPluginThread,
} from "./plugin-thread-attestation.js";
import type { v2 } from "./protocol.js";

describe("Codex thread app availability", () => {
  afterEach(() => vi.restoreAllMocks());

  it("checks configured and account apps once using the thread policy", async () => {
    const request = vi.fn(async () => installedApps(["plugin-app", "account-app"]));
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => {});
    await checkCodexThreadAppAvailability({
      client: { request } as never,
      threadId: "thread-mixed",
      appIds: ["plugin-app", "account-app", "plugin-app"],
    });
    expect(request).toHaveBeenCalledExactlyOnceWith(
      "app/installed",
      { threadId: "thread-mixed", forceRefresh: false },
      { signal: undefined },
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("records unavailable apps without blocking the remaining tools", async () => {
    const request = vi.fn(async () => ({
      apps: [
        ...installedApps(["working"]).apps,
        ...installedApps(["disabled"], { enabled: false, callable: false }).apps,
        ...installedApps(["readonly"], { callable: false }).apps,
      ],
    }));
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => {});
    await checkCodexThreadAppAvailability({
      client: { request } as never,
      threadId: "thread-mixed",
      appIds: ["working", "readonly", "missing", "disabled", "missing"],
    });
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "codex apps unavailable; continuing with remaining tools",
      {
        threadId: "thread-mixed",
        failures: ["disabled:disabled", "missing:missing", "readonly:not-callable"],
      },
    );
    expect(request).toHaveBeenCalledOnce();
  });

  it("does not read the app snapshot when no apps are configured", async () => {
    const request = vi.fn();
    await checkCodexThreadAppAvailability({
      client: { request } as never,
      threadId: "thread-empty",
      appIds: [],
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("preserves snapshot request failures and their cause", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => {});
    const cause = new Error("app inventory offline");
    const request = vi.fn(async () => {
      throw cause;
    });
    await expect(
      checkCodexThreadAppAvailability({
        client: { request } as never,
        threadId: "thread-unavailable",
        appIds: ["plugin-app"],
      }),
    ).rejects.toMatchObject({ name: "CodexPluginThreadAppAttestationError", cause });
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"])(
    "preserves cancellation when discovery will %s",
    async (outcome) => {
      const abort = new AbortController();
      const cause = new Error("turn cancelled");
      const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => {});
      const request = vi.fn(async () => {
        abort.abort(cause);
        if (outcome === "reject") {
          throw cause;
        }
        return installedApps([]);
      });
      await expect(
        checkCodexThreadAppAvailability({
          client: { request } as never,
          threadId: "thread-cancelled",
          appIds: ["plugin-app"],
          signal: abort.signal,
        }),
      ).rejects.toBe(cause);
      expect(warn).not.toHaveBeenCalled();
    },
  );
});

describe("unattested Codex plugin thread cleanup", () => {
  it("deletes a persistent thread before its first rollout", async () => {
    const request = vi.fn(async () => ({}));

    await expect(
      discardUnattestedCodexPluginThread({
        client: { request } as never,
        threadId: "thread-persistent",
        ephemeral: false,
      }),
    ).resolves.toBe(true);

    expect(request).toHaveBeenCalledExactlyOnceWith(
      "thread/delete",
      { threadId: "thread-persistent" },
      { timeoutMs: 5_000 },
    );
  });

  it("unsubscribes an ephemeral thread that Codex cannot delete", async () => {
    const request = vi.fn(async () => ({}));

    await expect(
      discardUnattestedCodexPluginThread({
        client: { request } as never,
        threadId: "thread-ephemeral",
        ephemeral: true,
      }),
    ).resolves.toBe(true);

    expect(request).toHaveBeenCalledExactlyOnceWith(
      "thread/unsubscribe",
      { threadId: "thread-ephemeral" },
      { timeoutMs: 5_000 },
    );
  });

  it("does not treat unsubscribe as proof that a persistent thread was deleted", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "thread/delete") {
        throw new Error("thread deletion unavailable");
      }
      return {};
    });

    await expect(
      discardUnattestedCodexPluginThread({
        client: { request } as never,
        threadId: "thread-persistent",
        ephemeral: false,
      }),
    ).resolves.toBe(false);

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/delete",
      "thread/unsubscribe",
    ]);
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
