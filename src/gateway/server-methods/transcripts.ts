import {
  ErrorCodes,
  errorShape,
  validateTranscriptsListParams,
  validateTranscriptsGetParams,
  validateTranscriptsExportParams,
  validateTranscriptsStatusParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveStateDir } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createTranscriptsStore } from "../../transcripts/capture-operations.js";
import { resolveSourceProvider } from "../../transcripts/capture.js";
import {
  exportTranscriptLibrary,
  getTranscriptLibrary,
  listTranscriptLibrary,
} from "../../transcripts/library.js";
import { readTranscriptLibraryStatus } from "../../transcripts/status.js";
import { TranscriptLibraryError } from "../../transcripts/store-read.js";
import type { TranscriptsStore } from "../../transcripts/store.js";
import { operatorSessionCap } from "../operator-role-policy.js";
import { isGatewayAdmin } from "../session-sharing.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestHandler, GatewayRequestHandlers } from "./types.js";
import { assertValidParams, type Validator } from "./validation.js";

function transcriptReadMethod<T>(
  method: string,
  validate: Validator<T>,
  read: (store: TranscriptsStore, params: T, cfg: OpenClawConfig) => unknown,
): GatewayRequestHandler {
  return async ({ params, context, client, respond }) => {
    if (!assertValidParams(params, validate, method, respond)) {
      return;
    }
    const cfg = context.getRuntimeConfig();
    // Meeting rows have agent attribution but no person owner. Mirror global
    // aggregate visibility; an agent filter cannot make hidden archive data readable.
    if (!isGatewayAdmin(client) && operatorSessionCap(client, cfg) === "none") {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.FORBIDDEN,
          "The transcript archive includes sessions hidden by your operator role; ask a Gateway administrator for archive access.",
        ),
      );
      return;
    }
    try {
      const store = createTranscriptsStore({
        stateDir: resolveStateDir(),
        config: cfg,
        logger: console,
      });
      respond(true, await read(store, params, cfg));
    } catch (error) {
      if (!(error instanceof TranscriptLibraryError)) {
        context.logGateway.warn(`${method} failed: ${formatForLog(error)}`);
      }
      respond(
        false,
        undefined,
        error instanceof TranscriptLibraryError
          ? errorShape(ErrorCodes.INVALID_REQUEST, error.message, {
              details: {
                type: error.type,
                ...(error.maxBytes !== undefined ? { maxBytes: error.maxBytes } : {}),
              },
            })
          : errorShape(
              ErrorCodes.UNAVAILABLE,
              "The transcript archive could not be read. Check Gateway diagnostics and retry.",
            ),
      );
    }
  };
}

export const transcriptsHandlers: GatewayRequestHandlers = {
  "transcripts.list": transcriptReadMethod(
    "transcripts.list",
    validateTranscriptsListParams,
    (store, params, cfg) => listTranscriptLibrary(store, params, providerNames(cfg)),
  ),
  "transcripts.get": transcriptReadMethod(
    "transcripts.get",
    validateTranscriptsGetParams,
    (store, params, cfg) => getTranscriptLibrary(store, params, providerNames(cfg)),
  ),
  "transcripts.export": transcriptReadMethod(
    "transcripts.export",
    validateTranscriptsExportParams,
    exportTranscriptLibrary,
  ),
  "transcripts.status": transcriptReadMethod(
    "transcripts.status",
    validateTranscriptsStatusParams,
    (store, _params, cfg) => readTranscriptLibraryStatus(store, cfg),
  ),
};

function providerNames(config: OpenClawConfig) {
  const names = new Map<string, string | undefined>();
  return (providerId: string) => {
    if (!names.has(providerId)) {
      names.set(
        providerId,
        resolveSourceProvider(providerId, {
          config,
          stateDir: resolveStateDir(),
          logger: console,
        })?.name,
      );
    }
    return names.get(providerId);
  };
}
