// Fan-out hook dispatch tests protect the batched-producer contract: every
// pushed item ends in its own dispatch, retries replay instead of duplicating,
// and gmail-path bodies are bounded by the provisioned producer contract.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveHookMappings } from "../hooks-mapping.js";
import { createHooksConfig } from "../hooks-test-helpers.js";
import type { HookAgentDispatchPayload, HooksConfigResolved } from "../hooks.js";
import { createHookRequest, createResponse } from "../server-http.test-harness.js";
import {
  createHooksRequestHandler,
  type HookAgentDispatchResult,
} from "./hooks-request-handler.js";

const { readJsonBodyMock } = vi.hoisted(() => ({
  readJsonBodyMock: vi.fn(),
}));

vi.mock("../hooks.js", async () => {
  const actual = await vi.importActual<typeof import("../hooks.js")>("../hooks.js");
  return {
    ...actual,
    readJsonBody: readJsonBodyMock,
  };
});

function createGmailHooksConfig(): HooksConfigResolved {
  const canonical = createHooksConfig();
  return {
    ...canonical,
    mappings: resolveHookMappings({
      presets: ["gmail"],
      allowRequestSessionKey: true,
      allowedSessionKeyPrefixes: ["hook:gmail:"],
    }),
    sessionPolicy: {
      ...canonical.sessionPolicy,
      allowRequestSessionKey: true,
      allowedSessionKeyPrefixes: ["hook:gmail:"],
    },
  };
}

function createFanOutHandler(params?: {
  dispatchWakeHook?: Parameters<typeof createHooksRequestHandler>[0]["dispatchWakeHook"];
  dispatchAgentHook?: (
    value: HookAgentDispatchPayload,
  ) => HookAgentDispatchResult | Promise<HookAgentDispatchResult>;
  hooksConfig?: HooksConfigResolved;
  fanoutResponseDeadlineMs?: number;
}) {
  const dispatchWakeHook = vi.fn(
    params?.dispatchWakeHook ?? (() => ({ eventOutcome: "queued" as const })),
  );
  const dispatchAgentHook = vi.fn(
    params?.dispatchAgentHook ??
      ((value: HookAgentDispatchPayload) => ({
        ok: true as const,
        runId: `run:${value.sessionKey}`,
      })),
  );
  const logHooks = {
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  } as unknown as ReturnType<typeof createSubsystemLogger>;
  const hooksConfig = params?.hooksConfig ?? createGmailHooksConfig();
  const handler = createHooksRequestHandler({
    getHooksConfig: () => hooksConfig,
    bindHost: "127.0.0.1",
    port: 18789,
    logHooks,
    dispatchWakeHook,
    dispatchAgentHook,
    ...(params?.fanoutResponseDeadlineMs !== undefined
      ? { fanoutResponseDeadlineMs: params.fanoutResponseDeadlineMs }
      : {}),
  });
  return { handler, dispatchAgentHook, dispatchWakeHook, logHooks };
}

async function postGmailPayload(
  handler: ReturnType<typeof createHooksRequestHandler>,
  payload: Record<string, unknown>,
) {
  readJsonBodyMock.mockResolvedValueOnce({ ok: true, value: payload });
  const req = createHookRequest({ url: "/hooks/gmail" });
  const response = createResponse();
  await handler(req, response.res);
  return response;
}

function gmailMessage(id: string) {
  return { id, from: `${id}@example.com`, subject: `Subject ${id}`, snippet: "s", body: "b" };
}

