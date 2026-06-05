// Secrets gateway methods reload runtime secret snapshots and resolve scoped
// command secrets while redacting validation detail to caller-friendly fields.
import {
  ErrorCodes,
  errorShape,
  type ValidationError,
  validateSecretsResolveParams,
  validateSecretsResolveResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { isKnownSecretTargetId } from "../../secrets/target-registry.js";
import type { GatewayRequestHandlers } from "./types.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
  reloadSecrets: () => Promise<{ warningCount: number }>;
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
  log?: {
    warn?: (message: string) => void;
  };
}): GatewayRequestHandlers {
  return {
    "secrets.reload": async ({ respond }) => {
      try {
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
        if (!isKnownSecretTargetId(targetId)) {
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
  };
}
