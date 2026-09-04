import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import { NODE_DESKTOP_STREAM_COMMAND } from "../../shared/node-desktop-stream.js";
import { isNodeCommandAllowed, resolveNodeCommandAllowlist } from "../node-command-policy.js";
import type { NodeRegistry, NodeSession } from "../node-registry.js";
import { DesktopCredentialsRequiredError } from "./host-source-errors.js";
import type { NodeDesktopStreamBroker } from "./node-stream-broker.js";
import { mintDesktopObserverToken } from "./observe-bridge.js";
import type { DesktopSessionRegistry } from "./session-registry.js";

type NodeDesktopObserveResult = {
  transport: "rfb";
  wsPath: string;
  expiresAtMs: number;
  control: boolean;
  auth: "vnc-password" | "ard-account";
  preauthenticated: true;
};

function invocationError(result: Awaited<ReturnType<NodeRegistry["invoke"]>>): Error {
  const message = result.error?.message?.trim();
  return new Error(message || "node desktop stream closed before attachment");
}

type ActiveNodeDesktopStream = {
  controller: AbortController;
  ticket?: ReturnType<NodeDesktopStreamBroker["mint"]>;
  stream?: import("node:stream").Duplex;
  invocation?: ReturnType<NodeRegistry["invoke"]>;
  reservation?: ReturnType<DesktopSessionRegistry["reserveObserver"]>;
  reservationTransferred: boolean;
  unclaimedTimer?: ReturnType<typeof setTimeout>;
  stopped: boolean;
};

type NodeDesktopSession = {
  connId: string;
  pairingGeneration: string;
  ownerEpoch: number;
  active: Set<ActiveNodeDesktopStream>;
};

async function stopActiveStream(active: ActiveNodeDesktopStream): Promise<void> {
  if (active.stopped) {
    return;
  }
  retireActiveStream(active);
  await active.invocation?.catch(() => undefined);
}

function retireActiveStream(active: ActiveNodeDesktopStream): void {
  if (active.stopped) {
    return;
  }
  active.stopped = true;
  clearTimeout(active.unclaimedTimer);
  active.ticket?.cancel();
  active.controller.abort();
  if (!active.reservationTransferred) {
    active.reservation?.release();
  }
  active.stream?.destroy();
}

