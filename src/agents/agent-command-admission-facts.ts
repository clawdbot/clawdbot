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
