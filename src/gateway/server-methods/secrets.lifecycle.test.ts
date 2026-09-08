import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import { resetPendingAskUserQuestionsForTest } from "../../agents/tools/ask-user-tool.test-support.js";
import { createSecretsTool } from "../../agents/tools/secrets-tool.js";
import {
  claimAgentRunDelegatedAuthority,
  clearAgentRunContext,
  releaseAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import {
  activateSecretsRuntimeSnapshot,
  clearSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshot,
  prepareSecretsRuntimeSnapshot,
} from "../../secrets/runtime.js";
import {
  listSecretStoreEntries,
  readSecretStoreValue,
  writeSecretStoreEntry,
} from "../../secrets/store/secret-store.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-identity-token.js";
import { QuestionManager } from "../question-manager.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { createQuestionHandlers } from "./question.js";
import { createSecretsHandlers, createSecretStoreWriteService } from "./secrets.js";
import type { GatewayClient, RespondFn } from "./types.js";

afterEach(() => {
  clearSecretsRuntimeSnapshot();
  resetPendingAskUserQuestionsForTest();
  vi.restoreAllMocks();
});

async function invoke(
  handlers: ReturnType<typeof createSecretsHandlers>,
  method: string,
  params: Record<string, unknown>,
  client: GatewayClient | null = null,
) {
  const responses: Parameters<RespondFn>[] = [];
  await handlers[method]!({
    req: { type: "req", id: "store-rpc", method },
    params,
    client,
    respond: (...args) => {
      responses.push(args);
    },
    isWebchatConnect: () => false,
    context: createDirectChatContext({
      validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
    }),
  });
  return responses[0];
}

const resolveSecrets = async () => ({ assignments: [], diagnostics: [], inactiveRefPaths: [] });

describe("secret store mutation lifecycle", () => {
  it.each(["dispatch continuation", "mutation logging"] as const)(
    "does not delete when admitted authority closes during %s",
    async (closure) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const name = "SYNTHETIC_DELETE_KEY";
        const value = "test-secret-delete-must-survive";
        writeSecretStoreEntry({
          scope: { kind: "team" },
          name,
          value,
          kind: "secret",
          updatedBy: "test",
        });
        const authority = claimAgentRunDelegatedAuthority({
          instanceId: "delete-instance",
          runId: "delete-run",
        });
        const identity = {
          kind: "agentRuntime" as const,
          agentId: "main",
          sessionKey: "agent:main:main",
          operationalRunInstance: authority.operationalRunInstance,
          delegatedAuthority: { kind: "local" as const, ...authority },
        };
        const client = { internal: { agentRuntimeIdentity: identity } } as GatewayClient;
        const reloadSecrets = vi.fn(async () => ({ warningCount: 0 }));
        const handlers = createSecretsHandlers({
          reloadSecrets,
          resolveSecrets,
          storeWriteService: createSecretStoreWriteService({ reloadSecrets }),
          log: {
            debug: () => {
              if (closure === "mutation logging") {
                releaseAgentRunDelegatedAuthority(authority);
              }
            },
          },
        });
        try {
          expect(createAgentRuntimeApprovalAuthorityValidator()(identity)).toBe(true);
          const dispatched = Promise.resolve().then(() =>
            invoke(handlers, "secrets.store.delete", { name }, client),
          );
          if (closure === "dispatch continuation") {
            releaseAgentRunDelegatedAuthority(authority);
          }
          expect(await dispatched).toMatchObject([false, undefined, { code: "INVALID_REQUEST" }]);
          expect(readSecretStoreValue({ scope: { kind: "team" }, name })).toEqual({
            ok: true,
            value,
          });
          expect(reloadSecrets).not.toHaveBeenCalled();
          // A normal human administrator has no delegated run claim to revoke.
          expect(await invoke(handlers, "secrets.store.delete", { name })).toMatchObject([
            true,
            { ok: true },
          ]);
          expect(readSecretStoreValue({ scope: { kind: "team" }, name }).ok).toBe(false);
        } finally {
          releaseAgentRunDelegatedAuthority(authority);
          clearAgentRunContext("delete-run");
        }
      });
    },
  );

  it("reports only committed safe facts when the operator replaces proposed hosts", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const authority = claimAgentRunDelegatedAuthority({
        instanceId: "tool-instance",
        runId: "tool-run",
      });
      const client = {
        connect: { scopes: ["operator.admin"] },
        internal: {
          agentRuntimeIdentity: {
            kind: "agentRuntime",
            agentId: "main",
            sessionKey: "agent:main:main",
            operationalRunInstance: authority.operationalRunInstance,
            delegatedAuthority: { kind: "local", ...authority },
          },
        },
      } as GatewayClient;
      const manager = new QuestionManager();
      const reloadSecrets = async () => ({ warningCount: 0 });
      const storeWriteService = createSecretStoreWriteService({ reloadSecrets });
      const handlers = {
        ...createQuestionHandlers(manager, storeWriteService),
        ...createSecretsHandlers({ reloadSecrets, resolveSecrets, storeWriteService }),
      };
      const methods: string[] = [];
      try {
        const tool = createSecretsTool({
          agentId: "main",
          sessionKey: "agent:main:main",
          runId: "tool-run",
          gatewayCall: async (method, _options, params) => {
            methods.push(method);
            const response = await invoke(
              handlers,
              method,
              params as Record<string, unknown>,
              client,
            );
            if (!response?.[0]) {
              throw new Error("synthetic question RPC failed");
            }
            if (method === "question.request") {
              const { id } = response[1] as { id: string };
              expect(
                await invoke(handlers, "question.resolve", {
                  id,
                  answers: { answers: { secret_value: ["test-secret-operator-only"] } },
                  secretStoreAllowedHosts: ["approved.example.test"],
                }),
              ).toMatchObject([true, { status: "answered" }, undefined]);
            }
            return response[1];
          },
        });
        const result = await tool.execute("policy-change", {
          action: "request",
          name: "APPROVED_POLICY_KEY",
          allowedHosts: ["proposed.example.test"],
        });
        expect(listSecretStoreEntries({ scope: { kind: "team" } })).toMatchObject([
          { name: "APPROVED_POLICY_KEY", allowedHosts: ["approved.example.test"] },
        ]);
        expect(result.details).toEqual({
          status: "stored",
          name: "APPROVED_POLICY_KEY",
          kind: "secret",
          ref: { source: "store", provider: "default", id: "APPROVED_POLICY_KEY" },
          currentPolicy: { status: "available", allowedHosts: ["approved.example.test"] },
        });
        expect(JSON.stringify(result)).not.toContain("proposed.example.test");
        expect(JSON.stringify(result)).not.toContain("test-secret-operator-only");
        expect(methods).toEqual(["question.request", "question.waitAnswer", "secrets.store.list"]);
      } finally {
        manager.close();
        releaseAgentRunDelegatedAuthority(authority);
        clearAgentRunContext("tool-run");
      }
    });
  });

  it.each(["api_key", "token"] as const)(
    "refreshes an auth-profile-only %s ref on create, rotation, and delete",
    async (type) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const name = "AUTH_PROFILE_ONLY_KEY";
        const ref = { source: "store", provider: "default", id: name } as const;
        const profileId = "custom:store";
        const store: AuthProfileStore = {
          version: 1,
          profiles: {
            [profileId]:
              type === "api_key"
                ? { type, provider: "custom", keyRef: ref }
                : { type, provider: "custom", tokenRef: ref },
          },
        };
        const runtimeOptions = {
          config: {},
          env: { OPENCLAW_STATE_DIR: state.stateDir },
          agentDirs: [state.agentDir()],
          includeConfigRefs: false,
          loadAuthStore: () => store,
          manifestRegistry: { plugins: [] },
          allowUnavailableSecretOwners: true,
        };
        activateSecretsRuntimeSnapshot(await prepareSecretsRuntimeSnapshot(runtimeOptions));
        const currentCredential = () => {
          const profile =
            getActiveSecretsRuntimeSnapshot()?.authStores[0]?.store.profiles[profileId];
          return profile?.type === "api_key"
            ? profile.key
            : profile?.type === "token"
              ? profile.token
              : undefined;
        };
        const expectCold = () => {
          expect(currentCredential()).toBeUndefined();
          expect(getActiveSecretsRuntimeSnapshot()?.degradedOwners).toMatchObject([
            { ownerKind: "account", degradationState: "cold" },
          ]);
        };
        expectCold();
        const reloadSecrets = vi.fn(
          async (options?: { forceColdRefKeys?: ReadonlySet<string> }) => {
            const snapshot = await prepareSecretsRuntimeSnapshot({
              ...runtimeOptions,
              forceColdRefKeys: options?.forceColdRefKeys,
            });
            activateSecretsRuntimeSnapshot(snapshot);
            return { warningCount: snapshot.warnings.length };
          },
        );
        const handlers = createSecretsHandlers({
          reloadSecrets,
          resolveSecrets,
          storeWriteService: createSecretStoreWriteService({ reloadSecrets }),
        });
        for (const value of ["test-secret-created", "test-secret-rotated"]) {
          expect(
            await invoke(handlers, "secrets.store.set", { name, value, kind: "secret" }),
          ).toMatchObject([true, { ok: true, reloaded: true }]);
          expect(currentCredential()).toBe(value);
        }
        expect(reloadSecrets).toHaveBeenLastCalledWith({
          forceColdRefKeys: new Set([`store:default:${name}`]),
          joinInFlight: false,
        });
        expect(await invoke(handlers, "secrets.store.delete", { name })).toMatchObject([
          true,
          { ok: true, reloaded: true },
        ]);
        expectCold();
        expect(reloadSecrets).toHaveBeenCalledTimes(3);
        // Environment entries remain an operator-owned write path, and unrelated
        // names must not refresh every auth profile on the Gateway.
        expect(
          await invoke(handlers, "secrets.store.set", {
            name: "UNRELATED_SETTING",
            value: "enabled",
            kind: "env",
          }),
        ).toMatchObject([true, { ok: true, reloaded: false }]);
        expect(reloadSecrets).toHaveBeenCalledTimes(3);
        expect(
          readSecretStoreValue({ scope: { kind: "team" }, name: "UNRELATED_SETTING" }),
        ).toEqual({ ok: true, value: "enabled" });
        clearSecretsRuntimeSnapshot();
      });
    },
  );
});
