import { describe, expect, it } from "vitest";

import { resolveConfigSnapshotHash } from "../config/config.js";

import {
  connectOk,
  installGatewayTestHooks,
  onceMessage,
  startServerWithClient,
} from "./test-helpers.js";

installGatewayTestHooks();

describe("gateway config.patch", () => {
  it("merges patches without clobbering unrelated config", async () => {
    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const setId = "req-set";
    ws.send(
      JSON.stringify({
        type: "req",
        id: setId,
        method: "config.set",
        params: {
          raw: JSON.stringify({
            gateway: { mode: "local" },
            channels: { telegram: { botToken: "token-1" } },
          }),
        },
      }),
    );
    const setRes = await onceMessage<{ ok: boolean }>(
      ws,
      (o) => o.type === "res" && o.id === setId,
    );
    expect(setRes.ok).toBe(true);

    const getId = "req-get";
    ws.send(
      JSON.stringify({
        type: "req",
        id: getId,
        method: "config.get",
        params: {},
      }),
    );
    const getRes = await onceMessage<{ ok: boolean; payload?: { hash?: string; raw?: string } }>(
      ws,
      (o) => o.type === "res" && o.id === getId,
    );
    expect(getRes.ok).toBe(true);
    const baseHash = resolveConfigSnapshotHash({
      hash: getRes.payload?.hash,
      raw: getRes.payload?.raw,
    });
    expect(typeof baseHash).toBe("string");

    const patchId = "req-patch";
    ws.send(
      JSON.stringify({
        type: "req",
        id: patchId,
        method: "config.patch",
        params: {
          raw: JSON.stringify({
            channels: {
              telegram: {
                groups: {
                  "*": { requireMention: false },
                },
              },
            },
          }),
          baseHash,
        },
      }),
    );
    const patchRes = await onceMessage<{ ok: boolean }>(
      ws,
      (o) => o.type === "res" && o.id === patchId,
    );
    expect(patchRes.ok).toBe(true);

    const get2Id = "req-get-2";
    ws.send(
      JSON.stringify({
        type: "req",
        id: get2Id,
        method: "config.get",
        params: {},
      }),
    );
    const get2Res = await onceMessage<{
      ok: boolean;
      payload?: {
        config?: { gateway?: { mode?: string }; channels?: { telegram?: { botToken?: string } } };
      };
    }>(ws, (o) => o.type === "res" && o.id === get2Id);
    expect(get2Res.ok).toBe(true);
    expect(get2Res.payload?.config?.gateway?.mode).toBe("local");
    expect(get2Res.payload?.config?.channels?.telegram?.botToken).toBe("token-1");

    ws.close();
    await server.close();
  });

  it("requires base hash when config exists", async () => {
    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const setId = "req-set-2";
    ws.send(
      JSON.stringify({
        type: "req",
        id: setId,
        method: "config.set",
        params: {
          raw: JSON.stringify({
            gateway: { mode: "local" },
          }),
        },
      }),
    );
    const setRes = await onceMessage<{ ok: boolean }>(
      ws,
      (o) => o.type === "res" && o.id === setId,
    );
    expect(setRes.ok).toBe(true);

    const patchId = "req-patch-2";
    ws.send(
      JSON.stringify({
        type: "req",
        id: patchId,
        method: "config.patch",
        params: {
          raw: JSON.stringify({ gateway: { mode: "remote" } }),
        },
      }),
    );
    const patchRes = await onceMessage<{ ok: boolean; error?: { message?: string } }>(
      ws,
      (o) => o.type === "res" && o.id === patchId,
    );
    expect(patchRes.ok).toBe(false);
    expect(patchRes.error?.message).toContain("base hash");

    ws.close();
    await server.close();
  });

  it("requires base hash for config.set when config exists", async () => {
    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const setId = "req-set-3";
    ws.send(
      JSON.stringify({
        type: "req",
        id: setId,
        method: "config.set",
        params: {
          raw: JSON.stringify({
            gateway: { mode: "local" },
          }),
        },
      }),
    );
    const setRes = await onceMessage<{ ok: boolean }>(
      ws,
      (o) => o.type === "res" && o.id === setId,
    );
    expect(setRes.ok).toBe(true);

    const set2Id = "req-set-4";
    ws.send(
      JSON.stringify({
        type: "req",
        id: set2Id,
        method: "config.set",
        params: {
          raw: JSON.stringify({
            gateway: { mode: "remote" },
          }),
        },
      }),
    );
    const set2Res = await onceMessage<{ ok: boolean; error?: { message?: string } }>(
      ws,
      (o) => o.type === "res" && o.id === set2Id,
    );
    expect(set2Res.ok).toBe(false);
    expect(set2Res.error?.message).toContain("base hash");

    ws.close();
    await server.close();
  });
});
