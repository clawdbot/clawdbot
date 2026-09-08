import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, onTestFinished, test, vi } from "vitest";
import {
  channelAdministratorTestGrant as grant,
  createTestChannelAdministratorSource,
} from "../../test/helpers/channel-administrator-source.js";
import { isConfiguredCommandOwner } from "../auto-reply/command-auth.js";
import { prepareChannelRunAdmission } from "../auto-reply/reply/channel-run-admission.js";
import {
  getRuntimeConfig,
  setRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "../config/config.js";
import * as cronMutationOps from "../cron/service/ops-mutations.js";
import { loadCronStore, saveCronStore } from "../cron/store.js";
import { getActiveAgentRunDelegatedAuthority } from "../infra/agent-run-registry.js";
import { createDeferredCore } from "../shared/deferred.js";
import { mintAgentRuntimeIdentityToken } from "./agent-runtime-identity-token.js";
import {
  createChannelAdministratorAuthority,
  mintChannelAdministratorGrant,
} from "./channel-administrator-authority.js";
import { GatewayClient } from "./client.js";
import { installGatewayTestHooks, startServer, testState } from "./test-helpers.js";

const sessionKey = `agent:main:discord:channel:${grant.conversationId}`;
const jobId = "other-session-automation";
const gatewayToken = "channel-administrator-synthetic-gateway-fixture";

installGatewayTestHooks({ scope: "suite" });

async function admitDiscordTurn(config: OpenClawConfig, nativeHuman: boolean) {
  const source = await createTestChannelAdministratorSource(config, nativeHuman);
  const { lifetime, assertPolicyCurrent } = source;
  const admission = prepareChannelRunAdmission({
    cfg: config,
    runId: "discord-administrator-gateway-proof",
    agentId: "main",
    ingressKind: "channel",
    boundary: "channel-inbound",
    evidence: source.evidence,
  });
  onTestFinished(admission.close);
  try {
    const { operationalRunInstance } = await admission.admit("embedded");
    const authority = expectDefined(
      getActiveAgentRunDelegatedAuthority(operationalRunInstance),
      "the admitted channel run must own live delegated authority",
    );
    const capability = assertPolicyCurrent
      ? createChannelAdministratorAuthority(
          operationalRunInstance.runId,
          lifetime.signal,
          assertPolicyCurrent,
        )
      : undefined;
    return {
      capability,
      async request<T>(port: number, method: string, params: unknown, scopes = ["operator.read"]) {
        const agentRuntimeIdentityToken = await mintAgentRuntimeIdentityToken({
          agentId: "main",
          sessionKey,
          operationalRunInstance,
          approvalAuthority: authority,
          turnSourceChannel: grant.channel,
          turnSourceAccountId: grant.accountId,
          turnSourceTo: `channel:${grant.conversationId}`,
          ...(capability
            ? {
                channelAdministratorGrant: mintChannelAdministratorGrant(
                  capability,
                  authority,
                  method,
                ),
              }
            : {}),
        });
        const connected = createDeferredCore();
        const client = new GatewayClient({
          url: `ws://127.0.0.1:${port}`,
          token: gatewayToken,
          agentRuntimeIdentityToken,
          clientName: "gateway-client",
          mode: "backend",
          deviceIdentity: null,
          scopes,
          onHelloOk: () => connected.resolve(),
          onConnectError: connected.reject,
        });
        try {
          client.start();
          await connected.promise;
          return await client.request<T>(method, params);
        } finally {
          await client.stopAndWait();
        }
      },
      close() {
        source.close();
        admission.close();
      },
    };
  } catch (error) {
    source.close();
    admission.close();
    throw error;
  }
}

test("authenticated channel admission controls cross-session cron effects over the real Gateway transport", async () => {
  // The standard harness owns this temporary HOME, state database, and free
  // loopback port. Native Discord authentication is supplied by the fixture;
  // ingress admission, signed transport, handlers, and SQLite effects are real.
  const stateDir = expectDefined(process.env.OPENCLAW_STATE_DIR, "isolated Gateway state");
  expect(path.basename(path.dirname(stateDir))).toMatch(/^openclaw-gateway-home-/);
  testState.cronStorePath = path.join(stateDir, "cron", "jobs.json");
  testState.cronEnabled = false;
  testState.cronTriggersEnabled = false;
  await saveCronStore(testState.cronStorePath, {
    version: 1,
    jobs: [
      {
        id: jobId,
        name: "original automation",
        enabled: false,
        createdAtMs: Date.now(),
        updatedAtMs: Date.now(),
        agentId: "main",
        owner: { agentId: "main", sessionKey: "agent:main:main", accountId: "default" },
        scheduledToolPolicy: {
          version: 1,
          mode: "account",
          ownerSessionKey: "agent:main:main",
          ownerAccountId: "default",
        },
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: {
          kind: "agentTurn",
          message: "Synthetic automation fixture",
          toolsAllow: ["read"],
        },
        delivery: { mode: "none" },
        state: {},
      },
    ],
  });
  const { server, port } = await startServer(gatewayToken);
  const config = {
    ...getRuntimeConfig(),
    commands: {
      ownerAllowFrom: [`discord:${grant.senderId}`],
      channelAdministrators: [grant],
    },
  } satisfies OpenClawConfig;
  const expectPersistedJob = async (name: string) => {
    const job = (
      await loadCronStore(expectDefined(testState.cronStorePath, "isolated cron store"))
    ).jobs.find((job) => job.id === jobId);
    expect(job).toMatchObject({
      name,
      owner: { agentId: "main", sessionKey: "agent:main:main", accountId: "default" },
      payload: { kind: "agentTurn", toolsAllow: ["read"] },
      scheduledToolPolicy: {
        version: 1,
        mode: "account",
        ownerSessionKey: "agent:main:main",
        ownerAccountId: "default",
      },
    });
  };
  try {
    // Verify a valid restrictive execution envelope survived the initial
    // SQLite round trip before comparing authorized and rejected mutations.
    await expectPersistedJob("original automation");
    for (const scenario of ["missing grant", "empty grants", "no native human source"] as const) {
      const ordinaryConfig: OpenClawConfig = {
        ...config,
        commands: {
          ...config.commands,
          channelAdministrators:
            scenario === "missing grant" ? undefined : scenario === "empty grants" ? [] : [grant],
        },
      };
      setRuntimeConfigSnapshot(ordinaryConfig);
      expect(isConfiguredCommandOwner(ordinaryConfig, grant), scenario).toBe(true);
      const turn = await admitDiscordTurn(ordinaryConfig, scenario !== "no native human source");
      try {
        expect(turn.capability, scenario).toBeUndefined();
        const inventory = await turn.request<{ jobs: Array<{ id: string }> }>(port, "cron.list", {
          includeDisabled: true,
        });
        expect(inventory.jobs, scenario).toEqual([]);
        // Even a backend connection allowed to call cron.update cannot use its
        // ordinary signed agent identity to escape the creator/session boundary.
        await expect(
          turn.request(port, "cron.update", { id: jobId, patch: { name: "unauthorized edit" } }, [
            "operator.admin",
          ]),
          scenario,
        ).rejects.toThrow(/Automation not found/);
        await expectPersistedJob("original automation");
      } finally {
        turn.close();
      }
    }

    setRuntimeConfigSnapshot(config);
    const administrator = await admitDiscordTurn(config, true);
    try {
      expect(administrator.capability).toBeDefined();
      const inventory = await administrator.request<{ jobs: Array<{ id: string }> }>(
        port,
        "cron.list",
        { includeDisabled: true },
      );
      expect(inventory.jobs).toEqual([expect.objectContaining({ id: jobId })]);
      await expect(
        administrator.request(port, "cron.update", {
          id: jobId,
          patch: { name: "authorized edit" },
        }),
      ).resolves.toMatchObject({ id: jobId, name: "authorized edit" });
      await expectPersistedJob("authorized edit");

      const reachedPrecommit = createDeferredCore();
      const resume = createDeferredCore();
      const originalUpdate = cronMutationOps.updateWithPrecondition;
      const pausedUpdate = vi
        .spyOn(cronMutationOps, "updateWithPrecondition")
        .mockImplementationOnce(async (state, id, patch, precondition, options) => {
          expect(options?.commitGuard).toBeTypeOf("function");
          return await originalUpdate(
            state,
            id,
            patch,
            async (job, nowMs) => {
              await precondition(job, nowMs);
              reachedPrecommit.resolve();
              await resume.promise;
            },
            options,
          );
        });
      try {
        const update = administrator.request(port, "cron.update", {
          id: jobId,
          patch: { name: "revoked edit" },
        });
        const rejected = expect(update).rejects.toThrow(/revoked|no longer active/);
        await Promise.race([
          reachedPrecommit.promise,
          update.then(() => {
            throw new Error("request finished before its controlled revocation boundary");
          }),
        ]);
        setRuntimeConfigSnapshot({
          ...config,
          commands: { ...config.commands, channelAdministrators: [] },
        });
        resume.resolve();
        await rejected;
        await expectPersistedJob("authorized edit");
      } finally {
        resume.resolve();
        pausedUpdate.mockRestore();
      }
    } finally {
      administrator.close();
    }
  } finally {
    await server.close();
  }
});
