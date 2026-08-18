/** Worker-only canonical context construction and bounded value helpers. */
import type { DatabaseSync } from "node:sqlite";
import type { ExecutionIdentityContextV1 } from "../../packages/gateway-protocol/src/index.js";
import { validateExecutionIdentityContextV1 } from "../../packages/gateway-protocol/src/index.js";
import { pseudonymizeExecutionIdentityRef } from "./audit-identity.js";
import type { ExecutionIdentityAdmissionEnvelope } from "./execution-identity-admission.js";
import { executionIdentitySpawnAdmission } from "./execution-identity-spawn-admission.js";

const EXECUTION_IDENTITY_CONTEXT_MAX_BYTES = 16 * 1024;

export function ensureBoundedExecutionIdentityRef(
  value: string,
  label: string,
  maxLength = 256,
): string {
  if (!value || value.length > maxLength) {
    throw new Error(`${label} must be between 1 and ${String(maxLength)} characters`);
  }
  return value;
}

function ensureRawRef(value: string, label: string): string {
  return ensureBoundedExecutionIdentityRef(value, label, 4_096);
}

export function freezeExecutionIdentityContext<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object" || seen.has(value as object)) {
    return value;
  }
  seen.add(value as object);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    freezeExecutionIdentityContext(nested, seen);
  }
  return Object.freeze(value);
}

function hmacRef(
  db: DatabaseSync,
  kind: Parameters<typeof pseudonymizeExecutionIdentityRef>[0]["kind"],
  scope: string,
  value: string,
): string {
  return pseudonymizeExecutionIdentityRef({
    db,
    kind,
    scope: ensureBoundedExecutionIdentityRef(scope, "HMAC scope"),
    value: ensureRawRef(value, "HMAC value"),
  });
}

function uniqueSorted<T>(values: readonly T[], key: (value: T) => string): T[] {
  return [...new Map(values.map((value) => [key(value), value])).values()].toSorted((a, b) => {
    const left = key(a);
    const right = key(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

export function buildExecutionIdentityContext(
  db: DatabaseSync,
  envelope: ExecutionIdentityAdmissionEnvelope,
  fixed: { contextId: string; createdAt: number },
): ExecutionIdentityContextV1 {
  const runId = ensureBoundedExecutionIdentityRef(envelope.runId, "run id");
  const executionId = ensureBoundedExecutionIdentityRef(envelope.executionId, "execution id");
  const agentId = ensureBoundedExecutionIdentityRef(envelope.agentId, "agent id");
  const contextId = ensureBoundedExecutionIdentityRef(fixed.contextId, "context id");
  const domainRef = hmacRef(db, "domain", "gateway-cell", "gateway-cell");
  const runtimeRef = hmacRef(
    db,
    "runtime",
    domainRef,
    ensureRawRef(envelope.runtimeInstanceId, "runtime instance id"),
  );
  const invoker =
    envelope.invoker?.state === "present"
      ? {
          state: "present" as const,
          principal: {
            kind: envelope.invoker.kind,
            domainRef,
            principalRef: hmacRef(
              db,
              "principal",
              `${domainRef}:${envelope.invoker.kind}`,
              envelope.invoker.rawPrincipalRef,
            ),
            ...(envelope.invoker.displayLabel !== undefined
              ? { displayLabel: envelope.invoker.displayLabel }
              : {}),
          },
        }
      : envelope.invoker?.state === "unknown"
        ? { state: "unknown" as const }
        : { state: "absent" as const };
  const assurance = uniqueSorted(
    envelope.assurance.map((item) => ({
      kind: item.kind,
      evidenceRef: hmacRef(db, "evidence", `${domainRef}:${item.kind}`, item.rawEvidenceRef),
      strength: item.strength,
    })),
    (item) => `${item.kind}\0${item.evidenceRef}\0${item.strength}`,
  );
  const applicableGrants = uniqueSorted(
    envelope.applicableGrants.map((grant) => ({
      grantRef: hmacRef(db, "grant", domainRef, grant.rawGrantRef),
      state: grant.state,
    })),
    (grant) => `${grant.grantRef}\0${grant.state}`,
  );
  const serializedSpawnFacts = executionIdentitySpawnAdmission({
    operation: "read",
    value: envelope,
  });
  const [lineageFacts, spawnMissingEvidence] = serializedSpawnFacts
    ? executionIdentitySpawnAdmission({ operation: "parse", value: serializedSpawnFacts })
    : [undefined, []];
  const lineage = lineageFacts
    ? {
        ...(typeof lineageFacts.parentContextId === "string"
          ? { parentContextId: lineageFacts.parentContextId }
          : {}),
        ...(typeof lineageFacts.parentExecutionId === "string"
          ? { parentExecutionId: lineageFacts.parentExecutionId }
          : {}),
        ...(typeof lineageFacts.parentRunId === "string"
          ? { parentRunId: lineageFacts.parentRunId }
          : {}),
        parentAgentPrincipal: {
          kind: "agent" as const,
          domainRef,
          principalRef: lineageFacts.parentAgentId,
        },
        delegationRef: hmacRef(
          db,
          "grant",
          `${domainRef}:delegation`,
          JSON.stringify([
            lineageFacts.relation,
            lineageFacts.rawRequesterRef,
            lineageFacts.rawControllerRef,
            lineageFacts.localPolicyRefs,
            lineageFacts.targetPolicyRefs,
          ]),
        ),
        depth: lineageFacts.depth,
      }
    : undefined;
  const missingEvidence = uniqueSorted(
    [
      ...(envelope.invoker?.state === "present" ? [] : ["invoker.principal"]),
      ...spawnMissingEvidence,
    ],
    (item) => item,
  );
  const context: Record<string, unknown> = {
    schemaVersion: 1,
    contextId,
    executionId,
    runId,
    createdAt: fixed.createdAt,
    trustDomain: { kind: "gateway-cell", domainRef, state: "present" },
    invoker,
    ingress: {
      kind: envelope.ingress.kind,
      boundary: ensureBoundedExecutionIdentityRef(envelope.ingress.boundary, "ingress boundary"),
      state: envelope.ingress.state,
      ...(envelope.ingress.rawSourceRef
        ? {
            sourceRef: hmacRef(
              db,
              "principal",
              `${domainRef}:ingress:${envelope.ingress.kind}`,
              envelope.ingress.rawSourceRef,
            ),
          }
        : {}),
    },
    agentPrincipal: { kind: "agent", domainRef, principalRef: agentId },
    agentDefinition: { definitionRef: agentId, state: "present" },
    runtimeInstance: { runtimeRef, kind: envelope.runtime.kind, state: "present" },
    applicableGrants,
    assurance,
    ...(lineage ? { lineage } : {}),
    coverageState: lineage
      ? "attribution-only"
      : envelope.invoker?.state === "present"
        ? "attribution-only"
        : envelope.invoker?.state === "unknown"
          ? "unknown"
          : "unattributed",
    missingEvidence,
  };
  if (!validateExecutionIdentityContextV1(context)) {
    throw new Error("prepared execution identity context violates the V1 contract");
  }
  const encoded = JSON.stringify(context);
  if (Buffer.byteLength(encoded, "utf8") > EXECUTION_IDENTITY_CONTEXT_MAX_BYTES) {
    throw new Error("prepared execution identity context exceeds 16 KiB");
  }
  return freezeExecutionIdentityContext(context);
}
