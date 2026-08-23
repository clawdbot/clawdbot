import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { handleGatewayRequest } from "../server-methods.js";
import type { WorkerSessionPlacementRecord } from "../worker-environments/placement-store.js";
import {
  dispatchTestSessionId as sessionId,
  dispatchTestSessionKey as sessionKey,
  getDispatchTestMocks,
  getSessionDispatchHandler,
  makeDispatchTestContext,
  makeReclaimedPlacement,
  makeSessionTarget,
} from "./sessions-dispatch.test-support.js";

const mocks = getDispatchTestMocks();
const originalPluginRegistry = getActivePluginRegistry();

function activePlacement(): Extract<WorkerSessionPlacementRecord, { state: "active" }> {
  return {
    ...makeReclaimedPlacement(),
    state: "active",
    recoveryError: null,
    terminalReason: null,
    terminalAtMs: null,
  };
}

describe("sessions.dispatch authorization", () => {
  beforeEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry(), "sessions-dispatch-auth-test", "default");
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalPluginRegistry) {
      setActivePluginRegistry(
        originalPluginRegistry,
        "sessions-dispatch-auth-test-restore",
        "default",
      );
    } else {
      resetPluginRuntimeStateForTest();
    }
  });

  it("requires admin before resolving a configured project profile", async () => {
    mocks.resolveTarget.mockReturnValue(
      makeSessionTarget({
        sessionId,
        worktree: { id: "worktree-1", branch: "openclaw/cloud-test", repoRoot: "/repo" },
      }),
    );
    mocks.findLiveByOwner.mockReturnValue({
      id: "worktree-1",
      ownerKind: "session",
      ownerId: sessionKey,
      path: "/repo/worktree",
    });
    mocks.runCommandWithTimeout.mockResolvedValue({
      code: 0,
      stdout: "git@github.com:Acme/App.git\n",
      stderr: "",
    });
    const dispatch = vi.fn().mockResolvedValue(activePlacement());
    const context = makeDispatchTestContext({
      getRuntimeConfig: () => ({
        cloudWorkers: {
          profiles: { mapped: { provider: "fake" } },
          projectProfiles: { "github.com/acme/app": "mapped" },
        },
      }),
      logGateway: { warn: vi.fn() } as never,
      workerPlacementDispatchService: { dispatch },
      workerSessionPlacementService: { getMany: () => new Map() },
    });
    const request = async (scope: "operator.write" | "operator.admin") => {
      const respond = vi.fn();
      await handleGatewayRequest({
        req: {
          type: "req",
          id: `configured-default-${scope}`,
          method: "sessions.dispatch",
          params: { key: sessionKey },
        },
        respond,
        client: {
          connId: `conn-${scope}`,
          connect: {
            role: "operator",
            scopes: [scope],
            client: { id: "test", version: "1", platform: "test", mode: "test" },
            minProtocol: 1,
            maxProtocol: 1,
          },
        } as Parameters<typeof handleGatewayRequest>[0]["client"],
        isWebchatConnect: () => false,
        context,
        extraHandlers: { "sessions.dispatch": getSessionDispatchHandler() },
      });
      return respond;
    };

    const writeRespond = await request("operator.write");

    expect(writeRespond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.FORBIDDEN,
        details: {
          code: "MISSING_SCOPE",
          missingScope: "operator.admin",
          requiredScopes: ["operator.admin"],
        },
      }),
    );
    expect(mocks.resolveTarget).not.toHaveBeenCalled();
    expect(mocks.runCommandWithTimeout).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();

    const adminRespond = await request("operator.admin");

    expect(mocks.runCommandWithTimeout).toHaveBeenCalledWith(
      ["git", "-C", "/repo/worktree", "config", "--get", "remote.origin.url"],
      { timeoutMs: 4_000 },
    );
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "mapped" }),
      expect.any(Function),
      undefined,
    );
    expect(adminRespond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        ok: true,
        key: sessionKey,
        sessionId,
        placement: expect.objectContaining({ state: "active" }),
      }),
      undefined,
    );
  });
});
