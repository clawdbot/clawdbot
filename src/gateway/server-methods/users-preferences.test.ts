import { afterEach, expect, test, vi } from "vitest";
import { GatewayErrorDetailCodes } from "../../../packages/gateway-protocol/src/index.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { ensureProfileForEmail, linkEmail } from "../../state/user-profiles.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { GatewayClient } from "./types.js";
import { usersHandlers } from "./users.js";

async function invokePreferenceMethod(
  method: "users.prefs.get" | "users.prefs.set",
  params: Record<string, unknown>,
  profileId?: string,
  context: Record<string, unknown> = {},
) {
  let result: { ok: boolean; payload?: unknown; error?: unknown } | undefined;
  await usersHandlers[method]!({
    req: {} as never,
    params,
    respond: (ok, payload, error) => {
      result = { ok, payload, error };
    },
    context: context as never,
    client: {
      connect: { scopes: ["operator.admin"] },
      ...(profileId ? { authenticatedUserProfile: { profileId } } : {}),
    } as never,
    isWebchatConnect: () => false,
  });
  return result;
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

test("users.prefs remains self-scoped across durable identities", async () => {
  const state = await createOpenClawTestState({ layout: "state-only", prefix: "users-prefs-rpc-" });
  try {
    const ada = ensureProfileForEmail("ada@example.test");
    const grace = ensureProfileForEmail("grace@example.test");
    expect(
      await invokePreferenceMethod(
        "users.prefs.set",
        { entries: { "new-session.v1:main": { folder: "/ada" } } },
        ada.id,
      ),
    ).toEqual({ ok: true, payload: { status: "ok" }, error: undefined });
    expect(await invokePreferenceMethod("users.prefs.get", {}, ada.id)).toMatchObject({
      ok: true,
      payload: {
        status: "ok",
        entries: { "new-session.v1:main": { folder: "/ada" } },
      },
    });
    expect(await invokePreferenceMethod("users.prefs.get", {}, grace.id)).toMatchObject({
      ok: true,
      payload: { status: "ok", entries: {} },
    });
    linkEmail("ada@example.test", grace.id);
    expect(await invokePreferenceMethod("users.prefs.get", {}, grace.id)).toMatchObject({
      ok: true,
      payload: {
        status: "ok",
        entries: { "new-session.v1:main": { folder: "/ada" } },
      },
    });
  } finally {
    await state.cleanup();
  }
});

test("users.prefs returns a typed result without a durable identity", async () => {
  const context = { broadcastToConnIds: vi.fn(), getClientConnIds: vi.fn() };
  expect(await invokePreferenceMethod("users.prefs.get", {}, undefined, context)).toMatchObject({
    ok: true,
    payload: { status: "no_durable_identity" },
  });
  expect(
    await invokePreferenceMethod(
      "users.prefs.set",
      { entries: { theme: "claw" } },
      undefined,
      context,
    ),
  ).toMatchObject({
    ok: true,
    payload: { status: "no_durable_identity" },
  });
  expect(context.getClientConnIds).not.toHaveBeenCalled();
  expect(context.broadcastToConnIds).not.toHaveBeenCalled();
});

test("users.prefs.set notifies only connections belonging to the same merged profile", async () => {
  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "users-prefs-events-",
  });
  try {
    const retired = ensureProfileForEmail("retired@example.test");
    const owner = ensureProfileForEmail("owner@example.test");
    const other = ensureProfileForEmail("other@example.test");
    linkEmail("retired@example.test", owner.id);

    const connectedClients = [
      { connId: "owner", authenticatedUserProfile: { profileId: owner.id } },
      { connId: "merged", authenticatedUserProfile: { profileId: retired.id } },
      { connId: "other", authenticatedUserProfile: { profileId: other.id } },
      { connId: "unbound" },
    ];
    const broadcastToConnIds = vi.fn();
    const context = {
      broadcastToConnIds,
      getClientConnIds: (filter: (client: GatewayClient) => boolean) =>
        new Set(
          connectedClients
            .filter((client) => filter(client as GatewayClient))
            .map((client) => client.connId),
        ),
    };

    expect(
      await invokePreferenceMethod(
        "users.prefs.set",
        { entries: { "ui.accent": "#A1B2C3", "ui.theme": null } },
        retired.id,
        context,
      ),
    ).toMatchObject({ ok: true, payload: { status: "ok" } });
    expect(broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
      "users.prefs.changed",
      { profileId: owner.id, keys: ["ui.accent", "ui.theme"] },
      new Set(["owner", "merged"]),
    );
  } finally {
    await state.cleanup();
  }
});

test("users.prefs.set returns typed profile quota details", async () => {
  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "users-prefs-quota-",
  });
  try {
    const profile = ensureProfileForEmail("quota@example.test");
    for (let start = 0; start < 128; start += 32) {
      const entries = Object.fromEntries(
        Array.from({ length: 32 }, (_, index) => [`key-${start + index}`, true]),
      );
      expect(
        await invokePreferenceMethod("users.prefs.set", { entries }, profile.id),
      ).toMatchObject({
        ok: true,
        payload: { status: "ok" },
      });
    }

    expect(
      await invokePreferenceMethod("users.prefs.set", { entries: { "key-128": true } }, profile.id),
    ).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        details: {
          code: GatewayErrorDetailCodes.USER_PREFS_LIMIT_EXCEEDED,
          limit: 128,
          currentCount: 128,
        },
      },
    });
  } finally {
    await state.cleanup();
  }
});
