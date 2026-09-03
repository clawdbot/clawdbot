import { afterEach, describe, expect, it, vi } from "vitest";
import { SESSION_CREATE_IDEMPOTENCY_RETENTION_MS } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { DEDUPE_MAX } from "../server-constants.js";
import { idempotentSessionCreate } from "./session-create-idempotency.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandler,
  GatewayRequestHandlerOptions,
  RespondFn,
} from "./types.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function createFixture(handler?: GatewayRequestHandler) {
  const context = { dedupe: new Map() } as GatewayRequestContext;
  const execute = vi.fn<GatewayRequestHandler>(
    handler ??
      ((request) => {
        request.respond(true, { key: `agent:main:${String(request.params.idempotencyKey)}` });
      }),
  );
  const wrapped = idempotentSessionCreate(execute);
  const client = {
    authenticatedUserId: "owner",
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "test", version: "1", platform: "test", mode: "test" },
      device: {
        id: "device",
        publicKey: "key",
        signature: "signature",
        signedAt: 1,
        nonce: "nonce",
      },
      role: "operator",
      scopes: ["operator.admin", "operator.write"],
    },
  } satisfies NonNullable<GatewayRequestHandlerOptions["client"]>;

  function invoke(
    params: Record<string, unknown> = { agentId: "main", idempotencyKey: "create-once" },
    connection: typeof client = client,
  ) {
    const respond = vi.fn<RespondFn>();
    const request: GatewayRequestHandlerOptions = {
      req: { type: "req", id: "1", method: "sessions.create" },
      params,
      client: connection,
      context,
      respond,
      isWebchatConnect: () => false,
    };
    return { done: Promise.resolve(wrapped(request)), respond };
  }

  return { client, context, execute, invoke };
}

