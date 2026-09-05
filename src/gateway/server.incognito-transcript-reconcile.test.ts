import fs from "node:fs";
import { expect, it } from "vitest";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { persistSessionTranscriptTurn } from "../config/sessions/session-accessor.js";
import {
  isSessionTranscriptIndexReconcileRunning,
  waitForSessionTranscriptIndexReconcile,
} from "../config/sessions/session-transcript-reconcile.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";

it("serves the reconciled incognito branch through authenticated Gateway history", async () => {
  const state = await createOpenClawTestState({
    label: "incognito-reconcile-gateway",
    env: {
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_GATEWAY_TOKEN: undefined,
      OPENCLAW_GATEWAY_PASSWORD: undefined,
    },
  });
  let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
  await runQaGatewayFixture(
    async () => {
      const cfg = {
        agents: {
          defaults: {
            workspace: state.workspaceDir,
            skipBootstrap: true,
            heartbeat: { every: "0m" },
          },
        },
        plugins: { slots: { memory: "none" } },
        tools: { profile: "minimal" },
        gateway: { auth: { mode: "token", token: "incognito-reconcile-test" } },
      } satisfies OpenClawConfig;
      gateway = await startGatewayWithClient({
        cfg,
        configPath: state.configPath,
        token: "incognito-reconcile-test",
        scopes: ["operator.admin", "operator.read", "operator.write"],
      });
      await gateway.server.startupSettled;
      const created = await gateway.client.request<{
        key: string;
        sessionId: string;
        entry: { incognito?: true };
        runStarted: boolean;
      }>("sessions.create", { agentId: "main", incognito: true });
      expect(created.entry.incognito).toBe(true);
      expect(created.runStarted).toBe(false);
      const options = {
        agentId: "main",
        path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" }),
      };
      const database = getOpenClawAgentDatabaseIfOpen(options)!;
      const projection = () =>
        database.db
          .prepare("SELECT needs_rebuild FROM session_transcript_index_state WHERE session_id = ?")
          .get(created.sessionId);
      let committedProjection: unknown;
      let scheduled = false;
      // Incognito state belongs to this process. Seed the branch through its
      // canonical writer, then exercise the authenticated public history route.
      await persistSessionTranscriptTurn(
        { agentId: "main", sessionKey: created.key, sessionId: created.sessionId },
        {
          expectedSessionId: created.sessionId,
          messages: [
            { eventId: "root", parentId: null, message: { role: "user", content: "root" } },
            {
              eventId: "abandoned",
              parentId: "root",
              message: { role: "assistant", content: "abandoned" },
            },
            {
              eventId: "active",
              parentId: "root",
              message: { role: "assistant", content: "active" },
            },
          ],
          onMessageCommitted: () => {
            committedProjection = projection();
            scheduled = isSessionTranscriptIndexReconcileRunning(options);
          },
        },
      );
      expect(committedProjection).toEqual({ needs_rebuild: 1 });
      expect(scheduled).toBe(true);
      await waitForSessionTranscriptIndexReconcile(options);
      expect(projection()).toEqual({ needs_rebuild: 0 });
      const history = await gateway.client.request<{
        sessionId: string;
        messages: Array<{ role: string; content: unknown }>;
      }>("chat.history", { agentId: "main", sessionKey: created.key, limit: 10 });
      expect(history.sessionId).toBe(created.sessionId);
      expect(history.messages.map(({ role, content }) => ({ role, content }))).toEqual([
        { role: "user", content: "root" },
        { role: "assistant", content: "active" },
      ]);
      expect(fs.existsSync(options.path)).toBe(false);
      const durable = withOpenClawAgentDatabaseReadOnly(
        ({ db }) => ({
          events: db
            .prepare("SELECT count(*) AS count FROM transcript_events WHERE session_id = ?")
            .get(created.sessionId),
          nodes: db
            .prepare("SELECT count(*) AS count FROM session_nodes WHERE session_key = ?")
            .get(created.key),
        }),
        { agentId: "main" },
      );
      expect(durable).toEqual(
        durable.found
          ? { found: true, value: { events: { count: 0 }, nodes: { count: 0 } } }
          : { found: false, reason: "database-missing" },
      );
    },
    async () => {
      if (gateway) {
        await disconnectGatewayClient(gateway.client);
      }
    },
    async () => {
      await gateway?.server.close({ reason: "incognito reconciliation test cleanup" });
    },
    () => cleanupSessionStateForTest({ stateDir: state.stateDir }),
    () => state.cleanup(),
  );
});
