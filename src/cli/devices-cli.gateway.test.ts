// Real CLI scope selection, Gateway handlers, and token storage with in-process transport.
// Authentication mode is supplied by the fixture; device scope grants use the real verifier.
import { expectDefined } from "@openclaw/normalization-core";
import { Command } from "commander";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayClientOptions } from "../gateway/client.js";
import { authorizeOperatorScopesForMethod } from "../gateway/method-scopes.js";
import { deviceHandlers } from "../gateway/server-methods/devices.js";
import type { GatewayRequestHandlerOptions } from "../gateway/server-methods/types.js";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import {
  revokeDeviceToken,
  rotateDeviceToken,
  verifyDeviceToken,
} from "../infra/device-pairing-tokens.js";
import { getPairedDevice, requestDevicePairing } from "../infra/device-pairing.js";
import { normalizeDeviceAuthScopes } from "../shared/device-auth.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { registerDevicesCli } from "./devices-cli.js";

const transport = vi.hoisted(() => ({
  request:
    vi.fn<
      (scopes: string[], method: string, params: Record<string, unknown>) => Promise<unknown>
    >(),
  runtime: { log: vi.fn(), error: vi.fn(), writeJson: vi.fn(), exit: vi.fn() },
}));

vi.mock("../config/gateway-dispatch-config.js", () => ({
  readGatewayDispatchConfig: () => ({ gateway: { auth: { mode: "none" } } }),
  readGatewayDispatchConfigWithShellEnvFallback: async () => ({
    gateway: { auth: { mode: "none" } },
  }),
}));

vi.mock("../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime.js")>()),
  defaultRuntime: transport.runtime,
}));

vi.mock("../gateway/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../gateway/client.js")>()),
  GatewayClient: class {
    constructor(private readonly options: GatewayClientOptions) {}
    start() {
      this.options.onHelloOk?.({
        type: "hello-ok",
        protocol: 1,
        server: { version: "test", connId: "test-connection" },
        features: { methods: Object.keys(deviceHandlers), events: [] },
        snapshot: {
          presence: [],
          health: {},
          stateVersion: { presence: 0, health: 0 },
          uptimeMs: 0,
        },
        auth: { role: "operator", scopes: this.options.scopes ?? [] },
        policy: { maxPayload: 1, maxBufferedBytes: 1, tickIntervalMs: 1 },
      });
    }
    async request(method: string, params: Record<string, unknown>) {
      return await transport.request(this.options.scopes ?? [], method, params);
    }
    async stopAndWait() {}
  },
}));

const roots = createSuiteTempRootTracker({ prefix: "openclaw-devices-cli-scopes-" });
const targetDeviceId = "device-1";
let baseDir: string;
const warn = vi.fn();

beforeAll(async () => {
  await roots.setup();
});
beforeEach(async () => {
  vi.clearAllMocks();
  baseDir = await roots.make();
  vi.stubEnv("OPENCLAW_STATE_DIR", baseDir);
});
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await roots.cleanup();
});

async function pairOperator(deviceId: string, scopes: string[], tokenScopes = scopes) {
  const pending = await requestDevicePairing({
    deviceId,
    publicKey: `public-${deviceId}`,
    role: "operator",
    scopes,
  });
  const approved = await approveDevicePairing(pending.request.requestId, {
    callerScopes: ["operator.admin"],
  });
  expect(approved?.status).toBe("approved");
  const rotated = await rotateDeviceToken({ deviceId, role: "operator", scopes: tokenScopes });
  expect(rotated.ok).toBe(true);
}

