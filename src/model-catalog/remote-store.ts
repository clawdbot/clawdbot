import { updateConfigMachineState } from "../state/config-machine-state-write.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";

type RemoteModelCatalogStoreRow = {
  id: number;
  bundle_json: string;
  generated_at: number;
  min_version: string | null;
  source_url: string;
  etag: string | null;
  last_modified: string | null;
  checked_at: number;
};

type RemoteModelCatalogSnapshot = Omit<RemoteModelCatalogStoreRow, "id">;

type RemoteModelCatalogWriteResult =
  | { status: "written" }
  | { status: "retained-newer"; row: RemoteModelCatalogStoreRow };

const REMOTE_MODEL_CATALOG_STATE_KEY = "modelCatalog.remote";

export function readRemoteModelCatalog(
  options: OpenClawStateDatabaseOptions = {},
): RemoteModelCatalogStoreRow | undefined {
  const snapshot = readConfigMachineState<RemoteModelCatalogSnapshot>(
    REMOTE_MODEL_CATALOG_STATE_KEY,
    options,
  );
  return snapshot ? { id: 1, ...snapshot } : undefined;
}

export function writeRemoteModelCatalog(
  row: RemoteModelCatalogSnapshot,
  options: OpenClawStateDatabaseOptions = {},
): RemoteModelCatalogWriteResult {
  let result: RemoteModelCatalogWriteResult = { status: "written" };
  updateConfigMachineState<RemoteModelCatalogSnapshot>(
    REMOTE_MODEL_CATALOG_STATE_KEY,
    (current) => {
      // CLI and Gateway refreshes race across processes; compare inside the write transaction.
      if (
        current &&
        current.source_url === row.source_url &&
        (current.generated_at > row.generated_at ||
          (current.generated_at === row.generated_at && current.bundle_json !== row.bundle_json))
      ) {
        result = { status: "retained-newer", row: { id: 1, ...current } };
        return current;
      }
      return row;
    },
    options,
  );
  return result;
}

export function markRemoteModelCatalogChecked(
  checkedAt: number,
  metadata: {
    expected: Pick<
      RemoteModelCatalogStoreRow,
      "source_url" | "generated_at" | "etag" | "last_modified"
    >;
    etag?: string | null;
    lastModified?: string | null;
  },
  options: OpenClawStateDatabaseOptions = {},
): boolean {
  let matched = false;
  updateConfigMachineState<RemoteModelCatalogSnapshot>(
    REMOTE_MODEL_CATALOG_STATE_KEY,
    (current) => {
      if (!current) {
        return undefined;
      }
      if (
        current.source_url !== metadata.expected.source_url ||
        current.generated_at !== metadata.expected.generated_at ||
        current.etag !== metadata.expected.etag ||
        current.last_modified !== metadata.expected.last_modified
      ) {
        return current;
      }
      matched = true;
      return {
        ...current,
        checked_at: checkedAt,
        ...(metadata.etag !== undefined ? { etag: metadata.etag } : {}),
        ...(metadata.lastModified !== undefined ? { last_modified: metadata.lastModified } : {}),
      };
    },
    options,
  );
  return matched;
}