describe("hook fan-out dispatch", () => {
  beforeEach(() => {
    readJsonBodyMock.mockReset();
  });

  test("dispatches one isolated run per batched gmail message", async () => {
    const { handler, dispatchAgentHook } = createFanOutHandler();

    const response = await postGmailPayload(handler, {
      source: "gmail",
      messages: [gmailMessage("m1"), gmailMessage("m2"), gmailMessage("m3")],
    });

    expect(response.res.statusCode).toBe(200);
    expect(dispatchAgentHook).toHaveBeenCalledTimes(3);
    const sessionKeys = dispatchAgentHook.mock.calls.map((call) => call[0].sessionKey);
    expect(sessionKeys).toEqual(["hook:gmail:m1", "hook:gmail:m2", "hook:gmail:m3"]);
    for (const [index, id] of ["m1", "m2", "m3"].entries()) {
      const value = dispatchAgentHook.mock.calls[index]?.[0];
      expect(value?.message).toContain(`${id}@example.com`);
      expect(value?.message).toContain(`Subject ${id}`);
      expect(value?.externalContentSource).toBe("gmail");
    }
    const body = JSON.parse(response.getBody()) as { runIds?: string[]; dispatched?: number };
    expect(body.runIds).toHaveLength(3);
    expect(body.dispatched).toBe(3);
  });

  test("single-message batches keep the single-dispatch response shape", async () => {
    const { handler, dispatchAgentHook } = createFanOutHandler();

    const response = await postGmailPayload(handler, { messages: [gmailMessage("solo")] });

    expect(response.res.statusCode).toBe(200);
    expect(dispatchAgentHook).toHaveBeenCalledTimes(1);
    expect(JSON.parse(response.getBody())).toEqual({ ok: true, runId: "run:hook:gmail:solo" });
  });

  test("empty batches record a no-op instead of dispatching a junk run", async () => {
    const { handler, dispatchAgentHook } = createFanOutHandler();

    const response = await postGmailPayload(handler, { messages: [] });

    expect(response.res.statusCode).toBe(204);
    expect(dispatchAgentHook).not.toHaveBeenCalled();
  });

  test("partial failure returns non-2xx and a retry replays instead of duplicating", async () => {
    let failM2 = true;
    const { handler, dispatchAgentHook } = createFanOutHandler({
      dispatchAgentHook: (value) => {
        if (failM2 && value.sessionKey === "hook:gmail:m2") {
          return { ok: false as const, statusCode: 502 as const, error: "admission failed" };
        }
        return { ok: true as const, runId: `run:${value.sessionKey}` };
      },
    });
    const payload = { messages: [gmailMessage("m1"), gmailMessage("m2"), gmailMessage("m3")] };

    const firstResponse = await postGmailPayload(handler, payload);
    expect(firstResponse.res.statusCode).toBe(502);
    const firstBody = JSON.parse(firstResponse.getBody()) as { ok: boolean; runIds?: string[] };
    expect(firstBody.ok).toBe(false);
    expect(firstBody.runIds).toEqual(["run:hook:gmail:m1", "run:hook:gmail:m3"]);
    expect(dispatchAgentHook).toHaveBeenCalledTimes(3);

    // The producer redelivers the identical batch after the failure.
    failM2 = false;
    const retryResponse = await postGmailPayload(handler, payload);
    expect(retryResponse.res.statusCode).toBe(200);
    const retryBody = JSON.parse(retryResponse.getBody()) as { runIds?: string[] };
    expect(retryBody.runIds).toHaveLength(3);
    // Only the failed item is re-dispatched; m1/m3 replay from the cache.
    expect(dispatchAgentHook).toHaveBeenCalledTimes(4);
    expect(dispatchAgentHook.mock.calls[3]?.[0]?.sessionKey).toBe("hook:gmail:m2");
  });

  test("answers before the producer client timeout when an item admission hangs", async () => {
    let releaseHang!: (result: HookAgentDispatchResult) => void;
    const hang = new Promise<HookAgentDispatchResult>((resolve) => {
      releaseHang = resolve;
    });
    const { handler, dispatchAgentHook } = createFanOutHandler({
      fanoutResponseDeadlineMs: 50,
      dispatchAgentHook: (value) =>
        value.sessionKey === "hook:gmail:slow"
          ? hang
          : { ok: true as const, runId: `run:${value.sessionKey}` },
    });
    const payload = { messages: [gmailMessage("fast"), gmailMessage("slow")] };

    const response = await postGmailPayload(handler, payload);
    expect(response.res.statusCode).toBe(503);
    const body = JSON.parse(response.getBody()) as { error?: string; runIds?: string[] };
    expect(body.error).toContain("pending");
    expect(body.runIds).toEqual(["run:hook:gmail:fast"]);

    // The pending admission settles in the background; the redelivered batch
    // replays both items without a duplicate dispatch.
    releaseHang({ ok: true, runId: "run:hook:gmail:slow" });
    const retryResponse = await postGmailPayload(handler, payload);
    expect(retryResponse.res.statusCode).toBe(200);
    expect(dispatchAgentHook).toHaveBeenCalledTimes(2);
  });

  test("dispatches identical items separately and replays each on redelivery", async () => {
    // Two batch elements can render byte-identical actions (generic payloads;
    // impossible for gmail ids). Both must run, and a redelivery must replay
    // both instead of dispatching a third run.
    let runSeq = 0;
    const { handler, dispatchAgentHook } = createFanOutHandler({
      dispatchAgentHook: () => ({ ok: true as const, runId: `run-${runSeq++}` }),
    });
    const payload = { messages: [gmailMessage("twin"), gmailMessage("twin")] };

    const response = await postGmailPayload(handler, payload);
    expect(response.res.statusCode).toBe(200);
    const body = JSON.parse(response.getBody()) as { runIds?: string[] };
    expect(body.runIds).toEqual(["run-0", "run-1"]);
    expect(dispatchAgentHook).toHaveBeenCalledTimes(2);

    const retry = await postGmailPayload(handler, payload);
    expect(JSON.parse(retry.getBody())).toMatchObject({ runIds: ["run-0", "run-1"] });
    expect(dispatchAgentHook).toHaveBeenCalledTimes(2);
  });

  test("bounds fan-out and records the dropped tail", async () => {
    const { handler, dispatchAgentHook, logHooks } = createFanOutHandler();
    const messages = Array.from({ length: 205 }, (_, index) => gmailMessage(`m${index}`));

    const response = await postGmailPayload(handler, { messages });

    expect(response.res.statusCode).toBe(200);
    expect(dispatchAgentHook).toHaveBeenCalledTimes(200);
    expect(logHooks.warn).toHaveBeenCalledWith(expect.stringContaining("dropped 5 items"));
  });

  test("mixed per-item transform kinds dispatch both wakes and agents", async () => {
    const transformsDir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-fanout-transform-"));
    try {
      fs.mkdirSync(path.join(transformsDir, "hooks", "transforms"), { recursive: true });
      fs.writeFileSync(
        path.join(transformsDir, "hooks", "transforms", "mixed.mjs"),
        [
          'export default (ctx) => ctx.payload.messages[0].kind === "wake"',
          ' ? { kind: "wake", text: `wake:${ctx.payload.messages[0].id}` }',
          ' : ctx.payload.messages[0].kind === "invalid-agent"',
          '   ? { channel: "missing-channel" }',
          "   : {};",
        ].join(""),
      );
      const canonical = createHooksConfig();
      const hooksConfig: HooksConfigResolved = {
        ...canonical,
        mappings: resolveHookMappings(
          {
            mappings: [
              {
                id: "mixed",
                match: { path: "gmail" },
                action: "agent",
                forEach: "messages",
                sessionKey: "hook:gmail:{{messages[0].id}}",
                messageTemplate: "agent:{{messages[0].id}}",
                transform: { module: "mixed.mjs" },
              },
            ],
            allowRequestSessionKey: true,
            allowedSessionKeyPrefixes: ["hook:gmail:"],
          },
          { configDir: transformsDir },
        ),
        sessionPolicy: {
          ...canonical.sessionPolicy,
          allowRequestSessionKey: true,
          allowedSessionKeyPrefixes: ["hook:gmail:"],
        },
      };
      let coalesceWakes = false;
      const { handler, dispatchAgentHook, dispatchWakeHook } = createFanOutHandler({
        hooksConfig,
        dispatchWakeHook: (value) => ({
          eventOutcome: coalesceWakes || value.text === "wake:w1" ? "coalesced" : "queued",
        }),
      });

      const response = await postGmailPayload(handler, {
        messages: [
          { id: "w1", kind: "wake" },
          { id: "w2", kind: "wake" },
          { id: "a1", kind: "agent" },
        ],
      });

      expect(response.res.statusCode).toBe(200);
      expect(JSON.parse(response.getBody())).toMatchObject({ eventOutcome: "queued" });
      expect(dispatchWakeHook).toHaveBeenCalledTimes(2);
      expect(dispatchWakeHook.mock.calls[0]?.[0]).toMatchObject({ text: "wake:w1" });
      expect(dispatchAgentHook).toHaveBeenCalledTimes(1);
      expect(dispatchAgentHook.mock.calls[0]?.[0]).toMatchObject({
        message: "agent:a1",
        sessionKey: "hook:gmail:a1",
      });

      coalesceWakes = true;
      const replay = await postGmailPayload(handler, {
        messages: [
          { id: "w1", kind: "wake" },
          { id: "w2", kind: "wake" },
          { id: "a1", kind: "agent" },
        ],
      });
      expect(JSON.parse(replay.getBody())).toMatchObject({ eventOutcome: "coalesced" });
      expect(dispatchWakeHook).toHaveBeenCalledTimes(4);
      expect(dispatchAgentHook).toHaveBeenCalledTimes(1);

      coalesceWakes = false;
      const invalid = await postGmailPayload(handler, {
        messages: [
          { id: "w3", kind: "wake" },
          { id: "a2", kind: "invalid-agent" },
        ],
      });
      expect(invalid.res.statusCode).toBe(400);
      expect(JSON.parse(invalid.getBody())).toMatchObject({
        ok: false,
        eventOutcome: "queued",
      });
      expect(dispatchWakeHook).toHaveBeenCalledTimes(5);
      expect(dispatchAgentHook).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(transformsDir, { recursive: true, force: true });
    }
  });

  test("derives the gmail body bound from the provisioned producer contract", async () => {
    const { resolveHooksConfig } =
      await vi.importActual<typeof import("../hooks.js")>("../hooks.js");
    const baseHooks = {
      enabled: true,
      token: "hook-secret",
      presets: ["gmail"],
      defaultSessionKey: "hook:gmail:ingress",
      allowRequestSessionKey: true,
      allowedSessionKeyPrefixes: ["hook:gmail:"],
    };
    const resolved = resolveHooksConfig({ hooks: baseHooks } as never);
    // 100 messages x (20000-byte bodies x3 escaping headroom + 8KiB metadata).
    expect(resolved?.maxBodyBytesByPath.get("gmail")).toBe(6_819_200);

    const larger = resolveHooksConfig({
      hooks: { ...baseHooks, gmail: { maxBytes: 50_000 } },
    } as never);
    expect(larger?.maxBodyBytesByPath.get("gmail")).toBe(100 * (50_000 * 3 + 8_192));

    // Operator-controlled maxBytes must not amplify into an unbounded
    // in-memory request allowance.
    const huge = resolveHooksConfig({
      hooks: { ...baseHooks, gmail: { maxBytes: 1_048_576 } },
    } as never);
    expect(huge?.maxBodyBytesByPath.get("gmail")).toBe(32 * 1024 * 1024);
  });

  test("reads gmail-path bodies with the producer-derived bound", async () => {
    const canonical = createHooksConfig();
    const gmailConfig = createGmailHooksConfig();
    const { handler } = createFanOutHandler({
      hooksConfig: {
        ...gmailConfig,
        maxBodyBytes: canonical.maxBodyBytes,
        maxBodyBytesByPath: new Map([["gmail", 6_819_200]]),
      },
    });

    await postGmailPayload(handler, { messages: [] });
    expect(readJsonBodyMock).toHaveBeenLastCalledWith(expect.anything(), 6_819_200);

    readJsonBodyMock.mockResolvedValueOnce({ ok: true, value: { message: "direct" } });
    const req = createHookRequest({ url: "/hooks/agent" });
    const response = createResponse();
    await handler(req, response.res);
    expect(readJsonBodyMock).toHaveBeenLastCalledWith(expect.anything(), canonical.maxBodyBytes);
  });
});