async function installTransport(callerDeviceId?: string) {
  const caller = callerDeviceId ? await getPairedDevice(callerDeviceId) : null;
  const callerToken = caller?.tokens?.operator?.token;
  transport.request.mockImplementation(
    async (scopes: string[], method: string, params: Record<string, unknown>) => {
      if (callerDeviceId) {
        const verified = await verifyDeviceToken({
          deviceId: callerDeviceId,
          role: "operator",
          scopes,
          token: expectDefined(callerToken, "expected paired caller token"),
        });
        if (!verified.ok) {
          throw new Error(`device auth denied: ${verified.reason}`);
        }
      }
      const methodAuth = authorizeOperatorScopesForMethod(method, scopes, params);
      if (!methodAuth.allowed) {
        throw new Error(`missing scope: ${methodAuth.missingScope}`);
      }
      const handler = expectDefined(deviceHandlers[method], "expected real device handler");
      const respond = vi.fn<GatewayRequestHandlerOptions["respond"]>();
      await handler({
        req: { type: "req", id: "scope-test", method, params },
        params,
        respond,
        client: {
          isDeviceTokenAuth: Boolean(callerDeviceId),
          connect: { scopes, device: callerDeviceId ? { id: callerDeviceId } : undefined },
        },
        context: { logGateway: { info: vi.fn(), warn }, broadcast: vi.fn() },
      } as unknown as GatewayRequestHandlerOptions);
      expect(respond).toHaveBeenCalledOnce();
      const [ok, result, error] = expectDefined(respond.mock.calls[0], "expected Gateway response");
      if (!ok) {
        throw new Error(expectDefined(error, "expected Gateway denial").message);
      }
      return result;
    },
  );
}

async function runTokenCommand(command: string, scopes?: string[]) {
  const program = new Command();
  registerDevicesCli(program);
  const argv = [
    "devices",
    command,
    "--device",
    ` ${targetDeviceId} `,
    "--role",
    " operator ",
    "--json",
  ];
  for (const scope of scopes ?? []) {
    argv.push("--scope", scope);
  }
  await program.parseAsync(argv, { from: "user" });
}

