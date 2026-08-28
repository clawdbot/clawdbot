import { expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SessionsListResult } from "../session-utils.types.js";
import { respondWithCachedSessionList } from "./sessions-list-cache.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

function result(status: "available" | "offline"): SessionsListResult {
  return {
    ts: 0,
    path: "",
    count: 1,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: [
      {
        key: "agent:main:runner-fence",
        kind: "direct",
        updatedAt: 1,
        placement: {
          state: "active",
          generation: 1,
          createdAtMs: 1,
          updatedAtMs: 1,
          stateChangedAtMs: 1,
          environmentId: "environment-device",
          activeOwnerEpoch: 1,
          workerBundleHash: "a".repeat(64),
          workspaceBaseManifestRef: "manifest-device",
          remoteWorkspaceDir: "/workspace",
          runner: { kind: "device", status },
        },
      },
    ],
  };
}

it("does not publish old in-flight runner availability across a version transition", async () => {
  const config: OpenClawConfig = {};
  let runnerAvailabilityVersion = 0;
  const context = {
    workerPlacementRunnerAvailabilityReader: {
      read: () => undefined,
      version: () => runnerAvailabilityVersion,
    },
  } as unknown as GatewayRequestContext;
  const client = {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
      role: "operator",
      scopes: ["operator.read", "operator.write"],
    },
    authenticatedUserProfile: {
      profileId: "owner@example.com",
      displayName: "Owner",
      hasAvatar: false,
      updatedAt: 1,
    },
  } as GatewayClient;
  const request = { archived: "all" as const, limit: 100 };
  const requestList = async (run: () => Promise<SessionsListResult>) => {
    let response: SessionsListResult | undefined;
    await respondWithCachedSessionList({
      client,
      config,
      context,
      request,
      respond: (ok, payload) => {
        expect(ok).toBe(true);
        response = payload as SessionsListResult;
      },
      run,
    });
    return response;
  };
  let releaseOld!: (value: SessionsListResult) => void;
  const oldResult = new Promise<SessionsListResult>((resolve) => {
    releaseOld = resolve;
  });

  const old = requestList(async () => await oldResult);
  await Promise.resolve();
  runnerAvailabilityVersion += 3;
  const offline = result("offline");
  const fresh = requestList(async () => offline);
  releaseOld(result("available"));

  expect((await old)?.sessions[0]?.placement).toMatchObject({
    runner: { status: "available" },
  });
  expect(await fresh).toBe(offline);
  expect(await requestList(async () => result("available"))).toBe(offline);
});
