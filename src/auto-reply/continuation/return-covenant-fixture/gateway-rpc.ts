import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { ErrorCodes, errorShape } from "../../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { GatewayRequestHandlers } from "../../../gateway/server-methods/types.js";
import type { ReturnCovenantFixtureFaults, ReturnCovenantGatewayInvocation } from "./case-state.js";
import {
  assertReturnCovenantGatewayBinding,
  parseReturnCovenantGatewayBinding,
  type ReturnCovenantGatewayBinding,
  type ReturnCovenantGatewayRestart,
} from "./gateway-generation.js";
import {
  parseReturnCovenantDriverAttestation,
  parseReturnCovenantPhaseRequest,
  parseReturnCovenantPlan,
  ReturnCovenantProtocolError,
} from "./protocol.js";
import { parseReturnCovenantRunSnapshot } from "./run-snapshot.js";
import { ReturnCovenantFixtureRun } from "./run.js";

export const RETURN_COVENANT_GATEWAY_METHOD = "return-covenant.fixture";

type ReturnCovenantGatewayOperation = "finalize" | "initialize" | "phase" | "ping" | "snapshot";

type ReturnCovenantGatewayService = {
  beginClose: () => void;
  close: () => Promise<void>;
  handlers: GatewayRequestHandlers;
};

function readOperation(value: unknown): ReturnCovenantGatewayOperation {
  switch (value) {
    case "finalize":
    case "initialize":
    case "phase":
    case "ping":
    case "snapshot":
      return value;
    default:
      throw new ReturnCovenantProtocolError(
        "invalid-gateway-operation",
        "return-covenant gateway operation is invalid",
      );
  }
}

function parseRestart(value: unknown): ReturnCovenantGatewayRestart | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new ReturnCovenantProtocolError(
      "invalid-gateway-restart",
      "return-covenant gateway restart lineage is invalid",
    );
  }
  return {
    original: parseReturnCovenantGatewayBinding(value.original),
    replacement: parseReturnCovenantGatewayBinding(value.replacement),
  };
}

export function createReturnCovenantGatewayService(params: {
  binding: ReturnCovenantGatewayBinding;
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  faults?: ReturnCovenantFixtureFaults;
}): ReturnCovenantGatewayService {
  let active = true;
  let run: ReturnCovenantFixtureRun | undefined;
  const assertActive = () => {
    if (!active) {
      throw new ReturnCovenantProtocolError(
        "stale-gateway-generation",
        "return-covenant gateway generation is closing",
        409,
      );
    }
  };
  const handlers: GatewayRequestHandlers = {
    [RETURN_COVENANT_GATEWAY_METHOD]: async ({ params: request, respond }) => {
      try {
        assertActive();
        const operation = readOperation(request.operation);
        const expectedGateway = parseReturnCovenantGatewayBinding(request.expectedGateway);
        assertReturnCovenantGatewayBinding(
          params.binding,
          expectedGateway,
          "return-covenant request targets a stale gateway generation",
        );
        if (operation === "ping") {
          respond(true, { gateway: params.binding });
          return;
        }
        if (operation === "initialize") {
          if (run) {
            throw new ReturnCovenantProtocolError(
              "phase-replay",
              "return-covenant gateway run was already initialized",
              409,
            );
          }
          const plan = parseReturnCovenantPlan(request.plan);
          const snapshot =
            request.snapshot === undefined
              ? undefined
              : parseReturnCovenantRunSnapshot(request.snapshot);
          run = snapshot
            ? await ReturnCovenantFixtureRun.restore({
                config: params.config,
                env: params.env,
                ...(params.faults ? { faults: params.faults } : {}),
                plan,
                snapshot,
              })
            : await ReturnCovenantFixtureRun.create({
                config: params.config,
                env: params.env,
                ...(params.faults ? { faults: params.faults } : {}),
                plan,
              });
          assertActive();
          respond(true, { gateway: params.binding });
          return;
        }
        if (!run) {
          throw new ReturnCovenantProtocolError(
            "uninitialized-gateway-run",
            "return-covenant gateway run is not initialized",
            409,
          );
        }
        if (operation === "phase") {
          const phaseRequest = parseReturnCovenantPhaseRequest(request.phaseRequest);
          const attestation = parseReturnCovenantDriverAttestation(request.attestation);
          const restart = parseRestart(request.restart);
          const invocation: ReturnCovenantGatewayInvocation = {
            gateway: params.binding,
            ...(restart ? { restart } : {}),
          };
          const payload = await run.handle(phaseRequest, attestation, invocation);
          assertActive();
          respond(true, {
            gateway: params.binding,
            payload,
            finalizeRequested: run.finalizeRequested,
          });
          return;
        }
        if (operation === "snapshot") {
          const snapshot = await run.snapshotForGatewayRestart();
          run = undefined;
          assertActive();
          respond(true, { gateway: params.binding, snapshot });
          return;
        }
        const claims = await run.buildCleanupClaims();
        await run.close();
        run = undefined;
        assertActive();
        respond(true, { gateway: params.binding, claims });
      } catch (error) {
        const code =
          error instanceof ReturnCovenantProtocolError
            ? ErrorCodes.INVALID_REQUEST
            : ErrorCodes.UNAVAILABLE;
        const message = error instanceof Error ? error.message : "return-covenant gateway failed";
        respond(false, undefined, errorShape(code, message));
      }
    },
  };
  return {
    beginClose: () => {
      active = false;
    },
    close: async () => {
      active = false;
      await run?.close();
      run = undefined;
    },
    handlers,
  };
}
