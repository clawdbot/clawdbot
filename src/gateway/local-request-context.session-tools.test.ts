// Exercises built-in session tools through the real in-process router and SQLite store.
import { describe, expect, it } from "vitest";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { callAgentToolGatewayRequest } from "../agents/tools/in-process-gateway.js";
import { createSessionsListTool } from "../agents/tools/sessions-list-tool.js";
import { createSessionsTool } from "../agents/tools/sessions-tool.js";
import type { CliDeps } from "../cli/deps.types.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { beginSessionWorkAdmission } from "../sessions/session-lifecycle-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { ensureGatewayOwnerProfile } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withLocalGatewayRequestScope } from "./local-request-context.js";
import {
  runWithOperatorToolGatewayCleanupContext,
  withOperatorToolGatewayAuthority,
} from "./server-plugin-in-process-dispatch.js";
import { dispatchGatewayMethodInProcess } from "./server-plugins.js";
import { roleClient, rolePolicyConfig, sharingPolicyClient } from "./session-sharing.test-utils.js";

const REQUESTER = "agent:main:dashboard:session-tools-requester";
const TARGET = "agent:main:dashboard:session-tools-target";
const TARGET_ID = "session-tools-target-id";
const INCOGNITO = "agent:main:dashboard:incognito-session-tools";

async function withSessionToolsFixture(run: (cfg: OpenClawConfig) => Promise<void>) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg: OpenClawConfig = {
      ...rolePolicyConfig(),
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "main" } },
        entries: {
          main: { workspace: state.workspaceDir },
          other: { workspace: state.path("other-workspace") },
        },
      },
      tools: { sessions: { visibility: "all" } },
    };
    await state.writeConfig(cfg);
    for (const [agentId, sessionKey, sessionId] of [
      ["main", REQUESTER, "session-tools-requester-id"],
      ["main", TARGET, TARGET_ID],
      ["main", INCOGNITO, "session-tools-incognito-id"],
      ["other", "agent:other:dashboard:session-tools-other", "session-tools-other-id"],
    ] as const) {
      await upsertSessionEntryCore(
        { agentId, sessionKey },
        {
          sessionId,
          updatedAt: 1,
          visibility: "shared",
          createdVia: "operator",
          createdActor: { type: "human", source: "profile", id: "other-person" },
        },
      );
    }
    await withLocalGatewayRequestScope({ deps: {} as CliDeps, getRuntimeConfig: () => cfg }, () =>
      run(cfg),
    );
  });
}

