import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  archiveLegacyStateSource,
  asObjectRecord,
  type PluginDoctorStateMigration,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { resolveAcpxPluginConfig } from "./config.js";
import {
  hashAcpxProcessCommand,
  normalizeAcpxProcessLease,
  openAcpxProcessLeaseStateStore,
  readAcpxProcessLeaseIdentity,
} from "./process-lease.js";
import { resolveAcpxSessionResource } from "./session-resource.js";

type MigrationInput = Parameters<PluginDoctorStateMigration["migrateLegacyState"]>[0];
type Claim = Awaited<
  ReturnType<NonNullable<MigrationInput["context"]["inspectAcpSessionClaims"]>>
>["claims"][number];

function sessionDirectory(input: MigrationInput): string {
  if (!input.serviceWorkspaceDir) {
    throw new Error(
      "ACP ownership repair requires the Gateway service workspace; upgrade OpenClaw Doctor.",
    );
  }
  return path.join(
    resolveAcpxPluginConfig({
      rawConfig: input.config.plugins?.entries?.acpx?.config,
      workspaceDir: input.serviceWorkspaceDir,
    }).stateDir,
    "sessions",
  );
}

async function legacyRecords(input: MigrationInput): Promise<{ directory: string; ids: string[] }> {
  const directory = sessionDirectory(input);
  const names = await fs.readdir(directory).catch((error: unknown) => {
    if (asObjectRecord(error)?.code === "ENOENT") {
      return [];
    }
    throw error;
  });
  const ids = names
    .filter((name) => name.endsWith(".json"))
    .map((name) => decodeURIComponent(name.slice(0, -5)))
    .filter((id) => !id.startsWith("agent:") && !id.startsWith(".openclaw-owner-"));
  if (ids.length === 0) {
    return { directory, ids };
  }
  const evidence = await input.context.inspectAcpSessionClaims?.();
  const { decodeAcpxRuntimeHandleState } = await import("acpx/runtime");
  return {
    directory,
    ids: ids
      // Already-owned records are identified by canonical claims, never a prefix.
      .filter(
        (id) =>
          !evidence?.claims.some((claim) => {
            const locator = decodeAcpxRuntimeHandleState(claim.meta.runtimeSessionName);
            return (
              evidence.incomplete.length === 0 &&
              claim.meta.identity?.state === "resolved" &&
              claim.meta.identity.acpxRecordId === id &&
              locator?.acpxRecordId === id &&
              locator.name === resolveAcpxSessionResource(claim)
            );
          }),
      )
      .filter(
        (id) =>
          !id.includes(":oneshot:") ||
          evidence?.claims.some((claim) => {
            const locator = decodeAcpxRuntimeHandleState(claim.meta.runtimeSessionName);
            return (
              claim.meta.identity?.acpxRecordId === id &&
              locator?.name !== resolveAcpxSessionResource(claim)
            );
          }),
      )
      .toSorted(),
  };
}

function requireStoppedPid(pid: unknown): void {
  if (pid === undefined || pid === null) {
    return;
  }
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error("record process identity is uncertain");
  }
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (asObjectRecord(error)?.code === "ESRCH") {
      return;
    }
    throw new Error("record process liveness cannot be verified", { cause: error });
  }
  throw new Error("record still has a live process; stop the harness before Doctor repair");
}

function recordPath(directory: string, recordId: string): string {
  return path.join(directory, `${encodeURIComponent(recordId)}.json`);
}

function matchesClaimRecord(
  claim: Claim,
  raw: Record<string, unknown>,
  oldId: string,
  resource: string,
  decode: (typeof import("acpx/runtime"))["decodeAcpxRuntimeHandleState"],
): boolean {
  const state = decode(claim.meta.runtimeSessionName);
  const identity = claim.meta.identity;
  if (
    !state ||
    !identity ||
    identity.state !== "resolved" ||
    (!identity.acpxSessionId && !identity.agentSessionId) ||
    state.mode !== claim.meta.mode
  ) {
    return false;
  }
  const recordId = claim.meta.mode === "oneshot" ? oldId : resource;
  const oldLocator =
    state.name === raw.name && identity.acpxRecordId === oldId && state.acpxRecordId === oldId;
  const newLocator =
    state.name === resource &&
    identity.acpxRecordId === recordId &&
    state.acpxRecordId === recordId;
  return (
    (oldLocator || newLocator) &&
    state.agent === claim.meta.agent &&
    (!identity.acpxSessionId || identity.acpxSessionId === raw.acp_session_id) &&
    (!identity.agentSessionId || identity.agentSessionId === raw.agent_session_id) &&
    (!state.backendSessionId || state.backendSessionId === raw.acp_session_id) &&
    (!state.agentSessionId || state.agentSessionId === raw.agent_session_id)
  );
}