describe.each(["rotate", "revoke"])("devices %s request authorization", (command) => {
  it.each([
    {
      name: "shared caller with admin target",
      scopes: ["operator.admin"],
      caller: "shared",
      connectionScopes: ["operator.admin"],
    },
    {
      name: "paired admin managing another admin target",
      scopes: ["operator.admin"],
      caller: "admin-cross-device",
      connectionScopes: ["operator.admin"],
    },
    {
      name: "paired admin managing another limited target",
      scopes: ["operator.pairing", "operator.read"],
      caller: "admin-cross-device",
      connectionScopes: ["operator.admin"],
    },
    {
      name: "limited self with a broader approval baseline",
      scopes: ["operator.pairing", "operator.read"],
      caller: "self",
      connectionScopes: ["operator.pairing", "operator.read"],
    },
    {
      name: "admin self with implicit pairing/read/write scopes",
      scopes: ["operator.admin"],
      caller: "self",
      connectionScopes: ["operator.admin"],
    },
    {
      name: "limited self with talk and questions",
      scopes: ["operator.pairing", "operator.talk", "operator.questions"],
      caller: "self",
      connectionScopes: ["operator.pairing", "operator.questions", "operator.talk"],
    },
    {
      name: "pairing-only self",
      scopes: ["operator.pairing"],
      caller: "self",
      connectionScopes: ["operator.pairing"],
    },
    {
      name: "write self with implied read",
      scopes: ["operator.pairing", "operator.write"],
      caller: "self",
      connectionScopes: ["operator.pairing", "operator.read", "operator.write"],
    },
  ])("manages $name", async ({ scopes, caller, connectionScopes }) => {
    await pairOperator(targetDeviceId, ["operator.admin"], scopes);
    if (caller === "admin-cross-device") {
      await pairOperator("caller", ["operator.admin"]);
    }
    await installTransport(
      caller === "self" ? targetDeviceId : caller === "admin-cross-device" ? "caller" : undefined,
    );
    const before = expectDefined(await getPairedDevice(targetDeviceId), "paired target");

    await runTokenCommand(command);

    const after = expectDefined(await getPairedDevice(targetDeviceId), "retained paired target");
    expect(after.approvedScopes).toEqual(before.approvedScopes);
    expect(after.tokens?.operator?.scopes).toEqual(normalizeDeviceAuthScopes(scopes));
    if (command === "rotate") {
      expect(after.tokens?.operator?.token !== before.tokens?.operator?.token).toBe(true);
      expect(after.tokens?.operator?.revokedAtMs).toBeUndefined();
    } else {
      expect(after.tokens?.operator?.revokedAtMs).toEqual(expect.any(Number));
    }
    expect(transport.runtime.writeJson).toHaveBeenCalledOnce();
    expect(
      transport.request.mock.calls.map(([requested, method]) => ({ requested, method })),
    ).toEqual([
      { requested: ["operator.pairing"], method: "device.pair.list" },
      { requested: connectionScopes, method: `device.token.${command}` },
    ]);
    const [output] = expectDefined(
      transport.runtime.writeJson.mock.calls[0],
      "expected CLI output",
    );
    expect(typeof output.token === "string").toBe(command === "rotate" && caller === "self");
    expect(warn).not.toHaveBeenCalled();
  });

  it("uses a revoked target token's narrowed scopes", async () => {
    await pairOperator(targetDeviceId, ["operator.admin"], ["operator.read"]);
    const revoked = await revokeDeviceToken({ deviceId: targetDeviceId, role: "operator" });
    expect(revoked.ok).toBe(true);
    await installTransport();

    await runTokenCommand(command);

    expect(transport.request.mock.calls.at(-1)?.[0]).toEqual(["operator.pairing", "operator.read"]);
    const after = await getPairedDevice(targetDeviceId);
    expect(after?.tokens?.operator?.scopes).toEqual(["operator.read"]);
    expect(Boolean(after?.tokens?.operator?.revokedAtMs)).toBe(command === "revoke");
  });

  it.each([
    { name: "omitted scopes", scopes: undefined },
    ...(command === "rotate" ? [{ name: "explicit scopes", scopes: ["operator.read"] }] : []),
  ])("keeps cross-device management denied for a limited caller with $name", async ({ scopes }) => {
    await pairOperator(targetDeviceId, ["operator.admin"]);
    await pairOperator("caller", ["operator.pairing", "operator.read"]);
    await installTransport("caller");
    const before = await getPairedDevice(targetDeviceId);

    await expect(runTokenCommand(command, scopes)).rejects.toThrow(
      "device auth denied: scope-mismatch",
    );

    expect(warn).not.toHaveBeenCalled();
    expect(
      transport.request.mock.calls.map(([requested, method]) => ({ requested, method })),
    ).toEqual([
      { requested: ["operator.pairing"], method: "device.pair.list" },
      { requested: ["operator.admin"], method: `device.token.${command}` },
    ]);
    const after = await getPairedDevice(targetDeviceId);
    expect(after?.tokens?.operator?.token === before?.tokens?.operator?.token).toBe(true);
    expect(after?.tokens?.operator?.revokedAtMs).toBeUndefined();
    expect(transport.runtime.writeJson).not.toHaveBeenCalled();
  });

  it("keeps missing targets at the canonical token-owner denial", async () => {
    await installTransport();

    await expect(runTokenCommand(command)).rejects.toThrow(
      command === "rotate" ? "device token rotation denied" : "device token revocation denied",
    );

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unknown-device-or-role"));
    expect(await getPairedDevice(targetDeviceId)).toBeNull();
    expect(transport.runtime.writeJson).not.toHaveBeenCalled();
  });

  it("rechecks target scopes when they change after listing", async () => {
    await pairOperator(targetDeviceId, ["operator.admin"], ["operator.read"]);
    await installTransport();
    const dispatch = expectDefined(
      transport.request.getMockImplementation(),
      "installed transport",
    );
    let replacementToken: string | undefined;
    transport.request.mockImplementation(async (...args) => {
      const result = await dispatch(...args);
      if (args[1] === "device.pair.list") {
        const replacement = await rotateDeviceToken({
          deviceId: targetDeviceId,
          role: "operator",
          scopes: ["operator.admin"],
        });
        expect(replacement.ok).toBe(true);
        if (replacement.ok) {
          replacementToken = replacement.entry.token;
        }
      }
      return result;
    });

    await expect(runTokenCommand(command)).rejects.toThrow(
      command === "rotate" ? "device token rotation denied" : "device token revocation denied",
    );

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("caller-missing-scope scope=operator.admin"),
    );
    const after = await getPairedDevice(targetDeviceId);
    expect(after?.tokens?.operator?.token === replacementToken).toBe(true);
    expect(after?.tokens?.operator?.revokedAtMs).toBeUndefined();
    expect(transport.runtime.writeJson).not.toHaveBeenCalled();
  });

  it("does not attempt token mutation when listing fails", async () => {
    transport.request.mockRejectedValue(new Error("pairing list unavailable"));

    await expect(
      runTokenCommand(command, command === "rotate" ? ["operator.read"] : undefined),
    ).rejects.toThrow("pairing list unavailable");

    expect(transport.request.mock.calls.map(([, method]) => method)).toEqual(["device.pair.list"]);
    expect(transport.runtime.writeJson).not.toHaveBeenCalled();
  });
});