describe("built-in session tool role authority", () => {
  it.each([false, true])(
    "retains inherited system ownership through deferred cleanup (scoped operator: %s)",
    async (scopedOperator) => {
      await withSessionToolsFixture(async () => {
        const scope = getPluginRuntimeGatewayRequestScope();
        if (!scope) {
          throw new Error("expected local Gateway scope");
        }
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: TARGET },
          { visibility: "draft" },
        );
        const owner = ensureGatewayOwnerProfile("Owner");
        const restricted = roleClient("none");
        if (!restricted.authenticatedUserProfile) {
          throw new Error("expected operator profile");
        }
        restricted.internal = {
          operatorRoleActor: {
            kind: "operator",
            profileId: restricted.authenticatedUserProfile.profileId,
          },
        };
        const released = createDeferredCore();
        const patch = (label: string) =>
          callAgentToolGatewayRequest({
            method: "sessions.patch",
            params: { key: TARGET, expectedSessionId: TARGET_ID, label },
          });
        const handoff = await withPluginRuntimeGatewayRequestScope(
          { ...scope, ...(scopedOperator ? { client: restricted } : {}) },
          () =>
            withOperatorToolGatewayAuthority(
              {
                authenticatedUserProfile: {
                  profileId: owner.id,
                  displayName: owner.displayName,
                  hasAvatar: false,
                  updatedAt: owner.updatedAt,
                },
                operatorRoleActor: { kind: "system" },
                scopes: ["operator.write"],
              },
              async () => {
                await patch("Foreground owner");
                return {
                  pending: runWithOperatorToolGatewayCleanupContext(() =>
                    released.promise.then(() => patch("Detached owner")),
                  ),
                };
              },
            ),
        );
        expect(loadSessionEntry({ agentId: "main", sessionKey: TARGET })?.label).toBe(
          "Foreground owner",
        );
        released.resolve();
        await handoff.pending;
        expect(loadSessionEntry({ agentId: "main", sessionKey: TARGET })?.label).toBe(
          "Detached owner",
        );
      });
    },
  );

  it.each([false, true])(
    "commits self-archive after caller closure (operator: %s)",
    async (operator) => {
      await withSessionToolsFixture(async (cfg) => {
        const context = getPluginRuntimeGatewayRequestScope()?.context;
        if (!context) {
          throw new Error("expected local Gateway context");
        }
        const archived = createDeferredCore();
        context.subscribeSessionEvents("self-archive-proof");
        context.broadcastToConnIds = (event, payload) => {
          if (event === "sessions.changed") {
            expect(payload).toMatchObject({ sessionKey: REQUESTER });
            archived.resolve();
          }
        };
        const sessionId = "session-tools-requester-id";
        const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId: "main" });
        const admission = await beginSessionWorkAdmission({
          scope: storePath,
          identities: [REQUESTER, sessionId],
          assertAllowed: () => {},
        });
        let current = true;
        try {
          const archive = () =>
            withGatewayToolCallerIdentity(
              {
                agentId: "main",
                sessionKey: REQUESTER,
                operationalRunInstance: { instanceId: "archive-instance", runId: "archive-run" },
                receiptAuthority: () => current,
                gatewayContextResolver: () => context,
              },
              () =>
                admission.run(() =>
                  createSessionsTool({
                    config: cfg,
                    agentSessionKey: REQUESTER,
                    agentSessionId: sessionId,
                  }).execute("archive-self", { action: "patch", archived: true }),
                ),
            );
          const client = roleClient("write");
          if (!client.authenticatedUserProfile) {
            throw new Error("expected operator profile");
          }
          const result = await (operator
            ? withOperatorToolGatewayAuthority(
                {
                  authenticatedUserProfile: client.authenticatedUserProfile,
                  scopes: client.connect.scopes ?? [],
                },
                archive,
              )
            : archive());
          expect(result.details).toMatchObject({ status: "scheduled", sessionKey: REQUESTER });
          expect(
            loadSessionEntry({ agentId: "main", sessionKey: REQUESTER })?.archivedAt,
          ).toBeUndefined();
        } finally {
          current = false;
          admission.release();
        }
        await archived.promise;
        expect(loadSessionEntry({ agentId: "main", sessionKey: REQUESTER })).toMatchObject({
          sessionId,
          archivedAt: expect.any(Number),
        });
      });
    },
  );

  it.each(["sessions.patch", "sessions.patchMany", "sessions.assignOwner"])(
    "%s does not commit when its caller closes during request authorization",
    async (method) => {
      await withSessionToolsFixture(async (cfg) => {
        const context = getPluginRuntimeGatewayRequestScope()?.context;
        if (!context) {
          throw new Error("expected local Gateway context");
        }
        const patchParams = (label: string) =>
          method === "sessions.patch"
            ? { key: TARGET, label }
            : method === "sessions.patchMany"
              ? { targets: [{ key: TARGET }], patch: { label } }
              : { key: TARGET, owner: { type: "agent", id: label } };
        const before = method === "sessions.assignOwner" ? "main" : "Before closure";
        const after = method === "sessions.assignOwner" ? "other" : "After closure";
        const request = (value: string) =>
          callAgentToolGatewayRequest({
            method,
            params: patchParams(value),
            agentToolCaller: { agentId: "main", sessionKey: REQUESTER },
          });
        const persisted = () => {
          const entry = loadSessionEntry({ agentId: "main", sessionKey: TARGET });
          return method === "sessions.assignOwner" ? entry?.owner?.actor.id : entry?.label;
        };
        await request(before);
        expect(persisted()).toBe(before);
        let current = true;
        // Authorization reads the live config after dispatch has yielded. Close
        // the run there and verify the real SQLite writer still refuses the patch.
        context.getRuntimeConfig = () => {
          current = false;
          return cfg;
        };
        await expect(
          withGatewayToolCallerIdentity(
            {
              agentId: "main",
              sessionKey: REQUESTER,
              operationalRunInstance: { instanceId: "patch-instance", runId: "patch-run" },
              receiptAuthority: () => current,
            },
            () => request(after),
          ),
        ).rejects.toThrow(/authority.*no longer active/i);
        expect(persisted()).toBe(before);
      });
    },
  );

  it("lists then archives a visible session through built-in tools with roles enabled", async () => {
    await withSessionToolsFixture(async (cfg) => {
      const options = { config: cfg, agentSessionKey: REQUESTER };
      const listed = await createSessionsListTool(options).execute("discover", {});
      // Keep archive in the same reproduction even if discovery regresses to an empty result.
      expect.soft(listed.details).toMatchObject({
        count: 3,
        sessions: expect.arrayContaining([
          expect.objectContaining({ key: REQUESTER }),
          expect.objectContaining({ key: TARGET, sessionId: TARGET_ID }),
          expect.objectContaining({ key: "agent:other:dashboard:session-tools-other" }),
        ]),
      });
      await expect(
        createSessionsTool(options).execute("archive", {
          action: "patch",
          sessionKey: TARGET,
          expectedSessionId: TARGET_ID,
          archived: true,
        }),
      ).resolves.toMatchObject({ details: { status: "updated", sessionKey: TARGET } });
      expect(loadSessionEntry({ agentId: "main", sessionKey: TARGET })).toMatchObject({
        sessionId: TARGET_ID,
        archivedAt: expect.any(Number),
      });
      const archived = await createSessionsListTool(options).execute("verify", {
        archived: true,
      });
      expect(archived.details).toMatchObject({
        count: 1,
        sessions: [expect.objectContaining({ key: TARGET, archived: true })],
      });
    });
  });

  it("keeps tool visibility and incognito boundaries under system-backed dispatch", async () => {
    await withSessionToolsFixture(async (cfg) => {
      const options = {
        config: { ...cfg, tools: { sessions: { visibility: "self" as const } } },
        agentSessionKey: REQUESTER,
      };
      const listed = await createSessionsListTool(options).execute("discover-self", {});
      expect(listed.details).toMatchObject({
        count: 1,
        sessions: [expect.objectContaining({ key: REQUESTER })],
      });
      await expect(
        createSessionsTool(options).execute("denied-foreign", {
          action: "patch",
          sessionKey: TARGET,
          expectedSessionId: TARGET_ID,
          archived: true,
        }),
      ).rejects.toThrow(/visibility|restricted|not visible/i);
      await expect(
        createSessionsTool({ config: cfg, agentSessionKey: REQUESTER }).execute(
          "denied-incognito",
          { action: "patch", sessionKey: INCOGNITO, pinned: true },
        ),
      ).rejects.toThrow(/not visible/i);
      expect(loadSessionEntry({ agentId: "main", sessionKey: TARGET })?.archivedAt).toBeUndefined();
    });
  });

  it("does not grant system authority to an unknown synthetic caller or override a scoped reader", async () => {
    await withSessionToolsFixture(async (cfg) => {
      const unknown = await dispatchGatewayMethodInProcess<{ sessions: unknown[] }>(
        "sessions.list",
        { agentId: "main" },
        { forceSyntheticClient: true, syntheticScopes: ["operator.read"] },
      );
      expect(unknown.sessions).toEqual([]);
      await expect(
        dispatchGatewayMethodInProcess(
          "sessions.patch",
          { key: TARGET, expectedSessionId: TARGET_ID, archived: true },
          { forceSyntheticClient: true, syntheticScopes: ["operator.write"] },
        ),
      ).rejects.toThrow(/not found/i);
      await expect(
        callAgentToolGatewayRequest({
          method: "sessions.patch",
          params: { key: TARGET, expectedSessionId: TARGET_ID, archived: true },
          scopes: ["operator.read"],
        }),
      ).rejects.toThrow(/missing scope: operator.write/i);

      const scope = getPluginRuntimeGatewayRequestScope();
      if (!scope) {
        throw new Error("expected local Gateway scope");
      }
      await withPluginRuntimeGatewayRequestScope(
        {
          ...scope,
          client: sharingPolicyClient({ user: "reader-profile", scopes: ["operator.read"] }),
        },
        async () => {
          await expect(
            createSessionsTool({ config: cfg, agentSessionKey: REQUESTER }).execute(
              "denied-reader",
              {
                action: "patch",
                sessionKey: TARGET,
                expectedSessionId: TARGET_ID,
                archived: true,
              },
            ),
          ).rejects.toThrow(/missing scope: operator.write/i);
        },
      );
      expect(loadSessionEntry({ agentId: "main", sessionKey: TARGET })?.archivedAt).toBeUndefined();
    });
  });
});
