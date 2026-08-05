import { expect, test, vi } from "vitest";
import type { SessionsDiagnoseResult } from "../../../packages/gateway-protocol/src/index.js";
import { writeSessionStore } from "../test-helpers.js";
import {
  directSessionReq,
  sessionStoreEntry,
  setupGatewaySessionsTestHarness,
} from "../test/server-sessions.test-helpers.js";
import type { GatewayClient } from "./types.js";

vi.mock("../../plugins/host-hook-state.js", async () => {
  const actual = await vi.importActual<typeof import("../../plugins/host-hook-state.js")>(
    "../../plugins/host-hook-state.js",
  );
  return {
    ...actual,
    projectPluginSessionExtensionsSync: () => [],
  };
});

const { createSessionStoreDir } = setupGatewaySessionsTestHarness();

function identifiedOperatorClient(params: { userId: string; scopes?: string[] }): GatewayClient {
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: "openclaw-control-ui",
        version: "test",
        platform: "test",
        mode: "webchat",
      },
      role: "operator",
      scopes: params.scopes ?? ["operator.read"],
    },
    authenticatedUserId: params.userId,
    authenticatedUserProfile: {
      profileId: params.userId,
      displayName: null,
      hasAvatar: false,
      updatedAt: 1,
    },
  };
}

test.each([
  {
    name: "exact key for another operator's draft",
    selector: { key: "agent:main:hidden" },
    entry: { visibility: "draft" as const },
  },
  {
    name: "session id for another operator's draft",
    selector: { sessionId: "sess-hidden" },
    entry: { visibility: "draft" as const },
  },
  {
    name: "label for an incognito session",
    selector: { label: "private-ops" },
    entry: { incognito: true as const },
  },
])(
  "sessions.diagnose hides $name from identified non-admin clients",
  async ({ selector, entry }) => {
    await createSessionStoreDir();
    await writeSessionStore({
      entries: {
        "agent:main:hidden": sessionStoreEntry("sess-hidden", {
          label: "private-ops",
          status: "running",
          createdActor: { type: "human", id: "owner@example.com" },
          ...entry,
        }),
      },
    });

    const result = await directSessionReq<SessionsDiagnoseResult>("sessions.diagnose", selector, {
      client: identifiedOperatorClient({ userId: "viewer@example.com" }),
    });

    expect(result.ok).toBe(true);
    expect(result.payload).toMatchObject({
      outcome: "not_found",
      session: { found: false },
    });
    expect(JSON.stringify(result.payload)).not.toContain("owner@example.com");
  },
);

test("sessions.diagnose filters hidden rows before automatic candidate scoring", async () => {
  await createSessionStoreDir();
  const now = Date.now();
  await writeSessionStore({
    entries: {
      "agent:main:hidden": sessionStoreEntry("sess-hidden", {
        status: "running",
        updatedAt: now,
        visibility: "draft",
        createdActor: { type: "human", id: "owner@example.com" },
      }),
      "agent:main:visible": sessionStoreEntry("sess-visible", {
        updatedAt: 1,
        visibility: "shared",
        createdActor: { type: "human", id: "owner@example.com" },
      }),
    },
  });

  const result = await directSessionReq<SessionsDiagnoseResult>(
    "sessions.diagnose",
    {},
    {
      client: identifiedOperatorClient({ userId: "viewer@example.com" }),
      context: {
        chatAbortControllers: new Map([
          [
            "run-hidden",
            {
              controller: new AbortController(),
              sessionId: "sess-hidden",
              sessionKey: "agent:main:hidden",
              agentId: "main",
              startedAtMs: now - 1_000,
              expiresAtMs: now + 60_000,
              kind: "agent",
            },
          ],
        ]),
      },
    },
  );

  expect(result.ok).toBe(true);
  expect(result.payload).toMatchObject({
    outcome: "diagnosed",
    session: { key: "agent:main:visible", sessionId: "sess-visible" },
  });
});

test("sessions.diagnose allows administrators to inspect incognito sessions", async () => {
  await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      "agent:main:hidden": sessionStoreEntry("sess-hidden", {
        incognito: true,
        createdActor: { type: "human", id: "owner@example.com" },
      }),
    },
  });

  const result = await directSessionReq<SessionsDiagnoseResult>(
    "sessions.diagnose",
    { key: "agent:main:hidden" },
    {
      client: identifiedOperatorClient({
        userId: "admin@example.com",
        scopes: ["operator.admin"],
      }),
    },
  );

  expect(result.ok).toBe(true);
  expect(result.payload).toMatchObject({
    outcome: "diagnosed",
    session: { key: "agent:main:hidden", sessionId: "sess-hidden" },
  });
});
