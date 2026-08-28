import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { ExecutionIdentityAdmissionFacts } from "../audit/execution-identity-admission.js";
import { redactSensitiveText } from "../logging/redact.js";
import type { GatewayAuthResult } from "./auth.js";

type GatewayLocalUserIngressFacts = Readonly<
  Pick<ExecutionIdentityAdmissionFacts, "assurance" | "ingress" | "invoker">
>;

type GatewayLocalUserIngress = Readonly<{
  facts: GatewayLocalUserIngressFacts;
}>;

const ingressByOwner = new WeakMap<object, GatewayLocalUserIngress>();

function freezeLocalUserIngress(facts: GatewayLocalUserIngressFacts): GatewayLocalUserIngress {
  Object.freeze(facts.ingress);
  Object.freeze(facts.invoker);
  for (const item of facts.assurance ?? []) {
    Object.freeze(item);
  }
  Object.freeze(facts.assurance);
  return Object.freeze({ facts: Object.freeze(facts) });
}

function safeDisplayLabel(value: string | null | undefined): string | undefined {
  const label = value?.trim();
  return label
    ? truncateUtf16Safe(
        redactSensitiveText(redactSensitiveText(label, { mode: "tools" }), { mode: "tools" }),
        128,
      )
    : undefined;
}

/** Prepare attribution once from authenticated connection facts; credentials never become people. */
export function prepareGatewayLocalUserIngress(params: {
  authMethod?: GatewayAuthResult["method"];
  authenticatedUserExpected: boolean;
  profile?: { profileId: string; displayName?: string | null };
  pairedDeviceId?: string;
  isLocalClient: boolean;
}): GatewayLocalUserIngress {
  const profileId = params.profile?.profileId.trim();
  const pairedDeviceId = params.pairedDeviceId?.trim();
  const displayLabel = safeDisplayLabel(params.profile?.displayName);
  const assurance: NonNullable<GatewayLocalUserIngressFacts["assurance"]> = [];
  if (profileId) {
    assurance.push({
      kind: "durable-profile",
      rawEvidenceRef: profileId,
      strength: "boundary-verified",
    });
  }
  if (params.authMethod === "trusted-proxy") {
    assurance.push({
      kind: "trusted-proxy",
      rawEvidenceRef: profileId ?? "gateway-auth:trusted-proxy",
      strength: "boundary-verified",
    });
  } else if (params.authMethod === "tailscale") {
    assurance.push({
      kind: "tailscale-whois",
      rawEvidenceRef: profileId ?? "gateway-auth:tailscale",
      strength: "boundary-verified",
    });
  }
  if (pairedDeviceId) {
    assurance.push({
      kind: "device-proof",
      rawEvidenceRef: pairedDeviceId,
      strength: "cryptographic",
    });
  }
  if (params.isLocalClient) {
    assurance.push({
      kind: "local-process",
      rawEvidenceRef: "gateway-transport:local",
      strength: "boundary-verified",
    });
  }
  const rawSourceRef = profileId ?? pairedDeviceId;
  return freezeLocalUserIngress({
    ingress: {
      kind: "gateway-client",
      boundary: "gateway.ws.authenticated-connect",
      state: "present",
      ...(rawSourceRef ? { rawSourceRef } : {}),
    },
    ...(profileId
      ? {
          invoker: {
            state: "present",
            kind: "person",
            rawPrincipalRef: profileId,
            ...(displayLabel ? { displayLabel } : {}),
          },
        }
      : params.authenticatedUserExpected
        ? { invoker: { state: "unknown" } }
        : {}),
    ...(assurance.length > 0 ? { assurance } : {}),
  });
}

export function attachGatewayLocalUserIngress(
  owner: object,
  ingress: GatewayLocalUserIngress,
): void {
  ingressByOwner.set(owner, ingress);
}

export function getGatewayLocalUserIngress(
  owner: object | null | undefined,
): GatewayLocalUserIngress | undefined {
  return owner ? ingressByOwner.get(owner) : undefined;
}

export function transferGatewayLocalUserIngress(source: object, target: object): void {
  const ingress = ingressByOwner.get(source);
  if (ingress) {
    ingressByOwner.set(target, ingress);
  }
}
