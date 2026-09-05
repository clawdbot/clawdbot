// Secrets gateway methods reload runtime secret snapshots and resolve scoped
// command secrets while redacting validation detail to caller-friendly fields.
import {
  ErrorCodes,
  errorShape,
  type ValidationError,
  validateSecretsResolveParams,
  validateSecretsResolveResult,
  validateSecretsStoreDeleteParams,
  validateSecretsStoreListParams,
  validateSecretsStoreListResult,
  validateSecretsStoreMutationResult,
  validateSecretsStoreSetParams,
  type SecretStoreEntry,
} from "../../../packages/gateway-protocol/src/index.js";
import { formatErrorMessage as errorMessage } from "../../infra/errors.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import {
  collectSecretStoreRefKeysInSnapshot,
  getActiveSecretsRuntimeSnapshotState,
} from "../../secrets/runtime-state.js";
import {
  deleteSecretStoreEntry,
  listSecretStoreEntries,
  purgeExpiredSecretStoreEntries,
  SecretStoreValidationError,
  writeSecretStoreEntry,
} from "../../secrets/store/secret-store.js";
import { isKnownCoreSecretTargetId, isKnownSecretTargetId } from "../../secrets/target-registry.js";
import { holdGatewayPolicyResponse } from "../server/ws-policy-close.js";
import { createAgentRuntimeAuthorityGuard } from "./agent-runtime-authority.js";
import type { GatewayClient, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

const teamScope = { kind: "team" } as const;

function toProtocolStoreEntry(
  entry: ReturnType<typeof listSecretStoreEntries>[number],
): SecretStoreEntry {
  const metadata = {
    name: entry.name,
    scopeKind: "team" as const,
    scopeId: "" as const,
    createdAtMs: entry.createdAtMs,
    updatedAtMs: entry.updatedAtMs,
    ...(entry.updatedBy ? { updatedBy: entry.updatedBy } : {}),
  };
  if (entry.kind === "env") {
    if (typeof entry.valuePreview !== "string") {
      throw new Error(`Secret store env metadata is missing its value for ${entry.name}.`);
    }
    return { ...metadata, kind: "env", value: entry.valuePreview };
  }
  return { ...metadata, kind: "secret", allowedHosts: entry.allowedHosts ?? [] };
}

function storeUpdatedBy(client: GatewayClient | null): string {
  return (
    client?.authenticatedUserProfile?.displayName?.trim() ||
    client?.connect?.client?.displayName?.trim() ||
    client?.connect?.client?.id?.trim() ||
    "gateway"
  );
}

type SecretStoreReload = (options?: {
  forceColdRefKeys?: ReadonlySet<string>;
  joinInFlight?: boolean;
}) => Promise<{ warningCount: number }>;

type SecretStoreLogger = {
  warn?: (message: string) => void;
  debug?: (message: string) => void;
};

/** Owns redaction-first store writes and the runtime refresh shared by Gateway RPCs. */
export function createSecretStoreWriteService(params: {
  reloadSecrets: SecretStoreReload;
  log?: SecretStoreLogger;
}) {
  const purgeRetention = () => {
    try {
      purgeExpiredSecretStoreEntries();
    } catch (error) {
      params.log?.warn?.(`secrets.store retention purge failed: ${errorMessage(error)}`);
    }
  };
  const reloadReference = async (
    name: string,
  ): Promise<{ reloaded: boolean; warningCount?: number }> => {
    purgeRetention();
    const snapshot = getActiveSecretsRuntimeSnapshotState();
    const refKeys = snapshot
      ? collectSecretStoreRefKeysInSnapshot(snapshot, name)
      : new Set<string>();
    if (refKeys.size === 0) {
      return { reloaded: false };
    }
    // Explicit replacement must cold-refresh affected owners instead of
    // retaining an older credential from the active runtime snapshot.
    try {
      const reload = await params.reloadSecrets({ forceColdRefKeys: refKeys, joinInFlight: false });
      return { reloaded: true, warningCount: reload.warningCount };
    } catch (error) {
      params.log?.warn?.(`secrets.store runtime refresh failed: ${errorMessage(error)}`);
      throw error;
    }
  };

  return {
    resolveUpdatedBy: storeUpdatedBy,
    reloadReference,
    write(input: Omit<Parameters<typeof writeSecretStoreEntry>[0], "scope" | "database">) {
      // Registration precedes validation and SQLite so even write failures
      // cannot disclose the submitted credential through downstream logging.
      registerSecretValueForRedaction(input.value);
      writeSecretStoreEntry({ scope: teamScope, ...input });
    },
  };
}

export type SecretStoreWriteService = ReturnType<typeof createSecretStoreWriteService>;

function invalidSecretsResolveField(
  errors: ValidationError[] | null | undefined,
):
  | "allowedPaths"
  | "commandName"
  | "forcedActivePaths"
  | "optionalActivePaths"
  | "providerOverrides"
  | "targetIds" {
  // Return the offending top-level field only. Detailed validator output can
  // include paths and schema internals that are not useful for callers here.
  for (const issue of errors ?? []) {
    const instancePath = issue.instancePath ?? "";
    if (
      instancePath === "/commandName" ||
      (instancePath === "" &&
        (String(issue.params?.missingProperty) === "commandName" ||
          (Array.isArray(issue.params?.requiredProperties) &&
            issue.params.requiredProperties.includes("commandName"))))
    ) {
      return "commandName";
    }
    if (instancePath.startsWith("/allowedPaths")) {
      return "allowedPaths";
    }
    if (instancePath.startsWith("/forcedActivePaths")) {
      return "forcedActivePaths";
    }
    if (instancePath.startsWith("/optionalActivePaths")) {
      return "optionalActivePaths";
    }
    if (instancePath.startsWith("/providerOverrides")) {
      return "providerOverrides";
    }
  }
  return "targetIds";
}

export function createSecretsHandlers(params: {
  reloadSecrets: SecretStoreReload;
  storeWriteService: SecretStoreWriteService;
  resolveSecrets: (params: {
    commandName: string;
    targetIds: string[];
    allowedPaths?: string[];
    forcedActivePaths?: string[];
    optionalActivePaths?: string[];
    providerOverrides?: {
      webSearch?: string;
      webFetch?: string;
    };
  }) => Promise<{
    assignments: Array<{
      path: string;
      pathSegments: string[];
      value: unknown;
    }>;
    diagnostics: string[];
    inactiveRefPaths: string[];
  }>;
  log?: SecretStoreLogger;
}): GatewayRequestHandlers {
  return {
    "secrets.reload": async ({ respond }) => {
      try {
        holdGatewayPolicyResponse(respond);
        const result = await params.reloadSecrets();
        respond(true, { ok: true, warningCount: result.warningCount });
      } catch (error) {
        params.log?.warn?.(`secrets.reload failed: ${errorMessage(error)}`);
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "secrets.reload failed"));
      }
    },
    "secrets.resolve": async ({ params: requestParams, respond }) => {
      if (!validateSecretsResolveParams(requestParams)) {
        const field = invalidSecretsResolveField(validateSecretsResolveParams.errors);
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `invalid secrets.resolve params: ${field}`),
        );
        return;
      }
      const commandName = requestParams.commandName.trim();
      if (!commandName) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "invalid secrets.resolve params: commandName"),
        );
        return;
      }
      const targetIds = requestParams.targetIds
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      // Normalize allow/force/optional path lists before resolving so secrets
      // code receives policy paths, not UI whitespace artifacts.
      const allowedPaths = requestParams.allowedPaths
        ?.map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      const forcedActivePaths = requestParams.forcedActivePaths
        ?.map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      const optionalActivePaths = requestParams.optionalActivePaths
        ?.map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      const providerOverrides = {
        ...(requestParams.providerOverrides?.webSearch?.trim()
          ? { webSearch: requestParams.providerOverrides.webSearch.trim() }
          : {}),
        ...(requestParams.providerOverrides?.webFetch?.trim()
          ? { webFetch: requestParams.providerOverrides.webFetch.trim() }
          : {}),
      };

      // Target ids are a closed registry. Reject unknown ids before resolving
      // so callers cannot probe arbitrary config paths through this method.
      for (const targetId of targetIds) {
        if (!isKnownCoreSecretTargetId(targetId) && !isKnownSecretTargetId(targetId)) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              `invalid secrets.resolve params: unknown target id "${String(targetId)}"`,
            ),
          );
          return;
        }
      }

      try {
        const result = await params.resolveSecrets({
          commandName,
          targetIds,
          ...(allowedPaths ? { allowedPaths } : {}),
          ...(forcedActivePaths ? { forcedActivePaths } : {}),
          ...(optionalActivePaths ? { optionalActivePaths } : {}),
          ...(Object.keys(providerOverrides).length > 0 ? { providerOverrides } : {}),
        });
        const payload = {
          ok: true,
          assignments: result.assignments,
          diagnostics: result.diagnostics,
          inactiveRefPaths: result.inactiveRefPaths,
        };
        if (!validateSecretsResolveResult(payload)) {
          // Validate the returned shape as a final boundary check before any
          // secret assignment payload leaves the gateway.
          throw new Error("secrets.resolve returned invalid payload.");
        }
        respond(true, payload);
      } catch (error) {
        params.log?.warn?.(`secrets.resolve failed: ${errorMessage(error)}`);
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "secrets.resolve failed"));
      }
    },
    "secrets.store.list": ({ params: requestParams, respond }) => {
      if (
        !assertValidParams(
          requestParams,
          validateSecretsStoreListParams,
          "secrets.store.list",
          respond,
        )
      ) {
        return;
      }
      try {
        const result = {
          entries: listSecretStoreEntries({ scope: teamScope }).map(toProtocolStoreEntry),
        };
        if (!validateSecretsStoreListResult(result)) {
          throw new Error("secrets.store.list returned invalid payload.");
        }
        respond(true, result);
      } catch (error) {
        params.log?.warn?.(`secrets.store.list failed: ${errorMessage(error)}`);
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "secrets.store.list failed"));
      }
    },
    "secrets.store.set": async ({ params: requestParams, respond, client }) => {
      if (
        !assertValidParams(
          requestParams,
          validateSecretsStoreSetParams,
          "secrets.store.set",
          respond,
        )
      ) {
        return;
      }
      let saved = false;
      try {
        holdGatewayPolicyResponse(respond);
        params.storeWriteService.write({
          name: requestParams.name,
          value: requestParams.value,
          kind: requestParams.kind,
          ...(requestParams.allowedHosts !== undefined
            ? { allowedHosts: requestParams.allowedHosts }
            : {}),
          updatedBy: params.storeWriteService.resolveUpdatedBy(client),
        });
        saved = true;
        const reload = await params.storeWriteService.reloadReference(requestParams.name);
        const result = {
          ok: true as const,
          ...reload,
        };
        if (!validateSecretsStoreMutationResult(result)) {
          throw new Error("secrets.store.set returned invalid payload.");
        }
        respond(true, result);
      } catch (error) {
        if (!saved && error instanceof SecretStoreValidationError) {
          respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
          return;
        }
        params.log?.warn?.(`secrets.store.set failed: ${errorMessage(error)}`);
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            saved
              ? "Secret store entry was saved, but post-write runtime refresh failed. Resolve provider errors and retry secrets.reload."
              : "secrets.store.set failed",
          ),
        );
      }
    },
    "secrets.store.delete": async ({ params: requestParams, respond, client, context }) => {
      if (
        !assertValidParams(
          requestParams,
          validateSecretsStoreDeleteParams,
          "secrets.store.delete",
          respond,
        )
      ) {
        return;
      }
      let deleted = false;
      try {
        const agentId = client?.internal?.agentRuntimeIdentity?.agentId;
        if (agentId) {
          params.log?.debug?.(`secrets.store.delete requested by agent:${agentId}`);
        }
        if (!createAgentRuntimeAuthorityGuard(client, context, respond).ensureActive()) {
          return;
        }
        holdGatewayPolicyResponse(respond);
        deleteSecretStoreEntry({ scope: teamScope, name: requestParams.name });
        deleted = true;
        const reload = await params.storeWriteService.reloadReference(requestParams.name);
        const result = {
          ok: true as const,
          ...reload,
        };
        if (!validateSecretsStoreMutationResult(result)) {
          throw new Error("secrets.store.delete returned invalid payload.");
        }
        respond(true, result);
      } catch (error) {
        if (!deleted && error instanceof SecretStoreValidationError) {
          respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
          return;
        }
        params.log?.warn?.(`secrets.store.delete failed: ${errorMessage(error)}`);
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            deleted
              ? "Secret store entry was deleted, but the active runtime could not refresh. Update the config reference or restore the entry, then retry secrets.reload."
              : "secrets.store.delete failed",
          ),
        );
      }
    },
  };
}
