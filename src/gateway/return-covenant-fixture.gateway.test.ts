import { setTimeout as delay } from "node:timers/promises";
import { asNonArrayRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReturnCovenantGatewayConfigSnapshot } from "../auto-reply/continuation/return-covenant-fixture/gateway-config.js";
import {
  readReturnCovenantProcessStartFingerprint,
  type ReturnCovenantGatewayBinding,
} from "../auto-reply/continuation/return-covenant-fixture/gateway-generation.js";
import {
  createReturnCovenantGatewayService,
  RETURN_COVENANT_GATEWAY_METHOD,
} from "../auto-reply/continuation/return-covenant-fixture/gateway-rpc.js";
import { RETURN_COVENANT_RETENTION_PATH } from "../auto-reply/continuation/return-covenant-fixture/retention.js";
import {
  createReturnCovenantTestAttestation,
  createReturnCovenantTestPlan,
  createReturnCovenantTestRequest,
} from "../auto-reply/continuation/return-covenant-fixture/test-plan.test-support.js";
import { resetConfigRuntimeState } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getFreePort } from "../test-utils/ports.js";
import { callGateway } from "./call.js";
import { ADMIN_SCOPE } from "./method-scopes.js";
import { withGatewayServerExtraHandlers } from "./server-extra-handlers.js";
import { startGatewayServer } from "./server.js";

const gatewayEnv = {
  OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
  OPENCLAW_SKIP_CANVAS_HOST: "1",
  OPENCLAW_SKIP_CHANNELS: "1",
  OPENCLAW_SKIP_CRON: "1",
  OPENCLAW_SKIP_GMAIL_WATCHER: "1",
  OPENCLAW_SKIP_PROVIDERS: "1",
  OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
  VITEST: "1",
};

const sourceConfig = {
  gateway: { mode: "local" },
  agents: {
    defaults: {
      model: "openai/gpt-5.6-sol",
    },
  },
  plugins: { entries: { codex: { enabled: true } } },
  session: { mainKey: "main", scope: "per-sender" },
} satisfies OpenClawConfig;

function stringField(value: unknown, field: string): string {
  const resolved = asNonArrayRecord(value)[field];
  if (typeof resolved !== "string") {
    throw new Error(`missing ${field}`);
  }
  return resolved;
}

async function startFixtureGatewayGeneration(params: {
  bootId: string;
  configPath: string;
  port: number;
  token: string;
}) {
  const { config, snapshot } = createReturnCovenantGatewayConfigSnapshot({
    path: params.configPath,
    raw: sourceConfig,
  });
  const binding: ReturnCovenantGatewayBinding = {
    bootId: params.bootId,
    endpoint: `http://127.0.0.1:${params.port}`,
    pid: process.pid,
    startFingerprint: await readReturnCovenantProcessStartFingerprint(process.pid),
  };
  const service = createReturnCovenantGatewayService({
    binding,
    config,
    env: process.env,
  });
  const server = await startGatewayServer(
    params.port,
    withGatewayServerExtraHandlers(
      {
        auth: { mode: "token", token: params.token },
        bind: "loopback",
        bootId: binding.bootId,
        controlUiEnabled: false,
        sidecarStartup: "defer",
        startupConfigSnapshotRead: { snapshot },
      },
      service.handlers,
      service.httpRoutes,
    ),
  );
  await server.startupSettled;
  return {
    binding,
    request: (requestToken: string, requestParams: Record<string, unknown>, timeoutMs = 30_000) =>
      callGateway({
        config,
        deviceIdentity: null,
        ignoreEnvUrlOverride: true,
        method: RETURN_COVENANT_GATEWAY_METHOD,
        params: { expectedGateway: binding, ...requestParams },
        requiredMethods: [RETURN_COVENANT_GATEWAY_METHOD],
        scopes: [ADMIN_SCOPE],
        sharedStateMode: "read-only",
        timeoutMs,
        token: requestToken,
        url: binding.endpoint.replace(/^http:/u, "ws:"),
        useStoredDeviceAuth: false,
      }),
    server,
    service,
  };
}

afterEach(() => {
  resetConfigRuntimeState();
  vi.unstubAllEnvs();
});

