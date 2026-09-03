import fs from "node:fs/promises";
import path from "node:path";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, expect, it } from "vitest";
import { WebSocket } from "ws";
import { relayTestKey } from "../../../chrome-extension/relay-key.test-support.js";
import {
  createBrowserControlContext,
  getBrowserControlState,
  startBrowserControlServiceFromConfig,
  stopBrowserControlService,
} from "../../control-service.js";
import { resolveBrowserConfig, resolveProfile } from "../config.js";
import { runExtensionRelayDaemon } from "../relay-daemon.js";
import { captureBrowserOperationTarget } from "../routes/agent.snapshot-target.js";
import type { BrowserServerState } from "../server-context.types.js";
import { getFreePort } from "../test-port.js";
import { RelayOwnerClient } from "./owner-client.js";
import {
  externalRelayClient,
  externalVersion,
  withConnectedDaemon,
} from "./relay-coexistence.test-support.js";
import { ensureExtensionRelayForProfile, stopExtensionRelays } from "./relay-lifecycle.js";

afterEach(async () => {
  await stopBrowserControlService();
  clearRuntimeConfigSnapshot();
});

it("uses a daemon-owned relay without replacing its listener or closing its extension", async () => {
  await withConnectedDaemon(async ({ port, token, extension }) => {
    const external = await externalRelayClient(port, token);
    try {
      for (const mismatch of [
        { port, profile: "wrong-profile", token },
        { port, profile: "chrome", token: relayTestKey(10) },
      ]) {
        await expect(
          RelayOwnerClient.connect({ ...mismatch, signal: new AbortController().signal }),
        ).rejects.toThrow();
      }
      await startBrowserControlServiceFromConfig();
      await expect(
        createBrowserControlContext().forProfile("chrome").ensureBrowserAvailable(),
      ).resolves.toBeUndefined();
      const tabs = await createBrowserControlContext().forProfile("chrome").listTabs();
      expect(tabs).toEqual([
        expect.objectContaining({
          targetId: "fixture-target",
          url: "https://example.com/fixture",
        }),
      ]);
      await stopBrowserControlService();
      await expect(externalVersion(external)).resolves.toMatchObject({
        result: { product: "Chrome/test" },
      });
      expect(extension.readyState).toBe(WebSocket.OPEN);
      // A second daemon must still see the original listener, not a free port.
      const contender = await runExtensionRelayDaemon({ port });
      await expect(contender.done).resolves.toBe("port-in-use");
    } finally {
      external.terminate();
    }
  });
});

it("keeps remote captures on the exact grant across renderer attachment, then revokes them", async () => {
  await withConnectedDaemon(async ({ port, token, extension, setTarget, sendTabs }) => {
    const client = await RelayOwnerClient.connect({
      port,
      profile: "chrome",
      token,
      signal: new AbortController().signal,
    });
    try {
      await startBrowserControlServiceFromConfig();
      await createBrowserControlContext().forProfile("chrome").listTabs();
      const reference = await client.capture("fixture-target");
      await expect(reference.resolve()).resolves.toBe("fixture-target");
      setTarget("replacement-target");
      extension.send(JSON.stringify({ type: "detached", tabId: 1, reason: "target_closed" }));
      await expect.poll(() => reference.resolve()).toBeUndefined();
      const transport = await reference.openTransport();
      transport.send({
        id: 1,
        method: "Target.setAutoAttach",
        params: { autoAttach: true, flatten: true },
      });
      await expect.poll(() => reference.resolve()).toBe("replacement-target");
      let closed = false;
      Object.assign(transport, {
        onclose: () => {
          closed = true;
        },
      });
      sendTabs(false);
      await expect.poll(() => reference.resolve()).toBeUndefined();
      sendTabs(true);
      // Even an identical native ID is a new TabState after revoke/regrant.
      await expect(reference.openTransport()).rejects.toThrow();
      transport.send({ id: 1, method: "Target.getTargets" });
      await expect.poll(() => closed).toBe(true);
      await reference.release();
      await expect(reference.resolve()).rejects.toThrow();
    } finally {
      await client.close();
    }
  });
});

it("coalesces real borrowed acquisitions while independently cancelling one caller", async () => {
  await withConnectedDaemon(async ({ port }) => {
    const resolved = resolveBrowserConfig({
      profiles: { chrome: { driver: "extension", cdpPort: port } },
    });
    const state: BrowserServerState = { server: null, port: 0, resolved, profiles: new Map() };
    const profile = resolveProfile(resolved, "chrome");
    if (!profile) {
      throw new Error("Missing fixture profile");
    }
    const controller = new AbortController();
    const first = ensureExtensionRelayForProfile(state, profile, controller.signal);
    const cancelled = expect(first).rejects.toThrow("caller cancelled");
    const siblings = Array.from({ length: 4 }, () =>
      ensureExtensionRelayForProfile(state, profile),
    );
    controller.abort(new Error("caller cancelled"));
    try {
      await cancelled;
      const handles = await Promise.all(siblings);
      expect(handles.every((handle) => handle === handles[0])).toBe(true);
      expect(handles[0]?.ownership).toBe("borrowed");
      expect(state.extensionRelays?.size).toBe(1);
    } finally {
      await stopExtensionRelays(state);
    }
  });
});

