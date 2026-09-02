import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import {
  sessionCatalogPaging,
  type SessionCatalogHost,
  type SessionCatalogProvider,
  type SessionCatalogSession,
} from "openclaw/plugin-sdk/session-catalog";
import { createSessionCatalogGitHubLinker } from "openclaw/plugin-sdk/session-transcript-runtime";
import { sessionShareNodeBinding } from "./config.js";
import {
  SESSION_SHARE_COMMANDS,
  SESSION_SHARE_LIST_COMMAND,
  SESSION_SHARE_READ_COMMAND,
} from "./node-commands.js";
import { parseSessionSharePage, parseSessionShareTranscriptPage } from "./wire.js";

type CatalogNode = Awaited<ReturnType<PluginRuntime["nodes"]["list"]>>["nodes"][number];
type GitHubLinker = ReturnType<typeof createSessionCatalogGitHubLinker>;
type CatalogIdentity = NonNullable<NonNullable<SessionCatalogSession["createdActor"]>["identity"]>;

function namespaceIdentity(identity: CatalogIdentity, hostId: string): CatalogIdentity {
  // The receiver owns this namespace; the wire domain is untrusted and must not alias another node.
  return identity.type === "remote" && identity.pluginId === "session-share"
    ? { ...identity, domain: hostId }
    : identity;
}

function nodeLabel(node: CatalogNode): string {
  return node.displayName?.trim() || node.remoteIp?.trim() || node.nodeId;
}

function isSessionHost(node: CatalogNode): boolean {
  return SESSION_SHARE_COMMANDS.every((command) => node.commands?.includes(command));
}

function bindSession(
  session: SessionCatalogSession,
  hostId: string,
  owner: SessionCatalogSession["createdActor"],
  linkParticipant: GitHubLinker["linkParticipant"] | undefined,
): SessionCatalogSession {
  const sourceActor = session.createdActor;
  const portable =
    sourceActor?.type === "human" &&
    (sourceActor.identity?.type === "remote" || sourceActor.identity?.type === "observation");
  const actor = !portable && owner ? owner : sourceActor;
  if (!actor?.identity) {
    return actor ? { ...session, createdActor: actor } : session;
  }
  const participant = {
    identity: namespaceIdentity(actor.identity, hostId),
    label: actor.label,
    avatarUrl: actor.avatarUrl,
  };
  const linked = portable && linkParticipant ? linkParticipant(participant) : participant;
  return {
    ...session,
    createdActor: {
      ...actor,
      ...linked,
      ...(linked.identity.type === "profile" ? { id: linked.identity.id } : {}),
    },
  };
}

export function createSessionShareCatalog(api: OpenClawPluginApi): SessionCatalogProvider {
  const bindingFor = (nodeId: string) =>
    sessionShareNodeBinding(api.runtime.config.current(), nodeId);
  const invoke = (nodeId: string, command: string, params: Record<string, unknown>) =>
    api.runtime.nodes.invoke({
      nodeId,
      command,
      params,
      timeoutMs: 30_000,
      scopes: ["operator.write"],
    });

  async function listNode(
    node: CatalogNode,
    query: Parameters<SessionCatalogProvider["list"]>[0],
  ): Promise<SessionCatalogHost> {
    const hostId = `node:${node.nodeId}`;
    const common = {
      hostId,
      label: nodeLabel(node),
      kind: "node" as const,
      nodeId: node.nodeId,
      connected: node.connected === true,
    };
    if (!node.connected) {
      return {
        ...common,
        sessions: [],
        error: { code: "NODE_OFFLINE", message: "Paired node is offline" },
      };
    }
    try {
      const cursor = query.cursors?.[hostId];
      if (cursor !== undefined) {
        sessionCatalogPaging.decodeCursor(cursor);
      }
      const raw = await invoke(node.nodeId, SESSION_SHARE_LIST_COMMAND, {
        limit: sessionCatalogPaging.boundedLimit(query.limitPerHost),
        ...(query.search ? { searchTerm: query.search } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
      });
      const page = parseSessionSharePage(raw);
      const binding = bindingFor(node.nodeId);
      const linker =
        binding.owner || binding.linkGitHubIdentities
          ? createSessionCatalogGitHubLinker()
          : undefined;
      const owner = binding.owner ? linker?.resolveOwner(binding.owner) : undefined;
      const linkParticipant = binding.linkGitHubIdentities ? linker?.linkParticipant : undefined;
      return {
        ...common,
        ...page,
        sessions: page.sessions.map((session) =>
          bindSession(session, hostId, owner, linkParticipant),
        ),
      };
    } catch {
      return {
        ...common,
        sessions: [],
        error: {
          code: "NODE_INVOKE_FAILED",
          message:
            "Cannot list OpenClaw sessions. Check the paired node's session-share configuration and connection.",
        },
      };
    }
  }

  return {
    id: "openclaw",
    label: "OpenClaw sessions",
    supportsProcessHomeIsolation: true,
    visibility: "published",
    async list(query) {
      let nodes: CatalogNode[];
      try {
        nodes = (await (query.listNodes?.() ?? api.runtime.nodes.list())).nodes;
      } catch {
        return [];
      }
      const requested = query.hostIds ? new Set(query.hostIds) : undefined;
      const eligible = nodes
        .filter(
          (node) => isSessionHost(node) && (!requested || requested.has(`node:${node.nodeId}`)),
        )
        .toSorted(
          (left, right) =>
            nodeLabel(left).localeCompare(nodeLabel(right)) ||
            left.nodeId.localeCompare(right.nodeId),
        )
        .slice(0, 32);
      return await Promise.all(
        eligible.map(async (node) => {
          const host = await listNode(node, query);
          query.onHost?.(host);
          return host;
        }),
      );
    },
    async read(request) {
      if (!request.hostId.startsWith("node:") || !request.hostId.slice(5)) {
        throw new Error("Select a paired node host to read an OpenClaw session");
      }
      const nodeId = request.hostId.slice(5);
      const node = (await api.runtime.nodes.list()).nodes.find(
        (candidate) =>
          candidate.nodeId === nodeId && candidate.connected && isSessionHost(candidate),
      );
      if (!node) {
        throw new Error(
          "OpenClaw session node is unavailable. Reconnect it and refresh the catalog.",
        );
      }
      const raw = await invoke(nodeId, SESSION_SHARE_READ_COMMAND, {
        threadId: request.threadId,
        limit: sessionCatalogPaging.boundedLimit(request.limit),
        ...(request.cursor !== undefined ? { cursor: request.cursor } : {}),
      });
      const page = parseSessionShareTranscriptPage(raw, request.threadId);
      const linkParticipant = bindingFor(nodeId).linkGitHubIdentities
        ? createSessionCatalogGitHubLinker().linkParticipant
        : undefined;
      return {
        ...page,
        hostId: request.hostId,
        label: nodeLabel(node),
        items: page.items.map((item) => {
          if (!item.sender) {
            return item;
          }
          const sender = {
            ...item.sender,
            identity: namespaceIdentity(item.sender.identity, request.hostId),
          };
          return Object.assign({}, item, { sender: linkParticipant?.(sender) ?? sender });
        }),
      };
    },
  };
}
