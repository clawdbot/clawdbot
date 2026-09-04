import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import { expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { closeTrackedBrowserTabsForSessions } from "./browser-maintenance.js";
import { resolveCdpTabOwnership } from "./src/browser/cdp.helpers.js";
import { resolveBrowserConfig } from "./src/browser/config.js";
import * as registry from "./src/browser/session-tab-registry.js";
import {
  getBrowserSessionTabStore,
  initializeBrowserSessionTabStore,
} from "./src/browser/session-tab-store.js";

it("closes owned tabs over their transports and rechecks claims after runtime lookup", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const requests: string[] = [];
    const closedTargets: string[] = [];
    const targets = new Set(["owned", "user"]);
    const server = createServer((request, response) => {
      const port = (server.address() as AddressInfo).port;
      response.setHeader("content-type", "application/json");
      if (request.url === "/json/version") {
        response.end(
          JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/test` }),
        );
      } else if (request.method === "DELETE") {
        requests.push(`${request.method} ${request.url}`);
        response.end(JSON.stringify({ ok: true }));
      } else {
        response.statusCode = 404;
        response.end("{}");
      }
    });
    const ws = new WebSocketServer({ server });
    ws.on("connection", (socket) => {
      socket.on("message", (data) => {
        const message = JSON.parse(rawDataToString(data)) as {
          id: number;
          method: string;
          params?: { targetId?: string };
        };
        if (message.method === "Target.getTargets") {
          socket.send(
            JSON.stringify({
              id: message.id,
              result: { targetInfos: [...targets].map((targetId) => ({ targetId, type: "page" })) },
            }),
          );
        } else if (message.method === "Target.closeTarget") {
          const targetId = message.params?.targetId ?? "";
          closedTargets.push(targetId);
          socket.send(
            JSON.stringify({ id: message.id, result: { success: targets.delete(targetId) } }),
          );
        }
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const cdpUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const config = {
      browser: { profiles: { remote: { driver: "existing-session" as const, cdpUrl } } },
    };
    await state.writeConfig(config);
    initializeBrowserSessionTabStore({
      state: {
        openSyncKeyedStore: (options) =>
          createPluginStateSyncKeyedStoreForTests("browser", options),
      },
    });
    const sessionKey = "agent:main:transport-cleanup";
    try {
      registry.trackSessionBrowserTab({
        sessionKey,
        targetId: "volatile",
        profile: "remote",
        route: { kind: "browser-control", baseUrl: cdpUrl },
      });
      await expect(closeTrackedBrowserTabsForSessions({ sessionKeys: [sessionKey] })).resolves.toBe(
        1,
      );
      expect(requests).toEqual(["DELETE /tabs/volatile?targetIdMode=raw&profile=remote"]);

      for (const firstKind of ["sweep", "lifecycle"] as const) {
        const joined = {
          sessionKey,
          targetId: `joined-${firstKind}`,
          profile: "remote",
          route: { kind: "browser-control" as const, baseUrl: cdpUrl },
        };
        registry.trackSessionBrowserTab({ ...joined, now: 1_000 });
        const lifecycle = () =>
          registry.closeTrackedBrowserTabsForSessions({ sessionKeys: [sessionKey] });
        const sweep = () => registry.sweepTrackedBrowserTabs({ now: 20_000, idleMs: 1 });
        const before = requests.length;
        const first = firstKind === "sweep" ? sweep() : lifecycle();
        await Promise.resolve();
        expect(requests).toHaveLength(before);
        registry.touchSessionBrowserTab({ ...joined, now: 11_000 });
        const second = firstKind === "sweep" ? lifecycle() : sweep();
        const results = await Promise.all([first, second]);
        expect.soft(results.reduce((total, closed) => total + closed, 0)).toBe(1);
        expect
          .soft(requests.slice(before))
          .toEqual([`DELETE /tabs/joined-${firstKind}?targetIdMode=raw&profile=remote`]);
        await registry.closeTrackedBrowserTabsForSessions({
          sessionKeys: [sessionKey],
          closeTab: async () => {},
        });
      }

      const ownership = await resolveCdpTabOwnership({
        profileName: "remote",
        cdpUrl,
        nativeTargetId: "owned",
      });
      expect(ownership.status).toBe("durable");
      const tab = { sessionKey, targetId: "owned", profile: "remote", ownership };
      registry.trackSessionBrowserTab({ ...tab, now: 1_000 });
      const resolved = resolveBrowserConfig(config.browser, config);
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      const sweep = registry.sweepTrackedBrowserTabs({
        now: 10_000,
        idleMs: 1,
        getResolvedBrowserConfig: async () => {
          entered.resolve();
          await release.promise;
          return resolved;
        },
      });
      try {
        await entered.promise;
        registry.touchSessionBrowserTab({ ...tab, now: 11_000 });
      } finally {
        release.resolve();
      }
      await expect(sweep).resolves.toBe(0);
      expect(closedTargets).toEqual([]);
      expect(getBrowserSessionTabStore().entries()).toHaveLength(1);
      expect(getBrowserSessionTabStore().entries()[0]?.value).not.toHaveProperty(
        "cleanupAttemptToken",
      );

      await expect(closeTrackedBrowserTabsForSessions({ sessionKeys: [sessionKey] })).resolves.toBe(
        1,
      );
      expect(closedTargets).toEqual(["owned"]);
      expect([...targets]).toEqual(["user"]);
      expect(getBrowserSessionTabStore().entries()).toEqual([]);
      await expect(closeTrackedBrowserTabsForSessions({ sessionKeys: [sessionKey] })).resolves.toBe(
        0,
      );
      expect(requests).toHaveLength(3);
      expect(closedTargets).toHaveLength(1);
    } finally {
      await registry.closeTrackedBrowserTabsForSessions({
        sessionKeys: [sessionKey],
        closeTab: async () => {},
      });
      resetPluginStateStoreForTests();
      for (const client of ws.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve) => {
        ws.close(() => resolve());
      });
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });
});
