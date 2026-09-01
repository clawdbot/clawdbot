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
import { createReturnCovenantFixtureConfig } from "../auto-reply/continuation/return-covenant-fixture/runtime-config.js";
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

afterEach(() => {
  resetConfigRuntimeState();
  vi.unstubAllEnvs();
});

describe("return-covenant authenticated Gateway seam", () => {
  it("routes phases through the live generation and rejects bad auth, stale, and stopped use", async () => {
    const port = await getFreePort();
    const token = "return-covenant-gateway-test-token";
    const state = await createOpenClawTestState({
      label: "return-covenant-gateway-rpc",
      layout: "home",
      env: {
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        VITEST: "1",
      },
    });
    const sourceConfig: OpenClawConfig = {
      gateway: { mode: "local" },
      agents: {
        defaults: {
          model: "openai/gpt-5.6-sol",
        },
      },
      plugins: { entries: { codex: { enabled: true } } },
      session: { mainKey: "main", scope: "per-sender" },
    };
    await state.writeConfig(sourceConfig);
    state.applyEnv();
    const { config, snapshot } = createReturnCovenantGatewayConfigSnapshot({
      path: state.configPath,
      raw: sourceConfig,
    });
    const binding: ReturnCovenantGatewayBinding = {
      bootId: "return-covenant-test-generation",
      endpoint: `http://127.0.0.1:${port}`,
      pid: process.pid,
      startFingerprint: await readReturnCovenantProcessStartFingerprint(process.pid),
    };
    const service = createReturnCovenantGatewayService({
      binding,
      config: createReturnCovenantFixtureConfig(config),
      env: process.env,
    });
    const server = await startGatewayServer(
      port,
      withGatewayServerExtraHandlers(
        {
          auth: { mode: "token", token },
          bind: "loopback",
          bootId: binding.bootId,
          controlUiEnabled: false,
          sidecarStartup: "defer",
          startupConfigSnapshotRead: { snapshot },
        },
        service.handlers,
      ),
    );
    const request = (requestToken: string, params: Record<string, unknown>, timeoutMs = 30_000) =>
      callGateway({
        config,
        deviceIdentity: null,
        ignoreEnvUrlOverride: true,
        method: RETURN_COVENANT_GATEWAY_METHOD,
        params,
        requiredMethods: [RETURN_COVENANT_GATEWAY_METHOD],
        scopes: [ADMIN_SCOPE],
        sharedStateMode: "read-only",
        timeoutMs,
        token: requestToken,
        url: binding.endpoint.replace(/^http:/u, "ws:"),
        useStoredDeviceAuth: false,
      });
    try {
      await server.startupSettled;
      await expect(
        request("wrong-return-covenant-token", {
          operation: "ping",
          expectedGateway: binding,
        }),
      ).rejects.toThrow();
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
          expectedGateway: binding,
          phaseRequest,
          attestation,
        });
        return asNonArrayRecord(response.payload);
      };
      const stringField = (value: unknown, field: string) => {
        const resolved = asNonArrayRecord(value)[field];
        if (typeof resolved !== "string") {
          throw new Error(`missing ${field}`);
        }
        return resolved;
      };
      const casePlan = plan.cases[0]!;
      for (const form of casePlan.forms) {
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
      }
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
});
