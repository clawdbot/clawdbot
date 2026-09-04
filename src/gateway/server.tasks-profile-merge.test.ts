import path from "node:path";
import { expect, test } from "vitest";
import type {
  TasksListResult,
  UsersSelfResult,
} from "../../packages/gateway-protocol/src/index.js";
import { writeConfigFile } from "../config/config.js";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { GatewayAuthConfig } from "../config/types.gateway.js";
import { ensureProfileForEmail, setUserProfileRole } from "../state/user-profiles.js";
import { configureTaskRegistryRuntime } from "../tasks/task-registry.store.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import { resetTaskRegistryForTests } from "../tasks/task-runtime.test-helpers.js";
import { invalidateOperatorRolePolicy } from "./operator-role-policy.js";
import {
  connectReq,
  CONTROL_UI_CLIENT,
  installGatewayTestHooks,
  openWs,
  rpcReq,
  testState,
  withGatewayServer,
} from "./server.auth.test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

test("expires task cursors when a profile merge changes the same caller's session ownership", async () => {
  const adminProfile = ensureProfileForEmail("admin@example.test");
  const viewerProfile = ensureProfileForEmail("viewer@example.test");
  const sourceProfile = ensureProfileForEmail("source@example.test");
  setUserProfileRole(adminProfile.id, "maintainer");
  setUserProfileRole(viewerProfile.id, "restricted");
  const origin = "https://control.example.test";
  const auth: GatewayAuthConfig = {
    mode: "trusted-proxy",
    identityScopes: {
      "admin@example.test": ["operator.admin"],
      "viewer@example.test": ["operator.read"],
    },
    trustedProxy: {
      userHeader: "x-forwarded-user",
      requiredHeaders: ["x-forwarded-proto"],
      allowLoopback: true,
    },
  };
  testState.gatewayAuth = auth;
  testState.gatewayControlUi = { allowedOrigins: [origin] };
  await writeConfigFile({
    gateway: {
      auth,
      trustedProxies: ["127.0.0.1"],
      roles: {
        default: "restricted",
        definitions: {
          restricted: { sessions: { others: "view" }, agents: "*", scopes: ["operator.read"] },
          maintainer: { sessions: { others: "write" }, agents: "*", scopes: ["operator.admin"] },
        },
      },
      controlUi: { allowedOrigins: [origin] },
    },
  });
  const ownedKey = "agent:main:merge-owned";
  const sourceKey = "agent:main:merge-source";
  const tasks = new Map<string, TaskRecord>();
  for (const [index, requesterSessionKey] of [ownedKey, ownedKey, sourceKey, sourceKey].entries()) {
    const taskId = `task-${index}`;
    tasks.set(taskId, {
      taskId,
      runtime: "cli",
      requesterSessionKey,
      requesterAgentId: "main",
      ownerKey: requesterSessionKey,
      scopeKind: "session",
      runId: `run-${index}`,
      task: `Task ${index}`,
      status: "succeeded",
      deliveryStatus: "not_applicable",
      notifyPolicy: "done_only",
      createdAt: 0,
      lastEventAt: index,
    });
  }
  try {
    await withGatewayServer(async ({ port }) => {
      for (const [sessionKey, profileId] of [
        [ownedKey, viewerProfile.id],
        [sourceKey, sourceProfile.id],
      ] as const) {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          {
            sessionId: `${sessionKey}-id`,
            lifecycleRevision: `${sessionKey}-generation`,
            updatedAt: 1,
            createdActor: { type: "human", source: "profile", id: profileId },
            visibility: "draft",
          },
        );
      }
      resetTaskRegistryForTests({ persist: false });
      configureTaskRegistryRuntime({
        store: {
          loadSnapshot: () => ({ tasks, deliveryStates: new Map() }),
          saveSnapshot: () => {},
        },
      });
      const stateDir = process.env.OPENCLAW_STATE_DIR;
      if (!stateDir) {
        throw new Error("OPENCLAW_STATE_DIR is required for the Gateway proof");
      }
      const connect = async (email: string, scopes: string[]) => {
        const ws = await openWs(port, {
          origin,
          "x-forwarded-for": "203.0.113.50",
          "x-forwarded-proto": "https",
          "x-forwarded-user": email,
        });
        const connected = await connectReq(ws, {
          skipDefaultAuth: true,
          prePairDevice: true,
          scopes,
          client: CONTROL_UI_CLIENT,
          deviceIdentityPath: path.join(stateDir, `${email}.sqlite`),
          browserOrigin: origin,
        });
        expect(connected.ok, JSON.stringify(connected.error)).toBe(true);
        return ws;
      };
      const admin = await connect("admin@example.test", ["operator.admin"]);
      const viewer = await connect("viewer@example.test", ["operator.read"]);
      try {
        const before = await rpcReq<UsersSelfResult>(viewer, "users.self", {});
        expect(before).toMatchObject({ ok: true, payload: { profile: { id: viewerProfile.id } } });
        const first = await rpcReq<TasksListResult>(viewer, "tasks.list", { limit: 1 });
        expect(first.ok, JSON.stringify(first.error)).toBe(true);
        expect(first.payload?.tasks.map((task) => task.id)).toEqual(["task-1"]);
        const cursor = first.payload?.nextCursor;
        expect(cursor).toEqual(expect.any(String));
        const beforeContinuation = await rpcReq<TasksListResult>(viewer, "tasks.list", {
          limit: 1,
          cursor,
        });
        expect(beforeContinuation.ok, JSON.stringify(beforeContinuation.error)).toBe(true);
        expect(beforeContinuation.payload?.tasks.map((task) => task.id)).toEqual(["task-0"]);
        const sourceEntry = loadSessionEntry({ agentId: "main", sessionKey: sourceKey });

        const merge = await rpcReq(admin, "users.linkEmail", {
          email: "source@example.test",
          targetProfileId: viewerProfile.id,
        });
        expect(merge.ok, JSON.stringify(merge.error)).toBe(true);
        const after = await rpcReq<UsersSelfResult>(viewer, "users.self", {});
        expect(after).toMatchObject({ ok: true, payload: { profile: { id: viewerProfile.id } } });
        expect(loadSessionEntry({ agentId: "main", sessionKey: sourceKey })).toEqual(sourceEntry);
        const resumed = await rpcReq<TasksListResult>(viewer, "tasks.list", { limit: 1, cursor });
        const fresh = await rpcReq<TasksListResult>(viewer, "tasks.list", { limit: 4 });
        expect(fresh.ok, JSON.stringify(fresh.error)).toBe(true);
        expect(fresh.payload?.tasks.map((task) => task.id)).toEqual([
          "task-3",
          "task-2",
          "task-1",
          "task-0",
        ]);
        console.info("profile-merge cursor proof", {
          sameProfile: before.payload?.profile.id === after.payload?.profile.id,
          first: first.payload?.tasks.map((task) => task.id),
          resumedOk: resumed.ok,
          resumedError: resumed.error,
          resumedTasks: resumed.payload?.tasks.map((task) => task.id),
          fresh: fresh.payload?.tasks.map((task) => task.id),
        });
        expect(resumed).toMatchObject({
          ok: false,
          error: {
            code: "INVALID_REQUEST",
            message: expect.stringContaining("restart pagination"),
          },
        });
      } finally {
        admin.close();
        viewer.close();
        resetTaskRegistryForTests({ persist: false });
      }
    });
  } finally {
    invalidateOperatorRolePolicy(adminProfile.id);
    invalidateOperatorRolePolicy(viewerProfile.id);
  }
}, 60_000);
