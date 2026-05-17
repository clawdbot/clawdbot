import type { ErrorObject } from "ajv";
import { isKnownSecretTargetId } from "../../secrets/target-registry.js";
import {
  ErrorCodes,
  errorShape,
  validateSecretsResolveParams,
  validateSecretsResolveResult,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

type SecretsResolveProviderOverrides = {
  webSearch?: string;
  webFetch?: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invalidSecretsResolveField(
  errors: ErrorObject[] | null | undefined,
): "commandName" | "targetIds" | "providerOverrides" {
  for (const issue of errors ?? []) {
    if (
      issue.instancePath === "/commandName" ||
      (issue.instancePath === "" &&
        String((issue.params as { missingProperty?: unknown })?.missingProperty) === "commandName")
    ) {
      return "commandName";
    }
    if (issue.instancePath.startsWith("/providerOverrides")) {
      return "providerOverrides";
    }
  }
  return "targetIds";
}

function normalizeSecretsResolveProviderOverrides(
  overrides: { webSearch?: string; webFetch?: string } | undefined,
): SecretsResolveProviderOverrides | undefined {
  const webSearch = overrides?.webSearch?.trim();
  const webFetch = overrides?.webFetch?.trim();
  if (!webSearch && !webFetch) {
    return undefined;
  }
  return {
    ...(webSearch ? { webSearch } : {}),
    ...(webFetch ? { webFetch } : {}),
  };
}

export function createSecretsHandlers(params: {
  reloadSecrets: () => Promise<{ warningCount: number }>;
  resolveSecrets: (params: {
    commandName: string;
    targetIds: string[];
    providerOverrides?: SecretsResolveProviderOverrides;
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
      const providerOverrides = normalizeSecretsResolveProviderOverrides(
        requestParams.providerOverrides,
      );

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
          ...(providerOverrides ? { providerOverrides } : {}),
        });
        const payload = {
          ok: true,
          assignments: result.assignments,
          diagnostics: result.diagnostics,
          inactiveRefPaths: result.inactiveRefPaths,
        };
        if (!validateSecretsResolveResult(payload)) {
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