/** Combines node command policy, ticket redemption, and desktop session ownership. */
export function createNodeDesktopService(params: {
  getConfig: () => OpenClawConfig;
  nodeRegistry: NodeRegistry;
  desktopRegistry: DesktopSessionRegistry;
  streamBroker: NodeDesktopStreamBroker;
}) {
  const ownerEpochs = new Map<string, number>();
  const sessions = new Map<string, NodeDesktopSession>();

  const commandAllowed = (node: NodeSession) =>
    isNodeCommandAllowed({
      command: NODE_DESKTOP_STREAM_COMMAND,
      declaredCommands: node.commands,
      allowlist: resolveNodeCommandAllowlist(params.getConfig(), node),
    }).ok;

  const stopNode = async (nodeId: string): Promise<void> => {
    const session = sessions.get(nodeId);
    if (session) {
      await params.desktopRegistry.stop(`node:${nodeId}`, session.ownerEpoch);
    }
  };

  const ensureSession = async (request: {
    nodeId: string;
    connId: string;
    pairingGeneration: string;
  }): Promise<NodeDesktopSession> => {
    const sourceKey = `node:${request.nodeId}`;
    const current = sessions.get(request.nodeId);
    if (
      current?.connId === request.connId &&
      current.pairingGeneration === request.pairingGeneration
    ) {
      await params.desktopRegistry.activate({
        sourceKey,
        ownerEpoch: current.ownerEpoch,
      });
      return current;
    }

    const ownerEpoch = (ownerEpochs.get(request.nodeId) ?? 0) + 1;
    ownerEpochs.set(request.nodeId, ownerEpoch);
    const session: NodeDesktopSession = {
      connId: request.connId,
      pairingGeneration: request.pairingGeneration,
      ownerEpoch,
      active: new Set(),
    };
    sessions.set(request.nodeId, session);
    try {
      await params.desktopRegistry.activate({
        sourceKey,
        ownerEpoch,
        teardown: async () => {
          if (sessions.get(request.nodeId) === session) {
            sessions.delete(request.nodeId);
          }
          await Promise.all([...session.active].map(stopActiveStream));
          session.active.clear();
        },
      });
      return session;
    } catch (error) {
      if (sessions.get(request.nodeId) === session) {
        sessions.delete(request.nodeId);
      }
      throw error;
    }
  };

  return {
    stopNode,
    async reconcileRuntimePolicy(): Promise<void> {
      await Promise.all(
        [...sessions].map(async ([nodeId, session]) => {
          const node = params.nodeRegistry.get(nodeId);
          if (
            !node ||
            node.connId !== session.connId ||
            node.pairingGeneration !== session.pairingGeneration ||
            !commandAllowed(node)
          ) {
            await stopNode(nodeId);
          }
        }),
      );
    },
    async observe(request: {
      nodeId: string;
      control: boolean;
      credentials?: { username?: string; password?: string };
    }): Promise<NodeDesktopObserveResult> {
      const node = params.nodeRegistry.get(request.nodeId);
      if (!node?.pairingGeneration) {
        throw new Error("node desktop is unavailable; reconnect and approve the node capability");
      }
      const pairingGeneration = node.pairingGeneration;
      const isAuthorized = () =>
        params.nodeRegistry.get(request.nodeId) === node &&
        node.pairingGeneration === pairingGeneration &&
        commandAllowed(node);
      const assertAuthorized = () => {
        if (!isAuthorized()) {
          throw new Error(
            "node desktop is not enabled; explicitly allow and approve desktop.stream for this node",
          );
        }
      };
      assertAuthorized();

      const sourceKey = `node:${request.nodeId}`;
      const session = await ensureSession({
        nodeId: request.nodeId,
        connId: node.connId,
        pairingGeneration,
      });
      assertAuthorized();
      const active: ActiveNodeDesktopStream = {
        controller: new AbortController(),
        reservation: params.desktopRegistry.reserveObserver(sourceKey, session.ownerEpoch),
        reservationTransferred: false,
        stopped: false,
      };
      if (!active.reservation) {
        throw new Error("node desktop observer limit reached");
      }
      session.active.add(active);
      try {
        active.ticket = params.streamBroker.mint({
          nodeId: request.nodeId,
          connId: node.connId,
          pairingGeneration,
        });
        active.invocation = params.nodeRegistry.invoke({
          nodeId: request.nodeId,
          expectedConnId: node.connId,
          expectedPairingGeneration: pairingGeneration,
          command: NODE_DESKTOP_STREAM_COMMAND,
          params: { ticket: active.ticket.ticket, attachPath: active.ticket.attachPath },
          timeoutMs: 0,
          onProgress: () => {},
          signal: active.controller.signal,
          // Pairing resolution yields before dispatch. Recheck this exact desktop
          // owner and live command policy at the transport's final admission edge.
          isDispatchAuthorized: () =>
            !active.stopped && sessions.get(request.nodeId) === session && isAuthorized(),
        });
        const invocationFinished = active.invocation.then((result) => {
          throw invocationError(result);
        });
        void invocationFinished.catch(() => undefined);

        const attached = await Promise.race([active.ticket.attached, invocationFinished]);
        if (active.stopped || sessions.get(request.nodeId) !== session) {
          attached.stream.destroy();
          throw new Error("node desktop session was superseded before attachment");
        }
        active.stream = attached.stream;
        assertAuthorized();

        let password: string | undefined;
        if (attached.auth === "vnc-password") {
          password = attached.vncPassword ?? request.credentials?.password;
          if (!password) {
            throw new DesktopCredentialsRequiredError(
              "vnc-password",
              "VNC password is required to observe this node",
            );
          }
          registerSecretValueForRedaction(password);
        } else {
          const username = request.credentials?.username?.trim() ?? "";
          const ardPassword = request.credentials?.password ?? "";
          if (!username || !ardPassword) {
            throw new DesktopCredentialsRequiredError(
              "ard-account",
              "macOS account credentials are required to observe this node",
            );
          }
          registerSecretValueForRedaction(ardPassword);
        }

        const attachment = params.desktopRegistry.publishStream({
          sourceKey,
          ownerEpoch: session.ownerEpoch,
          stream: attached.stream,
          reservation: active.reservation,
        });
        if (!attachment) {
          throw new Error("node desktop session was superseded before publication");
        }
        active.reservationTransferred = true;
        const credentials = request.credentials;
        const preauth =
          attached.auth === "ard-account"
            ? {
                auth: attached.auth,
                credentials: {
                  username: credentials?.username?.trim() ?? "",
                  password: credentials?.password ?? "",
                },
              }
            : {
                auth: attached.auth,
                credentials: { password: password ?? credentials?.password ?? "" },
              };
        const minted = mintDesktopObserverToken({
          sourceKey,
          ownerEpoch: session.ownerEpoch,
          control: request.control,
          attachment,
          preauth,
        });
        active.unclaimedTimer = setTimeout(
          () => {
            if (params.desktopRegistry.hasPendingStream(attachment)) {
              void stopActiveStream(active).then(() => session.active.delete(active));
            }
          },
          Math.max(0, minted.expiresAtMs - Date.now()),
        );
        active.unclaimedTimer.unref?.();
        void active.invocation
          .finally(() => {
            retireActiveStream(active);
            session.active.delete(active);
          })
          .catch(() => undefined);
        return {
          transport: "rfb",
          wsPath: `/desktop/observe?token=${minted.token}`,
          expiresAtMs: minted.expiresAtMs,
          control: request.control,
          auth: attached.auth,
          preauthenticated: true,
        };
      } catch (error) {
        await stopActiveStream(active);
        session.active.delete(active);
        throw error;
      }
    },
  };
}

export type NodeDesktopService = ReturnType<typeof createNodeDesktopService>;
