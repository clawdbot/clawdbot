import type { ExecutionIdentityAdmissionFacts } from "../audit/execution-identity-admission.js";

type AgentCommandAdmissionFacts = Readonly<
  Pick<ExecutionIdentityAdmissionFacts, "assurance" | "ingress" | "invoker">
>;

const factsByIngress = new WeakMap<object, AgentCommandAdmissionFacts>();

export function attachAgentCommandAdmissionFacts(
  ingress: object,
  facts: AgentCommandAdmissionFacts,
): void {
  factsByIngress.set(ingress, facts);
}

export function getAgentCommandAdmissionFacts(
  ingress: object,
): AgentCommandAdmissionFacts | undefined {
  return factsByIngress.get(ingress);
}

/** Records the exact system attribution only after the recovery owner admits the attempt. */
export function attachAgentCommandRecoveryAdmissionFacts(ingress: object): void {
  attachAgentCommandAdmissionFacts(ingress, {
    ingress: {
      kind: "recovery",
      boundary: "gateway.main-session-recovery",
      state: "present",
    },
    invoker: {
      state: "present",
      kind: "system",
      rawPrincipalRef: "openclaw.main-session-recovery",
    },
    assurance: [
      {
        kind: "runtime-binding",
        rawEvidenceRef: "gateway.main-session-recovery-owner",
        strength: "boundary-verified",
      },
    ],
  });
}
