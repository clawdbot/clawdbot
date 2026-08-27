import fs from "node:fs/promises";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createSessionCatalogAdoptionCoordinator } from "openclaw/plugin-sdk/session-catalog";
import { CLAUDE_CLI_BACKEND_ID, CLAUDE_CLI_DEFAULT_MODEL_REF } from "./cli-constants.js";
import {
  adoptedSessionKey,
  adoptedSourceKey,
  CLAUDE_LOCAL_SESSION_HOST_ID,
} from "./session-catalog-adoption.js";
import { type CatalogRecord, listClaudeSessions } from "./session-catalog-discovery.js";
import { importClaudeHistory } from "./session-catalog-history.js";
import {
  readBoundedClaudeHistory,
  readClaudeSessionTranscript,
  resolveNodeClaudeRecord,
} from "./session-catalog-listing.js";
import {
  currentClaudeSessionCatalogConfig,
  listBoundClaudeSessions,
  resolveClaudeCliRoutedModelId,
} from "./session-catalog-runtime.js";
import { currentHomeDir, gatewayClaudeScanOptions } from "./session-catalog-scan.js";
import {
  CLAUDE_CLI_NODE_RUN_COMMAND,
  CLAUDE_SESSION_READ_COMMAND,
  CLAUDE_SESSIONS_LIST_COMMAND,
  ClaudeCatalogParamsError,
  isResumableClaudeSource,
} from "./session-catalog-shared.js";
import type { ClaudeTranscriptItem } from "./session-catalog-transcript.js";
import type { ClaudeSessionCatalogSession } from "./session-catalog-types.js";
import * as upstream from "./session-upstream-activity.js";

const continueClaudeAdoption =
  createSessionCatalogAdoptionCoordinator<Awaited<ReturnType<typeof upstream.linkContinued>>>();

