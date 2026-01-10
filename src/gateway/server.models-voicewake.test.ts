import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  bridgeListConnected,
  bridgeSendEvent,
  bridgeStartCalls,
  connectOk,
  installGatewayTestHooks,
  onceMessage,
  piSdkMock,
  rpcReq,
  startServerWithClient,
} from "./test-helpers.js";

installGatewayTestHooks();

describe("gateway server models + voicewake", () => {
  const setTempHome = (homeDir: string) => {
    const prevHome = process.env.HOME;
    const prevStateDir = process.env.CLAWDBOT_STATE_DIR;
    const prevUserProfile = process.env.USERPROFILE;
    const prevHomeDrive = process.env.HOMEDRIVE;
    const prevHomePath = process.env.HOMEPATH;
    process.env.HOME = homeDir;
    process.env.CLAWDBOT_STATE_DIR = path.join(homeDir, ".clawdbot");
    process.env.USERPROFILE = homeDir;
    if (process.platform === "win32") {
      const parsed = path.parse(homeDir);
      process.env.HOMEDRIVE = parsed.root.replace(/\\$/, "");
      process.env.HOMEPATH = homeDir.slice(Math.max(parsed.root.length - 1, 0));
    }
    return () => {
      if (prevHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = prevHome;
      }
      if (prevStateDir === undefined) {
        delete process.env.CLAWDBOT_STATE_DIR;
      } else {
        process.env.CLAWDBOT_STATE_DIR = prevStateDir;
      }
      if (prevUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = prevUserProfile;
      }
      if (process.platform === "win32") {
        if (prevHomeDrive === undefined) {
          delete process.env.HOMEDRIVE;
        } else {
          process.env.HOMEDRIVE = prevHomeDrive;
        }
        if (prevHomePath === undefined) {
          delete process.env.HOMEPATH;
        } else {
          process.env.HOMEPATH = prevHomePath;
        }
      }
    };
  };

  test(
    "voicewake.get returns defaults and voicewake.set broadcasts",
    { timeout: 15_000 },
    async () => {
      const homeDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "clawdbot-home-"),
      );
      const restoreHome = setTempHome(homeDir);

      const { server, ws } = await startServerWithClient();
      await connectOk(ws);

      const initial = await rpcReq<{ triggers: string[] }>(ws, "voicewake.get");
      expect(initial.ok).toBe(true);
      expect(initial.payload?.triggers).toEqual([
        "clawd",
        "claude",
        "computer",
      ]);

      const changedP = onceMessage<{
        type: "event";
        event: string;
        payload?: unknown;
      }>(ws, (o) => o.type === "event" && o.event === "voicewake.changed");

      const setRes = await rpcReq<{ triggers: string[] }>(ws, "voicewake.set", {
        triggers: ["  hi  ", "", "there"],
      });
      expect(setRes.ok).toBe(true);
      expect(setRes.payload?.triggers).toEqual(["hi", "there"]);

      const changed = await changedP;
      expect(changed.event).toBe("voicewake.changed");
      expect(
        (changed.payload as { triggers?: unknown } | undefined)?.triggers,
      ).toEqual(["hi", "there"]);

      const after = await rpcReq<{ triggers: string[] }>(ws, "voicewake.get");
      expect(after.ok).toBe(true);
      expect(after.payload?.triggers).toEqual(["hi", "there"]);

      const onDisk = JSON.parse(
        await fs.readFile(
          path.join(homeDir, ".clawdbot", "settings", "voicewake.json"),
          "utf8",
        ),
      ) as { triggers?: unknown; updatedAtMs?: unknown };
      expect(onDisk.triggers).toEqual(["hi", "there"]);
      expect(typeof onDisk.updatedAtMs).toBe("number");

      ws.close();
      await server.close();

      restoreHome();
    },
  );

  test("pushes voicewake.changed to nodes on connect and on updates", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-home-"));
    const restoreHome = setTempHome(homeDir);

    bridgeSendEvent.mockClear();
    bridgeListConnected.mockReturnValue([{ nodeId: "n1" }]);

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const startCall = bridgeStartCalls.at(-1);
    expect(startCall).toBeTruthy();

    await startCall?.onAuthenticated?.({ nodeId: "n1" });

    const first = bridgeSendEvent.mock.calls.find(
      (c) => c[0]?.event === "voicewake.changed" && c[0]?.nodeId === "n1",
    )?.[0] as { payloadJSON?: string | null } | undefined;
    expect(first?.payloadJSON).toBeTruthy();
    const firstPayload = JSON.parse(String(first?.payloadJSON)) as {
      triggers?: unknown;
    };
    expect(firstPayload.triggers).toEqual(["clawd", "claude", "computer"]);

    bridgeSendEvent.mockClear();

    const setRes = await rpcReq<{ triggers: string[] }>(ws, "voicewake.set", {
      triggers: ["clawd", "computer"],
    });
    expect(setRes.ok).toBe(true);

    const broadcast = bridgeSendEvent.mock.calls.find(
      (c) => c[0]?.event === "voicewake.changed" && c[0]?.nodeId === "n1",
    )?.[0] as { payloadJSON?: string | null } | undefined;
    expect(broadcast?.payloadJSON).toBeTruthy();
    const broadcastPayload = JSON.parse(String(broadcast?.payloadJSON)) as {
      triggers?: unknown;
    };
    expect(broadcastPayload.triggers).toEqual(["clawd", "computer"]);

    ws.close();
    await server.close();

    restoreHome();
  });

  test("models.list returns model catalog", async () => {
    piSdkMock.enabled = true;
    piSdkMock.models = [
      { id: "gpt-test-z", provider: "openai", contextWindow: 0 },
      {
        id: "gpt-test-a",
        name: "A-Model",
        provider: "openai",
        contextWindow: 8000,
      },
      {
        id: "claude-test-b",
        name: "B-Model",
        provider: "anthropic",
        contextWindow: 1000,
      },
      {
        id: "claude-test-a",
        name: "A-Model",
        provider: "anthropic",
        contextWindow: 200_000,
      },
    ];

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const res1 = await rpcReq<{
      models: Array<{
        id: string;
        name: string;
        provider: string;
        contextWindow?: number;
      }>;
    }>(ws, "models.list");

    const res2 = await rpcReq<{
      models: Array<{
        id: string;
        name: string;
        provider: string;
        contextWindow?: number;
      }>;
    }>(ws, "models.list");

    expect(res1.ok).toBe(true);
    expect(res2.ok).toBe(true);

    const models = res1.payload?.models ?? [];
    expect(models).toEqual([
      {
        id: "claude-test-a",
        name: "A-Model",
        provider: "anthropic",
        contextWindow: 200_000,
      },
      {
        id: "claude-test-b",
        name: "B-Model",
        provider: "anthropic",
        contextWindow: 1000,
      },
      {
        id: "gpt-test-a",
        name: "A-Model",
        provider: "openai",
        contextWindow: 8000,
      },
      {
        id: "gpt-test-z",
        name: "gpt-test-z",
        provider: "openai",
      },
    ]);

    expect(piSdkMock.discoverCalls).toBe(1);

    ws.close();
    await server.close();
  });

  test("models.list rejects unknown params", async () => {
    piSdkMock.enabled = true;
    piSdkMock.models = [{ id: "gpt-test-a", name: "A", provider: "openai" }];

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const res = await rpcReq(ws, "models.list", { extra: true });
    expect(res.ok).toBe(false);
    expect(res.error?.message ?? "").toMatch(/invalid models\.list params/i);

    ws.close();
    await server.close();
  });

  test("bridge RPC supports models.list and validates params", async () => {
    piSdkMock.enabled = true;
    piSdkMock.models = [{ id: "gpt-test-a", name: "A", provider: "openai" }];

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const startCall = bridgeStartCalls.at(-1);
    expect(startCall).toBeTruthy();

    const okRes = await startCall?.onRequest?.("n1", {
      id: "1",
      method: "models.list",
      paramsJSON: "{}",
    });
    expect(okRes?.ok).toBe(true);
    const okPayload = JSON.parse(String(okRes?.payloadJSON ?? "{}")) as {
      models?: unknown;
    };
    expect(Array.isArray(okPayload.models)).toBe(true);

    const badRes = await startCall?.onRequest?.("n1", {
      id: "2",
      method: "models.list",
      paramsJSON: JSON.stringify({ extra: true }),
    });
    expect(badRes?.ok).toBe(false);
    expect(badRes && "error" in badRes ? badRes.error.code : "").toBe(
      "INVALID_REQUEST",
    );

    ws.close();
    await server.close();
  });
});