it.each(["port", "name"] as const)(
  "retires borrowed access on configured profile %s drift without stopping the old daemon",
  async (change) => {
    await withConnectedDaemon(async ({ port, token }) => {
      const external = await externalRelayClient(port, token);
      try {
        await startBrowserControlServiceFromConfig();
        const oldProfile = createBrowserControlContext().forProfile("chrome");
        const oldRelay = getBrowserControlState()?.extensionRelays?.get("chrome");
        const replacementPort = change === "port" ? await getFreePort() : port;
        const replacementName = change === "name" ? "other-profile" : "chrome";
        const config = {
          browser: {
            profiles: {
              [replacementName]: { driver: "extension" as const, cdpPort: replacementPort },
            },
          },
        };
        setRuntimeConfigSnapshot(config, config);
        const current = createBrowserControlContext().forProfile(replacementName);
        expect(current.profile.cdpPort).toBe(replacementPort);
        await expect(oldProfile.isTransportAvailable()).rejects.toThrow();
        await expect
          .poll(() => getBrowserControlState()?.extensionRelays?.get("chrome") !== oldRelay)
          .toBe(true);
        await expect(externalVersion(external)).resolves.toMatchObject({
          result: { product: "Chrome/test" },
        });
      } finally {
        external.terminate();
      }
    });
  },
);

it("releases its old lease on key drift and refuses to reconfigure the daemon owner", async () => {
  await withConnectedDaemon(async ({ stateDir }) => {
    await startBrowserControlServiceFromConfig();
    const profile = createBrowserControlContext().forProfile("chrome");
    await fs.writeFile(
      path.join(stateDir, "credentials", "browser-extension-relay.secret"),
      relayTestKey(14),
    );
    await expect(profile.ensureBrowserAvailable()).rejects.toThrow();
    expect(getBrowserControlState()?.extensionRelays?.size).toBe(0);
  });
});

it("waits for the actual native detach acknowledgement before borrowed cleanup completes", async () => {
  await withConnectedDaemon(async ({ port, token, holdDetach }) => {
    const external = await externalRelayClient(port, token);
    const hold = holdDetach();
    try {
      await startBrowserControlServiceFromConfig();
      await createBrowserControlContext().forProfile("chrome").listTabs();
      let completed = false;
      const stopping = stopBrowserControlService();
      void stopping.then(
        () => {
          completed = true;
        },
        () => {
          completed = true;
        },
      );
      await hold.entered;
      expect(completed).toBe(false);
      await expect(externalVersion(external)).resolves.toMatchObject({
        result: { product: "Chrome/test" },
      });
      hold.release();
      await stopping;
      expect(completed).toBe(true);
    } finally {
      hold.release();
      external.terminate();
    }
  });
});

it("reacquires a retired daemon owner without reusing its captured references", async () => {
  await withConnectedDaemon(async ({ restartDaemon }) => {
    const state = await startBrowserControlServiceFromConfig();
    if (!state) {
      throw new Error("Expected browser runtime");
    }
    const profile = createBrowserControlContext().forProfile("chrome");
    await profile.listTabs();
    const original = state.extensionRelays?.get("chrome");
    if (original?.ownership !== "borrowed") {
      throw new Error("Expected borrowed relay");
    }
    const reference = await original.client.capture("fixture-target");
    await restartDaemon();
    const replacement = await ensureExtensionRelayForProfile(state, profile.profile);
    expect(replacement).not.toBe(original);
    expect(replacement.ownership).toBe("borrowed");
    await expect(reference.resolve()).rejects.toThrow();
  });
});

it("fences a captured operation when profile stop advances the generation but retains the relay", async () => {
  await withConnectedDaemon(async () => {
    await startBrowserControlServiceFromConfig();
    const ctx = createBrowserControlContext();
    const profile = ctx.forProfile("chrome");
    await profile.listTabs();
    const original = ctx.state().extensionRelays?.get("chrome");
    const captured = await captureBrowserOperationTarget({
      ctx,
      profileName: "chrome",
      targetId: "fixture-target",
    });
    const transport = await captured?.reference?.openTransport();
    const resolving = Promise.resolve(captured?.()).catch(() => undefined);
    await profile.stopRunningBrowser();
    expect(ctx.state().extensionRelays?.get("chrome")).toBe(original);
    try {
      await expect(resolving).resolves.toBeUndefined();
      expect(() => transport?.send({ id: 1, method: "Browser.getVersion" })).toThrow();
      await expect(captured?.reference?.openTransport()).rejects.toThrow();
    } finally {
      await captured?.release();
    }
  });
});

it("reports an explicit stricter policy conflict without reconfiguring the existing owner", async () => {
  await withConnectedDaemon(
    async ({ port, token }) => {
      const resolved = resolveBrowserConfig({
        extensionRelay: { allowLegacyAuth: false },
        profiles: { chrome: { driver: "extension", cdpPort: port } },
      });
      const state: BrowserServerState = { server: null, port: 0, resolved, profiles: new Map() };
      const profile = resolveProfile(resolved, "chrome");
      if (!profile) {
        throw new Error("Missing fixture profile");
      }
      const external = await externalRelayClient(port, token);
      try {
        await expect(ensureExtensionRelayForProfile(state, profile)).rejects.toThrow(
          "Existing relay permits legacy authentication",
        );
        expect(state.extensionRelays?.size).toBe(0);
        await expect(externalVersion(external)).resolves.toMatchObject({
          result: { product: "Chrome/test" },
        });
      } finally {
        external.terminate();
        await stopExtensionRelays(state);
      }
    },
    async (port) => await runExtensionRelayDaemon({ port, allowLegacyAuth: true }),
  );
});