export async function continueClaudeSession(
  api: OpenClawPluginApi,
  agentId: string,
  hostId: string,
  threadId: string,
  allowProcessHomeFallback?: boolean,
): Promise<{ sessionKey: string }> {
  const scanOptions = gatewayClaudeScanOptions(allowProcessHomeFallback);
  const sourceKey = adoptedSourceKey(hostId, threadId);
  const operationKey = `${agentId}\0${sourceKey}`;
  const linkSession = async (sessionKey: string, history?: ClaudeTranscriptItem[]) =>
    await upstream.linkContinued({
      sessionKey,
      hostId,
      threadId,
      ...(history ? { history } : {}),
      listLocalSessions: () => listClaudeSessions(currentHomeDir(), scanOptions),
      readRemote: async () =>
        (
          await readClaudeSessionTranscript({
            runtime: api.runtime,
            hostId,
            threadId,
            limit: 1,
            allowProcessHomeFallback,
          })
        ).items,
    });
  const existing = listBoundClaudeSessions(api, agentId).get(sourceKey);
  if (existing) {
    return await linkSession(existing);
  }
  let history: ClaudeTranscriptItem[] | undefined;
  return await continueClaudeAdoption({
    sourceKey: operationKey,
    findExisting: () => listBoundClaudeSessions(api, agentId).get(sourceKey),
    create: async () => {
      let nodeId: string | undefined;
      let record: ClaudeSessionCatalogSession | undefined;
      if (hostId === CLAUDE_LOCAL_SESSION_HOST_ID) {
        record = (await listClaudeSessions(currentHomeDir(), scanOptions)).find(
          (candidate) => candidate.threadId === threadId,
        );
        if (!record || !isResumableClaudeSource(record.source)) {
          throw new ClaudeCatalogParamsError("only local Claude Code sessions can be continued");
        }
      } else if (hostId.startsWith("node:")) {
        nodeId = hostId.slice("node:".length);
        const node = (await api.runtime.nodes.list()).nodes.find(
          (candidate) =>
            candidate.nodeId === nodeId &&
            candidate.connected === true &&
            candidate.commands?.includes(CLAUDE_SESSIONS_LIST_COMMAND) &&
            candidate.commands.includes(CLAUDE_SESSION_READ_COMMAND) &&
            candidate.commands.includes(CLAUDE_CLI_NODE_RUN_COMMAND) &&
            candidate.invocableCommands?.includes(CLAUDE_SESSIONS_LIST_COMMAND) === true &&
            candidate.invocableCommands.includes(CLAUDE_SESSION_READ_COMMAND) &&
            candidate.invocableCommands.includes(CLAUDE_CLI_NODE_RUN_COMMAND),
        );
        if (!node) {
          throw new ClaudeCatalogParamsError(
            "paired node does not permit Claude CLI session continuation",
          );
        }
        // Node rows stay CLI-only: desktop transcripts on nodes have no
        // node-side run command and remain view-only.
        record = await resolveNodeClaudeRecord({ runtime: api.runtime, nodeId, threadId });
        if (!record || record.source !== "claude-cli") {
          throw new ClaudeCatalogParamsError("only Claude CLI sessions can be continued");
        }
      } else {
        throw new ClaudeCatalogParamsError("hostId is invalid");
      }
      if (hostId === CLAUDE_LOCAL_SESSION_HOST_ID) {
        const source = await fs.stat((record as CatalogRecord).filePath).catch(() => undefined);
        if (!source?.isFile()) {
          throw new ClaudeCatalogParamsError("Claude session transcript is unavailable");
        }
      }
      // Narrowed local: afterCreate below needs a definite array, while the outer
      // `history` stays optional so complete() can link without a reread on races.
      const loadedHistory = await readBoundedClaudeHistory({
        runtime: api.runtime,
        hostId,
        threadId,
        allowProcessHomeFallback,
      });
      history = loadedHistory;
      const config = currentClaudeSessionCatalogConfig(api);
      const adoptingAgentId = agentId;
      // Adopt onto the model this agent actually routes to the CLI backend; the
      // packaged default may not be routed or allowed in an existing config.
      const model =
        resolveClaudeCliRoutedModelId(config, adoptingAgentId) ??
        CLAUDE_CLI_DEFAULT_MODEL_REF.slice(`${CLAUDE_CLI_BACKEND_ID}/`.length);
      const marker = {
        sourceThreadId: threadId,
        ...(hostId !== CLAUDE_LOCAL_SESSION_HOST_ID ? { sourceHostId: hostId } : {}),
      };
      const created = await api.runtime.agent.session.createSessionEntry({
        cfg: config,
        key: adoptedSessionKey(hostId, threadId),
        agentId: adoptingAgentId,
        recoverMatchingInitialEntry: true,
        ...(record.name ? { label: record.name } : {}),
        ...(record.cwd ? { spawnedCwd: record.cwd } : {}),
        ...(nodeId ? { execNode: nodeId, ...(record.cwd ? { execCwd: record.cwd } : {}) } : {}),
        initialEntry: {
          cliBackendId: CLAUDE_CLI_BACKEND_ID,
          model,
          modelSelectionLocked: true,
          pluginOwnerId: api.id,
          cliSessionBinding: { sessionId: threadId, forceReuse: true, forkNextResume: true },
          pluginExtensions: { anthropic: { sessionCatalog: marker } },
        },
        afterCreate: async (entry) => {
          await importClaudeHistory({
            items: loadedHistory,
            threadId,
            sessionId: entry.sessionId,
            sessionKey: entry.key,
            agentId: entry.agentId,
            storePath: api.runtime.agent.session.resolveStorePath(config.session?.store, {
              agentId: entry.agentId,
            }),
            ...(record.cwd ? { cwd: record.cwd } : {}),
            config,
          });
          return { pluginExtensions: { anthropic: { sessionCatalog: marker } } };
        },
      });
      return { sessionKey: created.key };
    },
    complete: async (continued) => await linkSession(continued.sessionKey, history),
  });
}