describe("return-covenant authenticated Gateway seam", () => {
  it("runs one typed phase chain before rejecting bad auth, stale, and stopped use", async () => {
    const port = await getFreePort();
    const token = "return-covenant-gateway-test-token";
    const state = await createOpenClawTestState({
      label: "return-covenant-gateway-rpc",
      layout: "home",
      env: gatewayEnv,
    });
    await state.writeConfig(sourceConfig);
    state.applyEnv();
    const generation = await startFixtureGatewayGeneration({
      bootId: "return-covenant-test-generation",
      port,
      token,
      configPath: state.configPath,
    });
    const { binding, request, server, service } = generation;
    try {
      await expect(
        request(token, {
          operation: "ping",
          expectedGateway: binding,
        }),
      ).resolves.toMatchObject({ gateway: binding });

      const plan = createReturnCovenantTestPlan();
      await request(token, {
        operation: "initialize",
        expectedGateway: binding,
        plan,
      });
      const attestation = createReturnCovenantTestAttestation(plan);
      const invokePhase = async (
        phaseRequest: ReturnType<typeof createReturnCovenantTestRequest>,
      ) => {
        const response = await request(token, {
          operation: "phase",
          phaseRequest,
          attestation,
        });
        return asNonArrayRecord(response.payload);
      };
      const casePlan = plan.cases[0]!;
      const form = "typed-tool";
      const prepared = await invokePhase(
        createReturnCovenantTestRequest({
          casePlan,
          form,
          phase: "prepare",
          plan,
        }),
      );
      const caseHandle = stringField(prepared, "caseHandle");
      const dispatched = await invokePhase(
        createReturnCovenantTestRequest({
          caseHandle,
          casePlan,
          form,
          phase: "dispatch",
          plan,
        }),
      );
      const acceptance = asNonArrayRecord(dispatched.acceptance);
      const acceptanceBinding = {
        capturedAuthorityGeneration: stringField(acceptance, "capturedAuthorityGeneration"),
        heldResultId: stringField(acceptance, "heldResultId"),
        receiptId: stringField(acceptance, "receiptId"),
        resultMarker: stringField(acceptance, "resultMarker"),
      };
      const transitioned = await invokePhase(
        createReturnCovenantTestRequest({
          acceptance: acceptanceBinding,
          caseHandle,
          casePlan,
          form,
          phase: "transition",
          plan,
        }),
      );
      await invokePhase(
        createReturnCovenantTestRequest({
          acceptance: acceptanceBinding,
          caseHandle,
          casePlan,
          form,
          phase: "release",
          plan,
          transition: {
            receiptId: stringField(transitioned.transition, "receiptId"),
          },
        }),
      );
      await delay(plan.settlementWindowMs);
      await expect(
        invokePhase(
          createReturnCovenantTestRequest({
            caseHandle,
            casePlan,
            form,
            phase: "observe",
            plan,
          }),
        ),
      ).resolves.toMatchObject({ settled: true });
      await invokePhase(
        createReturnCovenantTestRequest({
          caseHandle,
          casePlan,
          form,
          phase: "cleanup",
          plan,
        }),
      );

      await expect(
        request("wrong-return-covenant-token", {
          operation: "ping",
          expectedGateway: binding,
        }),
      ).rejects.toThrow();
      const unauthorizedInspection = await fetch(
        `${binding.endpoint}${RETURN_COVENANT_RETENTION_PATH}`,
        {
          method: "POST",
          headers: {
            authorization: "Bearer wrong-return-covenant-token",
            "content-type": "application/json",
          },
          body: "{}",
        },
      );
      expect(unauthorizedInspection.status).toBe(401);
      const invalidInspection = await fetch(
        `${binding.endpoint}${RETURN_COVENANT_RETENTION_PATH}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: "{}",
        },
      );
      expect(invalidInspection.status).toBe(409);
      await expect(
        request(token, {
          operation: "ping",
          expectedGateway: { ...binding, bootId: "stale-return-covenant-generation" },
        }),
      ).rejects.toThrow(/stale gateway generation/u);
    } finally {
      service.beginClose();
      await service.close();
      await server.close({ reason: "return-covenant gateway seam test complete" });
      await state.cleanup();
    }
    await expect(
      request(
        token,
        {
          operation: "ping",
          expectedGateway: binding,
        },
        500,
      ),
    ).rejects.toThrow();
  }, 90_000);

  it("restores one held result through a replacement Gateway generation", async () => {
    const token = "return-covenant-restart-test-token";
    const [firstPort, replacementPort] = await Promise.all([getFreePort(), getFreePort()]);
    const state = await createOpenClawTestState({
      label: "return-covenant-gateway-restart",
      layout: "home",
      env: gatewayEnv,
    });
    await state.writeConfig(sourceConfig);
    state.applyEnv();
    const first = await startFixtureGatewayGeneration({
      bootId: "return-covenant-generation-a",
      configPath: state.configPath,
      port: firstPort,
      token,
    });
    let replacement: Awaited<ReturnType<typeof startFixtureGatewayGeneration>> | undefined;
    const plan = createReturnCovenantTestPlan();
    const attestation = createReturnCovenantTestAttestation(plan);
    const casePlan = plan.cases.find((entry) => entry.id === "allowed-gateway-restart-replay")!;
    const form = "typed-tool";
    const invokePhase = async (
      generation: Awaited<ReturnType<typeof startFixtureGatewayGeneration>>,
      phaseRequest: ReturnType<typeof createReturnCovenantTestRequest>,
      restart?: {
        original: ReturnCovenantGatewayBinding;
        replacement: ReturnCovenantGatewayBinding;
      },
    ) => {
      const response = await generation.request(token, {
        operation: "phase",
        phaseRequest,
        attestation,
        ...(restart ? { restart } : {}),
      });
      return asNonArrayRecord(response.payload);
    };
    try {
      await first.request(token, { operation: "initialize", plan });
      const prepared = await invokePhase(
        first,
        createReturnCovenantTestRequest({
          casePlan,
          form,
          phase: "prepare",
          plan,
        }),
      );
      const caseHandle = stringField(prepared, "caseHandle");
      const dispatched = await invokePhase(
        first,
        createReturnCovenantTestRequest({
          caseHandle,
          casePlan,
          form,
          phase: "dispatch",
          plan,
        }),
      );
      const acceptance = asNonArrayRecord(dispatched.acceptance);
      const acceptanceBinding = {
        capturedAuthorityGeneration: stringField(acceptance, "capturedAuthorityGeneration"),
        heldResultId: stringField(acceptance, "heldResultId"),
        receiptId: stringField(acceptance, "receiptId"),
        resultMarker: stringField(acceptance, "resultMarker"),
      };
      const snapshotResponse = await first.request(token, { operation: "snapshot" });
      expect(snapshotResponse.snapshot).toBeDefined();
      first.service.beginClose();
      await first.service.close();
      await first.server.close({ reason: "return-covenant replacement test" });
      resetConfigRuntimeState();

      replacement = await startFixtureGatewayGeneration({
        bootId: "return-covenant-generation-b",
        configPath: state.configPath,
        port: replacementPort,
        token,
      });
      await replacement.request(token, {
        operation: "initialize",
        plan,
        snapshot: snapshotResponse.snapshot,
      });
      await expect(
        replacement.request(token, {
          operation: "ping",
          expectedGateway: first.binding,
        }),
      ).rejects.toThrow(/stale gateway generation/u);
      await expect(first.request(token, { operation: "ping" }, 500)).rejects.toThrow();

      const restart = {
        original: first.binding,
        replacement: replacement.binding,
      };
      const transitioned = await invokePhase(
        replacement,
        createReturnCovenantTestRequest({
          acceptance: acceptanceBinding,
          caseHandle,
          casePlan,
          form,
          phase: "transition",
          plan,
        }),
        restart,
      );
      const transition = asNonArrayRecord(transitioned.transition);
      expect(transition.restart).toMatchObject({
        replacementGatewayEndpoint: replacement.binding.endpoint,
        restartedBeforeRelease: true,
        replayRecovered: true,
        stoppedAfterAcceptance: true,
      });
      await invokePhase(
        replacement,
        createReturnCovenantTestRequest({
          acceptance: acceptanceBinding,
          caseHandle,
          casePlan,
          form,
          phase: "release",
          plan,
          transition: { receiptId: stringField(transition, "receiptId") },
        }),
      );
      await delay(plan.settlementWindowMs);
      const observed = await invokePhase(
        replacement,
        createReturnCovenantTestRequest({
          caseHandle,
          casePlan,
          form,
          phase: "observe",
          plan,
        }),
      );
      expect(asNonArrayRecord(observed.observation).effects).toMatchObject({
        observed: casePlan.expectedEffects[form],
      });
      await invokePhase(
        replacement,
        createReturnCovenantTestRequest({
          caseHandle,
          casePlan,
          form,
          phase: "cleanup",
          plan,
        }),
      );
      await invokePhase(
        replacement,
        createReturnCovenantTestRequest({
          casePlan,
          form,
          phase: "cleanup-run",
          plan,
          fallback: true,
        }),
      );
    } finally {
      for (const generation of [replacement, first]) {
        generation?.service.beginClose();
        await generation?.service.close().catch(() => undefined);
        await generation?.server
          .close({ reason: "return-covenant replacement test cleanup" })
          .catch(() => undefined);
      }
      await state.cleanup();
    }
  }, 120_000);
});