describe("sessions.create process-lifetime idempotency", () => {
  it("replays reordered requests and added authorization without accepting downgraded scopes", async () => {
    const { client, context, execute, invoke } = createFixture();
    const first = invoke({ agentId: "main", idempotencyKey: "create-once", message: "hello" });
    await first.done;
    context.dedupe.clear();

    const added = invoke(
      { message: "hello", idempotencyKey: "create-once", agentId: "main" },
      {
        ...client,
        connect: {
          ...client.connect,
          scopes: ["operator.write", "operator.read", "operator.admin"],
        },
      },
    );
    await added.done;
    expect(execute).toHaveBeenCalledOnce();
    expect(added.respond).toHaveBeenCalledWith(true, { key: "agent:main:create-once" }, undefined, {
      cached: true,
    });

    const downgraded = invoke(
      { agentId: "main", idempotencyKey: "create-once", message: "hello" },
      { ...client, connect: { ...client.connect, scopes: ["operator.write"] } },
    );
    await downgraded.done;
    expect(downgraded.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "FORBIDDEN", message: "missing scope: operator.admin" }),
    );
    expect(execute).toHaveBeenCalledOnce();

    const changedRole = invoke(
      { agentId: "main", idempotencyKey: "create-once", message: "hello" },
      { ...client, connect: { ...client.connect, role: "node" } },
    );
    await changedRole.done;
    expect(changedRole.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
    expect(execute).toHaveBeenCalledOnce();

    const conflict = invoke({
      agentId: "main",
      idempotencyKey: "create-once",
      message: "different",
    });
    await conflict.done;
    expect(conflict.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(execute).toHaveBeenCalledOnce();

    const differentDevice = invoke(
      { agentId: "main", idempotencyKey: "create-once", message: "hello" },
      {
        ...client,
        connect: {
          ...client.connect,
          device: { ...client.connect.device, id: "other-device" },
        },
      },
    );
    await differentDevice.done;
    expect(differentDevice.respond).toHaveBeenCalledWith(
      true,
      { key: "agent:main:create-once" },
      undefined,
      { cached: true },
    );
    expect(execute).toHaveBeenCalledOnce();
  });

  it("rejects idempotent creation without a principal or device namespace", async () => {
    const { execute, invoke } = createFixture();
    const anonymous = invoke({ agentId: "main", idempotencyKey: "create-once" }, null as never);

    await anonymous.done;

    expect(anonymous.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("identity"),
      }),
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("pins in-flight request identity beyond retention and independent of global dedupe pruning", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const release = createDeferredCore();
    const { context, execute, invoke } = createFixture(async (request) => {
      await release.promise;
      request.respond(true, { key: "agent:main:finished" });
    });
    const original = invoke({ agentId: "main", idempotencyKey: "long-create", message: "hello" });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    now += SESSION_CREATE_IDEMPOTENCY_RETENTION_MS + 1;
    context.dedupe.clear();

    const conflicting = invoke({
      agentId: "main",
      idempotencyKey: "long-create",
      message: "different",
    });
    await conflicting.done;
    expect(conflicting.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );

    const joined = invoke({ agentId: "main", idempotencyKey: "long-create", message: "hello" });
    release.resolve();
    await Promise.all([original.done, joined.done]);
    expect(execute).toHaveBeenCalledOnce();
    expect(joined.respond).toHaveBeenCalledWith(true, { key: "agent:main:finished" }, undefined, {
      cached: true,
    });
  });

  it("expires only settled successful results and immediately releases failed creates", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { execute, invoke } = createFixture();
    await invoke().done;
    now += SESSION_CREATE_IDEMPOTENCY_RETENTION_MS - 1;
    await invoke().done;
    expect(execute).toHaveBeenCalledOnce();
    now += 1;
    await invoke().done;
    expect(execute).toHaveBeenCalledTimes(2);

    let fail = true;
    const failed = createFixture((request) => {
      request.respond(!fail, fail ? undefined : { key: "recovered" });
      fail = false;
    });
    await failed.invoke().done;
    await failed.invoke().done;
    expect(failed.execute).toHaveBeenCalledTimes(2);
  });

  it("enforces capacity per owner without evicting retained successful creations", async () => {
    const { client, execute, invoke } = createFixture();
    for (let index = 0; index < DEDUPE_MAX; index += 1) {
      await invoke({ agentId: "main", idempotencyKey: `create-${index}` }).done;
    }
    const overflow = invoke({ agentId: "main", idempotencyKey: "overflow" });
    await overflow.done;
    expect(overflow.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE", message: expect.stringContaining("retry") }),
    );
    expect(execute).toHaveBeenCalledTimes(DEDUPE_MAX);

    const retained = invoke({ agentId: "main", idempotencyKey: "create-0" });
    await retained.done;
    expect(retained.respond).toHaveBeenCalledWith(true, { key: "agent:main:create-0" }, undefined, {
      cached: true,
    });
    expect(execute).toHaveBeenCalledTimes(DEDUPE_MAX);

    const otherOwner = { ...client, authenticatedUserId: "other-owner" };
    const otherCreation = invoke({ agentId: "main", idempotencyKey: "create-0" }, otherOwner);
    await otherCreation.done;
    expect(otherCreation.respond).toHaveBeenCalledWith(
      true,
      { key: "agent:main:create-0" },
      undefined,
      undefined,
    );
    expect(execute).toHaveBeenCalledTimes(DEDUPE_MAX + 1);

    const otherReplay = invoke({ agentId: "main", idempotencyKey: "create-0" }, otherOwner);
    await otherReplay.done;
    expect(otherReplay.respond).toHaveBeenCalledWith(
      true,
      { key: "agent:main:create-0" },
      undefined,
      { cached: true },
    );
    expect(execute).toHaveBeenCalledTimes(DEDUPE_MAX + 1);

    for (let index = 1; index < DEDUPE_MAX; index += 1) {
      await invoke({ agentId: "main", idempotencyKey: `create-${index}` }, otherOwner).done;
    }
    const thirdOwner = { ...client, authenticatedUserId: "third-owner" };
    const processOverflow = invoke({ agentId: "main", idempotencyKey: "create-0" }, thirdOwner);
    await processOverflow.done;
    expect(processOverflow.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE" }),
    );
    expect(execute).toHaveBeenCalledTimes(DEDUPE_MAX * 2);
  });
});
