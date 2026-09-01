import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { createGatewayPortalService } from "../portals/portal-service.js";
import * as httpListen from "../server/http-listen.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import {
  createWorkerSessionPlacementStore,
  type WorkerSessionPlacementStore,
} from "./placement-store.js";
import { createWorkerPortalToolExecutor } from "./worker-portal-tool-executor.js";

const sessionEntries = vi.hoisted(() => new Map<string, SessionEntry>());

vi.mock("../session-utils.js", () => ({
  loadGatewaySessionEntryReadOnly: (sessionKey: string) => ({
    canonicalKey: sessionKey,
    entry: structuredClone(sessionEntries.get(sessionKey)),
  }),
}));

const SOURCE = {
  agentId: "main",
  sessionId: "source-session",
  sessionKey: "agent:main:dashboard:source",
  environmentId: "source-environment",
  ownerEpoch: 3,
};

const PORTAL = {
  id: "worker-source-4321",
  title: "Worker app",
  port: 4321,
  listenPort: 54321,
  tokenQuery: "openclaw_portal=test-token",
  url: "http://127.0.0.1:54321/?openclaw_portal=test-token",
  publicUrl: "http://127.0.0.1:54321/",
  origin: "cloud-profile",
  createdAtMs: 1,
};

describe("worker portal tool execution", () => {
  let root: string;
  let placements: WorkerSessionPlacementStore;
  let identity: WorkerConnectionIdentity;
  let sourceClaim: ReturnType<WorkerSessionPlacementStore["claimTurn"]>;
  let sourceEnvironmentEpoch: number;
  let sourceNodeDeviceId: string | null;
  let sourceSshEndpoint: { host: string } | null;
  let execute: ReturnType<typeof createWorkerPortalToolExecutor>;
  const portalOpen = vi.fn();
  const portalList = vi.fn();
  const portalWorkerList = vi.fn();
  const portalClose = vi.fn();
  const portalCarrierOpen = vi.fn();
  const portalCarrierConnect = vi.fn();
  const portalCarrierClose = vi.fn();
  const portalChanged = vi.fn();
  const actualServices = new Set<ReturnType<typeof createGatewayPortalService>>();

  function useActualPortalService() {
    const httpServers: import("node:http").Server[] = [];
    const service = createGatewayPortalService({ httpBindHosts: ["127.0.0.1"], httpServers });
    portalOpen.mockImplementation(service.open);
    portalClose.mockImplementation(service.close);
    actualServices.add(service);
    return { service, httpServers };
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-worker-portal-"));
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    placements = createWorkerSessionPlacementStore({ database });
    let placement = placements.startDispatch(SOURCE);
    placement = placements.transition({
      sessionId: SOURCE.sessionId,
      from: "requested",
      to: "provisioning",
      expectedGeneration: placement.generation,
      patch: { environmentId: SOURCE.environmentId },
    });
    placement = placements.transition({
      sessionId: SOURCE.sessionId,
      from: "provisioning",
      to: "syncing",
      expectedGeneration: placement.generation,
      patch: { workerBundleHash: "a".repeat(64) },
    });
    placement = placements.transition({
      sessionId: SOURCE.sessionId,
      from: "syncing",
      to: "starting",
      expectedGeneration: placement.generation,
      patch: {
        workspaceBaseManifestRef: `manifest-${SOURCE.sessionId}`,
        remoteWorkspaceDir: `/workspace/${SOURCE.sessionId}`,
      },
    });
    placements.transition({
      sessionId: SOURCE.sessionId,
      from: "starting",
      to: "active",
      expectedGeneration: placement.generation,
      patch: { activeOwnerEpoch: SOURCE.ownerEpoch },
    });
    sourceClaim = placements.claimTurn({
      sessionId: SOURCE.sessionId,
      agentId: SOURCE.agentId,
      sessionKey: SOURCE.sessionKey,
      claimId: "source-claim",
      runId: "source-run",
      owner: {
        kind: "worker",
        environmentId: SOURCE.environmentId,
        ownerEpoch: SOURCE.ownerEpoch,
      },
    });
    placements.authorizeWorkerTurnTools(sourceClaim, ["portal"]);
    identity = {
      environmentId: SOURCE.environmentId,
      credentialHash: "credential-hash",
      bundleHash: "a".repeat(64),
      sessionId: SOURCE.sessionId,
      runId: sourceClaim.runId,
      turnClaim: sourceClaim,
      ownerEpoch: SOURCE.ownerEpoch,
      rpcSetVersion: 1,
      protocolFeatures: ["worker-portal-v1"],
      credentialExpiresAtMs: Date.now() + 60_000,
    };
    sessionEntries.clear();
    sessionEntries.set(SOURCE.sessionKey, { sessionId: SOURCE.sessionId, updatedAt: Date.now() });
    portalOpen.mockReset().mockResolvedValue(PORTAL);
    portalList.mockReset().mockReturnValue([PORTAL]);
    portalWorkerList.mockReset().mockReturnValue([PORTAL]);
    portalClose.mockReset().mockResolvedValue(undefined);
    portalCarrierConnect.mockReset();
    portalCarrierClose.mockReset().mockResolvedValue(undefined);
    portalCarrierOpen.mockReset().mockResolvedValue({
      connect: portalCarrierConnect,
      close: portalCarrierClose,
    });
    portalChanged.mockReset();
    sourceEnvironmentEpoch = SOURCE.ownerEpoch;
    sourceNodeDeviceId = "worker-node";
    sourceSshEndpoint = null;
    execute = createWorkerPortalToolExecutor({
      placements,
      portals: {
        getService: () =>
          ({
            open: portalOpen,
            list: portalList,
            listWorkerPortals: portalWorkerList,
            close: portalClose,
          }) as never,
        carrier: { open: portalCarrierOpen },
        onChanged: portalChanged,
      },
      environments: {
        get: (environmentId: string) =>
          environmentId === SOURCE.environmentId
            ? {
                state: "attached",
                environmentId: SOURCE.environmentId,
                ownerEpoch: sourceEnvironmentEpoch,
                attachedSessionIds: [SOURCE.sessionId],
                providerId: "fake",
                profileId: "cloud-profile",
                profileSnapshot: { install: "bundle", settings: { region: "source" } },
                nodeDeviceId: sourceNodeDeviceId,
                sshEndpoint: sourceSshEndpoint,
              }
            : undefined,
      } as never,
    });
  });

  afterEach(async () => {
    await Promise.all([...actualServices].map((service) => service.closeAll()));
    actualServices.clear();
    vi.restoreAllMocks();
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("opens, lists, and closes node-backed worker portals through the authorized source turn", async () => {
    const opened = await execute({
      identity,
      toolName: "portal",
      request: {
        toolCallId: "open-worker-portal",
        action: "open",
        port: 4321,
        title: "Worker app",
        path: "/app",
      },
    });

    expect(JSON.parse(opened.resultJson)).toMatchObject({
      details: { id: "worker-source-4321", origin: "cloud-profile", port: 4321 },
      content: [
        {
          type: "text",
          text: expect.stringContaining("PUBLIC_URL=http://127.0.0.1:54321/ and PORT=4321"),
        },
        expect.any(Object),
      ],
    });
    expect(portalCarrierOpen).toHaveBeenCalledWith({
      environmentId: SOURCE.environmentId,
      ownerEpoch: SOURCE.ownerEpoch,
      remotePort: 4321,
    });
    expect(portalOpen).toHaveBeenCalledWith({
      targetPort: 4321,
      assertCurrent: expect.any(Function),
      target: {
        kind: "worker",
        environmentId: SOURCE.environmentId,
        ownerEpoch: SOURCE.ownerEpoch,
        connect: portalCarrierConnect,
        remotePort: 4321,
      },
      onClose: portalCarrierClose,
      origin: "cloud-profile",
      title: "Worker app",
      path: "/app",
    });

    const listed = await execute({
      identity,
      toolName: "portal",
      request: { toolCallId: "list-worker-portals", action: "list" },
    });
    expect(JSON.parse(listed.resultJson).details.portals).toHaveLength(1);
    expect(portalWorkerList).toHaveBeenCalledWith(SOURCE.environmentId, SOURCE.ownerEpoch);

    const closed = await execute({
      identity,
      toolName: "portal",
      request: {
        toolCallId: "close-worker-portal",
        action: "close",
        id: "worker-source-4321",
      },
    });
    expect(JSON.parse(closed.resultJson).details).toEqual({ closed: true });
    expect(portalClose).toHaveBeenCalledWith("worker-source-4321", expect.any(Function));
    expect(portalChanged).toHaveBeenCalledTimes(2);
  });

  it("never exposes local or other-worker portal bearer URLs to a delegated worker", async () => {
    portalList.mockReturnValue([
      ...portalWorkerList(),
      { id: "local-portal", url: "http://127.0.0.1:54322/?openclaw_portal=local-secret" },
      {
        id: "foreign-worker-portal",
        url: "http://127.0.0.1:54323/?openclaw_portal=foreign-secret",
      },
    ]);
    portalWorkerList.mockClear();

    const result = await execute({
      identity,
      toolName: "portal",
      request: { toolCallId: "list-owned-worker-portals", action: "list" },
    });

    expect(JSON.parse(result.resultJson).details.portals).toEqual([
      expect.objectContaining({ id: "worker-source-4321" }),
    ]);
    expect(result.resultJson).not.toContain("local-secret");
    expect(result.resultJson).not.toContain("foreign-secret");
    expect(portalList).not.toHaveBeenCalled();
    expect(portalWorkerList).toHaveBeenCalledWith(SOURCE.environmentId, SOURCE.ownerEpoch);
  });

  it("rejects attempts to close gateway-host or other-worker portals", async () => {
    for (const id of ["local-portal", "foreign-worker-portal"]) {
      await expect(
        execute({
          identity,
          toolName: "portal",
          request: { toolCallId: `close-${id}`, action: "close", id },
        }),
      ).rejects.toThrow("Worker portal is not owned by the active environment");
    }

    expect(portalClose).not.toHaveBeenCalled();
    expect(portalWorkerList).toHaveBeenCalledTimes(2);
  });

  it("rejects stale owner epochs and replaced source placements before opening a portal", async () => {
    await expect(
      execute({
        identity: { ...identity, ownerEpoch: SOURCE.ownerEpoch + 1 },
        toolName: "portal",
        request: { toolCallId: "stale-worker-portal", action: "open", port: 4321 },
      }),
    ).rejects.toThrow("Worker source environment changed");

    placements.releaseTurn(sourceClaim);
    await expect(
      execute({
        identity,
        toolName: "portal",
        request: { toolCallId: "replaced-worker-portal", action: "open", port: 4321 },
      }),
    ).rejects.toThrow("Worker source session placement changed");
    expect(portalCarrierOpen).not.toHaveBeenCalled();
  });

  it("closes a prepared worker portal carrier when its owner epoch changes while opening", async () => {
    portalCarrierOpen.mockImplementationOnce(async () => {
      sourceEnvironmentEpoch += 1;
      return {
        connect: portalCarrierConnect,
        close: portalCarrierClose,
      };
    });

    await expect(
      execute({
        identity,
        toolName: "portal",
        request: { toolCallId: "replaced-worker-forward", action: "open", port: 4321 },
      }),
    ).rejects.toThrow("Worker source environment changed");
    expect(portalCarrierClose).toHaveBeenCalledOnce();
    expect(portalOpen).not.toHaveBeenCalled();
  });

  it("retains the environment-owned portal when its source turn closes after publication", async () => {
    const { service, httpServers } = useActualPortalService();
    portalOpen.mockImplementationOnce(async (params) => {
      const portal = await service.open(params);
      placements.releaseTurn(sourceClaim);
      return portal;
    });

    await expect(
      execute({
        identity,
        toolName: "portal",
        request: { toolCallId: "created-worker-portal", action: "open", port: 4321 },
      }),
    ).rejects.toThrow("Worker source session placement changed");

    expect(service.list()).toHaveLength(1);
    expect(httpServers[0]?.listening).toBe(true);
    expect(portalChanged).toHaveBeenCalledOnce();
    expect(portalCarrierClose).not.toHaveBeenCalled();
    await service.closeAll();
    expect(portalCarrierClose).toHaveBeenCalledOnce();
  });

  it("keeps the successor portal when the original open loses authority during listener startup", async () => {
    const actualListen = httpListen.listenGatewayHttpServer;
    let notifyBindStarted!: () => void;
    let releaseBind!: () => void;
    const bindStarted = new Promise<void>((resolve) => {
      notifyBindStarted = resolve;
    });
    const bindReleased = new Promise<void>((resolve) => {
      releaseBind = resolve;
    });
    vi.spyOn(httpListen, "listenGatewayHttpServer").mockImplementation(async (params) => {
      notifyBindStarted();
      await bindReleased;
      await actualListen(params);
    });
    const { service, httpServers } = useActualPortalService();
    const first = execute({
      identity,
      toolName: "portal",
      request: { toolCallId: "first-opening-portal", action: "open", port: 4321 },
    });
    const firstRejected = expect(first).rejects.toThrow("Worker source session placement changed");
    let successor: ReturnType<typeof execute> | undefined;
    try {
      await bindStarted;
      placements.releaseTurn(sourceClaim);
      const nextClaim = placements.claimTurn({
        sessionId: SOURCE.sessionId,
        agentId: SOURCE.agentId,
        sessionKey: SOURCE.sessionKey,
        claimId: "successor-claim",
        runId: "successor-run",
        owner: sourceClaim.owner,
      });
      placements.authorizeWorkerTurnTools(nextClaim, ["portal"]);
      successor = execute({
        identity: { ...identity, runId: nextClaim.runId, turnClaim: nextClaim },
        toolName: "portal",
        request: {
          toolCallId: "successor-opening-portal",
          action: "open",
          port: 4321,
          title: "Successor app",
        },
      });
      await vi.waitFor(() => expect(portalOpen).toHaveBeenCalledTimes(2));
      releaseBind();
      await firstRejected;
      const result = JSON.parse((await successor).resultJson);

      expect(service.list()).toEqual([
        expect.objectContaining({ id: result.details.id, title: "Successor app" }),
      ]);
      expect(httpServers).toHaveLength(1);
      expect(httpServers[0]?.listening).toBe(true);
    } finally {
      releaseBind();
      await Promise.allSettled([firstRejected, successor]);
    }
  });

  it("rejects SSH-backed placements before preparing a node portal", async () => {
    sourceNodeDeviceId = null;
    sourceSshEndpoint = { host: "worker.example" };

    await expect(
      execute({
        identity,
        toolName: "portal",
        request: { toolCallId: "ssh-worker-portal", action: "open", port: 4321 },
      }),
    ).rejects.toThrow("move the session back to the gateway with sessions.move");
    expect(portalCarrierOpen).not.toHaveBeenCalled();
  });

  it("rejects worker portal access when the active turn was not granted portal authority", async () => {
    placements.authorizeWorkerTurnTools(sourceClaim, ["sessions_send"]);

    await expect(
      execute({
        identity,
        toolName: "portal",
        request: { toolCallId: "unauthorized-worker-portal", action: "open", port: 4321 },
      }),
    ).rejects.toThrow("Worker session tool authority changed");
    expect(portalCarrierOpen).not.toHaveBeenCalled();
  });
});