describe("devices rotate explicit scopes", () => {
  it.each([
    {
      name: "narrowing self",
      caller: "self",
      requested: ["operator.read"],
      expected: ["operator.pairing", "operator.read"],
    },
    {
      name: "shared caller restoring approved admin",
      caller: "shared",
      requested: ["operator.admin"],
      expected: ["operator.admin"],
    },
    {
      name: "paired admin narrowing another admin token",
      caller: "admin-cross-device",
      tokenScopes: ["operator.admin"],
      requested: ["operator.read"],
      expected: ["operator.admin"],
    },
  ])(
    "selects required connection scopes for $name",
    async ({ caller, tokenScopes, requested, expected }) => {
      await pairOperator(
        targetDeviceId,
        ["operator.admin"],
        tokenScopes ?? ["operator.pairing", "operator.write"],
      );
      if (caller === "admin-cross-device") {
        await pairOperator("caller", ["operator.admin"]);
      }
      await installTransport(
        caller === "self" ? targetDeviceId : caller === "admin-cross-device" ? "caller" : undefined,
      );

      await runTokenCommand("rotate", requested);

      expect(transport.request.mock.calls.map(([scopes, method]) => ({ scopes, method }))).toEqual([
        { scopes: ["operator.pairing"], method: "device.pair.list" },
        { scopes: expected, method: "device.token.rotate" },
      ]);
      const after = await getPairedDevice(targetDeviceId);
      expect(after?.tokens?.operator?.scopes).toEqual(normalizeDeviceAuthScopes(requested));
      expect(after?.approvedScopes).toEqual(["operator.admin"]);
    },
  );

  it.each([
    {
      name: "caller token ceiling",
      caller: "self",
      approved: ["operator.admin"],
      error: "device auth denied: scope-mismatch",
    },
    {
      name: "approved device baseline",
      caller: "shared",
      approved: ["operator.pairing", "operator.read"],
      error: "device token rotation denied",
    },
  ])("rejects escalation beyond the $name", async ({ caller, approved, error }) => {
    await pairOperator(targetDeviceId, approved, ["operator.pairing", "operator.read"]);
    await installTransport(caller === "self" ? targetDeviceId : undefined);
    const before = await getPairedDevice(targetDeviceId);

    await expect(runTokenCommand("rotate", ["operator.admin"])).rejects.toThrow(error);

    const after = await getPairedDevice(targetDeviceId);
    expect(after?.tokens?.operator?.token === before?.tokens?.operator?.token).toBe(true);
    expect(after?.approvedScopes).toEqual(before?.approvedScopes);
    expect(transport.runtime.writeJson).not.toHaveBeenCalled();
  });
});
