import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { readSessionRuntimeOwnership } from "../../agents/harness/session-runtime-ownership.js";
import { resolveSessionModelRef } from "../../agents/session-model-ref.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ChatMetadataReadParams, ChatMetadataResult } from "./chat-metadata-contract.js";

// Read session ownership after the shared profile projection; never cache this overlay.
export function projectChatSessionMetadata(
  readParams: ChatMetadataReadParams,
  metadata: ChatMetadataResult,
  config: OpenClawConfig,
): ChatMetadataResult {
  const ownership = readSessionRuntimeOwnership({ ...readParams, config });
  if (ownership?.auth !== "native" || !metadata.models) {
    return metadata;
  }
  // Pending native branches have no tuple yet. Remove the host-only gate from
  // the rendered placeholder, without calling it a native selection or proving credentials.
  const renderedModel =
    ownership.modelRef ??
    resolveSessionModelRef(config, readParams.sessionEntry, readParams.agentId, {
      allowPluginNormalization: false,
    });
  return {
    ...metadata,
    models: metadata.models.map((model) => {
      const row = asOptionalRecord(model);
      if (row?.provider !== renderedModel.provider || row.id !== renderedModel.model) {
        return model;
      }
      const {
        available: _available,
        unavailableReason: _reason,
        unavailableUntil: _until,
        ...native
      } = row;
      return native;
    }),
  };
}