async function migrateRecord(
  input: MigrationInput,
  directory: string,
  oldId: string,
  claims: Claim[],
  changes: string[],
  warnings: string[],
): Promise<void> {
  const sourcePath = recordPath(directory, oldId);
  const sourceBytes = await fs.readFile(sourcePath, "utf8");
  const raw = asObjectRecord(JSON.parse(sourceBytes));
  if (
    !raw ||
    raw.acpx_record_id !== oldId ||
    typeof raw.name !== "string" ||
    !raw.name.trim() ||
    (raw.name !== oldId && !oldId.startsWith(`${raw.name}:oneshot:`))
  ) {
    throw new Error("record ID/name is not a recognized ACPX locator");
  }
  requireStoppedPid(raw.pid);
  const { createFileSessionStore, decodeAcpxRuntimeHandleState, encodeAcpxRuntimeHandleState } =
    await import("acpx/runtime");
  // A roster match alone is never ownership evidence. Canonical metadata and its current
  // entry binding must claim this exact locator and all available upstream identifiers.
  const candidates = claims.filter((claim) =>
    matchesClaimRecord(
      claim,
      raw,
      oldId,
      resolveAcpxSessionResource(claim),
      decodeAcpxRuntimeHandleState,
    ),
  );
  if (candidates.length !== 1) {
    throw new Error("exactly one current canonical owner claim is required");
  }
  const claim = candidates[0]!;
  const resource = resolveAcpxSessionResource(claim);
  const oneshot = claim.meta.mode === "oneshot";
  if (oneshot !== (raw.name !== oldId)) {
    throw new Error("canonical claim and backend record mode disagree");
  }
  // A preceding source repair can make its published destination current during
  // this pass. Its matching claim was verified above; never archive that resource.
  if (!oneshot && oldId === resource) {
    return;
  }
  const recordId = oneshot ? oldId : resource;
  const leaseStore = openAcpxProcessLeaseStateStore(input.context.openPluginStateKeyedStore);
  const leaseRows = await leaseStore.entries();
  const leases = leaseRows.map((row) => ({ row, lease: normalizeAcpxProcessLease(row.value) }));
  if (leases.some(({ lease }) => !lease)) {
    throw new Error("process lease evidence is incomplete");
  }
  const commandIdentity =
    typeof raw.agent_command === "string"
      ? readAcpxProcessLeaseIdentity(raw.agent_command)
      : undefined;
  const matchingLeases = leases.filter(
    ({ lease }) => lease!.sessionKey === raw.name || lease!.sessionKey === resource,
  );
  for (const { lease } of matchingLeases) {
    if (lease!.state === "open" || lease!.state === "closing") {
      throw new Error("record has a live or uncertain process lease");
    }
    requireStoppedPid(lease!.rootPid || undefined);
    if (
      !commandIdentity ||
      lease!.leaseId !== commandIdentity.leaseId ||
      lease!.gatewayInstanceId !== commandIdentity.gatewayInstanceId ||
      lease!.commandHash !== hashAcpxProcessCommand(String(raw.agent_command))
    ) {
      throw new Error("record lease association does not match its persisted command");
    }
  }
  const destinationPath = recordPath(directory, recordId);
  const candidate = oneshot ? raw : { ...raw, acpx_record_id: resource, name: resource };
  const candidateBytes = `${JSON.stringify(candidate, null, 2)}\n`;
  const store = createFileSessionStore({ stateDir: path.dirname(directory) });
  const source = await store.load(oldId);
  if (!source) {
    throw new Error("pinned ACPX reader rejected the source record");
  }
  const temporaryId = `.openclaw-owner-${randomUUID()}`;
  const temporaryPath = recordPath(directory, temporaryId);
  const file = await fs.open(temporaryPath, "wx", 0o600);
  try {
    try {
      await file.writeFile(candidateBytes);
      await file.sync();
    } finally {
      await file.close();
    }
    const interpreted = await store.load(temporaryId);
    if (
      !interpreted ||
      !isDeepStrictEqual(
        interpreted,
        oneshot ? source : { ...source, acpxRecordId: resource, name: resource },
      )
    ) {
      throw new Error("rekey would alter interpreted history/event references; source retained");
    }
    const existing = await fs.readFile(destinationPath, "utf8").catch((error: unknown) => {
      if (asObjectRecord(error)?.code === "ENOENT") {
        return undefined;
      }
      throw error;
    });
    const originalLocator = decodeAcpxRuntimeHandleState(claim.meta.runtimeSessionName)!;
    if (!oneshot && originalLocator.name === resource && existing === undefined) {
      throw new Error("migrated metadata has no published destination; source retained");
    }
    if (existing !== undefined && !isDeepStrictEqual(JSON.parse(existing), candidate)) {
      throw new Error("destination conflicts; no files were overwritten");
    }
    // The source remains the recovery record until both file publication and canonical
    // metadata verification finish. Link publishes atomically without overwriting.
    if (existing === undefined) {
      await fs.link(temporaryPath, destinationPath);
    }
    const publicationDirectory = await fs.open(directory, "r");
    try {
      await publicationDirectory.sync();
    } finally {
      await publicationDirectory.close();
    }
    if ((await fs.readFile(sourcePath, "utf8")) !== sourceBytes) {
      throw new Error("source changed during repair");
    }
    if (!isDeepStrictEqual(JSON.parse(await fs.readFile(destinationPath, "utf8")), candidate)) {
      throw new Error("destination changed during repair");
    }
    for (const { row } of matchingLeases) {
      if (!isDeepStrictEqual(await leaseStore.lookup(row.key), row.value)) {
        throw new Error("lease changed during repair");
      }
      await leaseStore.register(row.key, { ...row.value, sessionKey: resource });
    }
    const state = decodeAcpxRuntimeHandleState(claim.meta.runtimeSessionName)!;
    input.context.updateAcpSessionIdentity!({
      claim,
      runtimeSessionName: encodeAcpxRuntimeHandleState({
        ...state,
        name: resource,
        acpxRecordId: recordId,
      }),
      acpxRecordId: recordId,
    });
    const verified = await input.context.inspectAcpSessionClaims!();
    if (
      verified.incomplete.length ||
      !verified.claims.some(
        (item) =>
          item.agentId === claim.agentId &&
          item.sessionKey === claim.sessionKey &&
          item.meta.identity?.acpxRecordId === recordId &&
          isDeepStrictEqual(item.binding, claim.binding),
      )
    ) {
      throw new Error("canonical metadata verification failed; source retained for rerun");
    }
    changes.push(
      `Migrated ACP backend history for ${claim.agentId}/${claim.sessionKey} to its owner-qualified resource.`,
    );
    // Oneshot IDs are unique physical history locators. Keep their bytes and ID;
    // only the canonical handle and future ensures adopt the owner-qualified name.
    if (!oneshot) {
      await archiveLegacyStateSource({
        filePath: sourcePath,
        label: "ACP owner record",
        changes,
        warnings,
      });
    }
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

export const acpxSessionOwnerMigration: PluginDoctorStateMigration = {
  id: "acpx-session-owner-resources",
  label: "ACP session owners",
  doctorOnly: true,
  phase: "after-session-repair",
  async detectLegacyState(input) {
    const { ids } = await legacyRecords(input);
    return ids.length
      ? {
          preview: [
            `ACP backend has ${ids.length} unqualified record(s). Stop the Gateway and run openclaw doctor --fix; ambiguous histories remain intact.`,
          ],
        }
      : null;
  },
  async migrateLegacyState(input) {
    const changes: string[] = [];
    const warnings: string[] = [];
    if (!input.context.inspectAcpSessionClaims || !input.context.updateAcpSessionIdentity) {
      return {
        changes,
        warnings: ["ACP owner repair requires current offline Doctor maintenance authority."],
      };
    }
    const { directory, ids } = await legacyRecords(input);
    const evidence = await input.context.inspectAcpSessionClaims();
    if (evidence.incomplete.length) {
      return {
        changes,
        warnings: [
          `ACP owner evidence is incomplete; all records retained: ${evidence.incomplete.join("; ")}`,
        ],
      };
    }
    for (const oldId of ids) {
      try {
        const current = await input.context.inspectAcpSessionClaims();
        if (current.incomplete.length) {
          throw new Error("canonical ownership evidence became incomplete");
        }
        await migrateRecord(input, directory, oldId, current.claims, changes, warnings);
      } catch (error) {
        warnings.push(`ACP record ${oldId} retained: ${String(error)}`);
      }
    }
    return { changes, warnings };
  },
};
