import { describe, expect, it, vi } from "vitest";
import type { AgentRuntimeIdentity } from "../../gateway/agent-runtime-identity-token.js";
import {
  getCronManagementAuthority,
  withCronManagementGrant,
} from "../../gateway/cron-creator-authority-grant.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { createTestAdmittedRunContext } from "../admitted-run-context.test-support.js";
import {
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
} from "../cron-creator-authority-context.js";
import { createCronTool } from "./cron-tool.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "./gateway-caller-context.js";

async function withAdminTool(
  origin: "local" | "unknown",
  run: (fixture: {
    tool: ReturnType<typeof createCronTool>;
    calls: Array<{ method: string; params: unknown }>;
    resolveCreator: ReturnType<typeof vi.fn>;
  }) => Promise<void>,
  currentPayload?: Record<string, unknown>,
) {
  const runId = "admin-management-tool-run";
  const { operationalRunInstance } = createTestAdmittedRunContext(runId);
  const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
  const capability = createCronCreatorAuthorityCapability(runId, { kind: origin }, true)!;
  const identity: AgentRuntimeIdentity = {
    kind: "agentRuntime",
    agentId: "main",
    sessionKey: "agent:main:control-ui",
    operationalRunInstance,
    delegatedAuthority: { ...authority, kind: "local" },
  };
  const calls: Array<{ method: string; params: unknown }> = [];
  const resolveCreator = vi.fn(async () => {
    throw new Error("Admin management must not recapture the creator's tool authority");
  });
  try {
    await runWithCronCreatorAuthorityCapability(capability, () =>
      withGatewayToolCallerIdentity({ ...identity, approvalAuthority: authority }, async () => {
        const tool = createCronTool(
          {
            runId,
            agentSessionKey: identity.sessionKey,
            resolveCreatorToolAuthority: resolveCreator,
          },
          {
            callGatewayTool: async <T>(method: string, _options: unknown, params: unknown) => {
              const caller = getGatewayToolCallerIdentity();
              expect(caller?.cronCreatorAuthorityGrant).toBeUndefined();
              expect(caller?.cronManagementGrant).toBeDefined();
              return await withCronManagementGrant(
                caller!.cronManagementGrant!,
                identity,
                method,
                async () => {
                  getCronManagementAuthority(identity)!();
                  calls.push({ method, params });
                  return (
                    method === "cron.get"
                      ? {
                          id: "telegram-created-job",
                          configRevision: "sha256:stored-job",
                          payload: currentPayload ?? {
                            kind: "agentTurn",
                            message: "Original channel task",
                            toolsAllow: ["read"],
                            toolsAllowIsDefault: true,
                          },
                        }
                      : { id: "telegram-created-job" }
                  ) as T;
                },
              );
            },
          },
        );
        await run({ tool, calls, resolveCreator });
      }),
    );
  } finally {
    releaseAgentRunDelegatedAuthority(authority);
  }
}

describe("Control UI admin automation management tool", () => {
  it.each([
    ["local", true],
    ["unknown", true],
    ["unknown", false],
  ] as const)(
    "forwards a normalized partial update without recapturing creator authority (%s, trigger=%s)",
    async (origin, withTrigger) => {
      const triggerPatch = withTrigger ? { trigger: { script: "return { fire: false };" } } : {};
      await withAdminTool(origin, async ({ tool, calls, resolveCreator }) => {
        await expect(
          tool.execute("update", {
            action: "update",
            jobId: "telegram-created-job",
            job: {
              schedule: { kind: "every", every: "60000" },
              payload: { message: "Updated channel task" },
              ...triggerPatch,
              description: null,
            },
          }),
        ).resolves.toMatchObject({ details: { id: "telegram-created-job" } });
        expect(resolveCreator).not.toHaveBeenCalled();
        expect(calls).toEqual([
          ...(withTrigger ? [{ method: "cron.get", params: { id: "telegram-created-job" } }] : []),
          {
            method: "cron.update",
            params: {
              id: "telegram-created-job",
              ...(withTrigger ? { expectedConfigRevision: "sha256:stored-job" } : {}),
              patch: {
                schedule: { kind: "every", everyMs: 60000 },
                payload: { kind: "agentTurn", message: "Updated channel task" },
                ...triggerPatch,
                description: null,
              },
            },
          },
        ]);
      });
    },
  );

  it("permits an admin to edit an existing command automation", async () => {
    await withAdminTool("unknown", async ({ tool, calls, resolveCreator }) => {
      const patch = {
        payload: { kind: "command", argv: ["printf", "synthetic-proof"], timeoutSeconds: 30 },
      };
      await expect(
        tool.execute("command-update", {
          action: "update",
          jobId: "existing-command-job",
          job: patch,
        }),
      ).resolves.toBeDefined();
      expect(calls).toEqual([
        { method: "cron.update", params: { id: "existing-command-job", patch } },
      ]);
      expect(resolveCreator).not.toHaveBeenCalled();
    });
  });

  it.each([
    { kind: "command", argv: ["printf", "synthetic-proof"] },
    { kind: "script", script: "return { output: 'synthetic-proof' };" },
    { kind: "agentTurn", message: "Synthetic reminder" },
  ])("inherits the stored $kind kind for a timeout-only update", async (currentPayload) => {
    await withAdminTool(
      "unknown",
      async ({ tool, calls, resolveCreator }) => {
        await tool.execute("timeout-update", {
          action: "update",
          jobId: "telegram-created-job",
          job: { payload: { timeoutSeconds: 30 } },
        });
        expect(calls).toEqual([
          { method: "cron.get", params: { id: "telegram-created-job" } },
          {
            method: "cron.update",
            params: {
              id: "telegram-created-job",
              expectedConfigRevision: "sha256:stored-job",
              patch: { payload: { kind: currentPayload.kind, timeoutSeconds: 30 } },
            },
          },
        ]);
        expect(resolveCreator).not.toHaveBeenCalled();
      },
      currentPayload,
    );
  });

  it("advertises only the five admitted management actions and their inputs remotely", async () => {
    await withAdminTool("unknown", async ({ tool }) => {
      expect(tool.parameters).toHaveProperty("properties.action.enum", [
        "list",
        "get",
        "update",
        "run",
        "remove",
      ]);
      for (const key of ["in", "text", "mode", "contextMessages", "sessionKey"]) {
        expect(tool.parameters).not.toHaveProperty(`properties.${key}`);
      }
      expect(tool.parameters).not.toHaveProperty("properties.job.properties.declarationKey");
      expect(tool.parameters).toHaveProperty("properties.job.properties.agentId");
      expect(JSON.stringify(tool.parameters)).not.toMatch(/action=\\?"(?:add|wake|next_check)/);
    });
  });

  it.each(["status", "next_check"])(
    "visibly refuses unsupported remote action %s",
    async (action) => {
      await withAdminTool("unknown", async ({ tool, calls }) => {
        await expect(tool.execute("unsupported", { action, in: "1m" })).rejects.toThrow(
          "Use the Automations page for other actions",
        );
        expect(calls).toEqual([]);
      });
    },
  );
});
