import { describe, expect, it } from "vitest";
import {
  authorizeReturnCovenantPhaseRequest,
  buildSignedReturnCovenantPhaseResponse,
  parseReturnCovenantDriverArgs,
  parseReturnCovenantPhaseRequest,
  parseReturnCovenantPlan,
  ReturnCovenantProtocolError,
} from "./protocol.js";
import {
  createReturnCovenantTestAttestation,
  createReturnCovenantTestPlan,
  createReturnCovenantTestRequest,
} from "./test-plan.test-support.js";

const launchNonce = "return-covenant-test-launch-nonce";
const phaseSigningKey = "return-covenant-test-phase-signing-key";

describe("return-covenant fixture protocol", () => {
  it("accepts only the fixed product command arguments and matrix plan", () => {
    expect(
      parseReturnCovenantDriverArgs([
        "--contract",
        "openclaw.k6.return-covenant-fixture-driver.v1",
        "--plan",
        "/run/plan.json",
        "--ready",
        "/run/ready.json",
        "--cleanup-draft",
        "/run/cleanup.json",
      ]),
    ).toEqual({
      cleanupDraftPath: "/run/cleanup.json",
      planPath: "/run/plan.json",
      readyPath: "/run/ready.json",
    });
    expect(() =>
      parseReturnCovenantDriverArgs([
        "--contract",
        "wrong",
        "--plan",
        "/run/plan.json",
        "--ready",
        "/run/ready.json",
        "--cleanup-draft",
        "/run/cleanup.json",
      ]),
    ).toThrow(ReturnCovenantProtocolError);

    const plan = createReturnCovenantTestPlan();
    expect(plan.cases).toHaveLength(12);
    const reordered = structuredClone(plan);
    [reordered.cases[0], reordered.cases[1]] = [reordered.cases[1]!, reordered.cases[0]!];
    expect(() => parseReturnCovenantPlan(reordered)).toThrow(/case order/u);
    expect(() =>
      parseReturnCovenantPlan({
        ...plan,
        target: { ...plan.target, runtimeBuildSha: "8".repeat(40) },
      }),
    ).toThrow(/runtime build SHA/u);
  });

  it("rejects malformed requests, challenge substitution, and nonce replay", () => {
    const plan = createReturnCovenantTestPlan();
    const attestation = createReturnCovenantTestAttestation(plan);
    const request = createReturnCovenantTestRequest({
      casePlan: plan.cases[0]!,
      form: "typed-tool",
      phase: "prepare",
      plan,
    });
    expect(() => parseReturnCovenantPhaseRequest({ ...request, unexpected: true })).toThrow(
      /Unrecognized key/u,
    );

    const seenRequestNonces = new Set<string>();
    authorizeReturnCovenantPhaseRequest({
      attestation,
      launchNonce,
      phaseSigningKey,
      plan,
      request,
      seenRequestNonces,
    });
    expect(() =>
      authorizeReturnCovenantPhaseRequest({
        attestation,
        launchNonce,
        phaseSigningKey,
        plan,
        request,
        seenRequestNonces,
      }),
    ).toThrow(/already consumed/u);

    const substituted = parseReturnCovenantPhaseRequest({
      ...request,
      driverBinding: {
        ...request.driverBinding,
        challenge: "substituted-return-covenant-challenge",
        requestNonce: "7".repeat(64),
      },
    });
    expect(() =>
      authorizeReturnCovenantPhaseRequest({
        attestation,
        launchNonce,
        phaseSigningKey,
        plan,
        request: substituted,
        seenRequestNonces: new Set(),
      }),
    ).toThrow(/does not possess/u);
  });

  it("binds each signed response to the phase receipt and request nonce", () => {
    const plan = createReturnCovenantTestPlan();
    const attestation = createReturnCovenantTestAttestation(plan);
    const request = createReturnCovenantTestRequest({
      casePlan: plan.cases[0]!,
      form: "typed-tool",
      phase: "prepare",
      plan,
    });
    const response = buildSignedReturnCovenantPhaseResponse({
      attestation,
      payload: {
        caseHandle: "case-1234567890abcdef",
        prepare: {
          caseHandle: "case-1234567890abcdef",
          receiptId: "fixture-receipt",
        },
      },
      phaseSigningKey,
      request,
    });
    expect(response).toMatchObject({
      schema: "openclaw.k6.return-covenant-fixture-driver.v1",
      phase: "prepare",
      ok: true,
      driverBinding: {
        requestNonce: request.driverBinding.requestNonce,
        attestationSha256: attestation.attestationSha256,
        signature: expect.stringMatching(/^[0-9a-f]{64}$/u),
        receiptSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
    });
    const changed = buildSignedReturnCovenantPhaseResponse({
      attestation,
      payload: {
        caseHandle: "case-1234567890abcdef",
        prepare: {
          caseHandle: "case-1234567890abcdef",
          receiptId: "different-fixture-receipt",
        },
      },
      phaseSigningKey,
      request,
    });
    expect((changed.driverBinding as { signature: string }).signature).not.toBe(
      (response.driverBinding as { signature: string }).signature,
    );
  });
});
