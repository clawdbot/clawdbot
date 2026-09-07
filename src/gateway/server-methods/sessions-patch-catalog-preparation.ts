import { err, ok, type Result } from "@openclaw/normalization-core/result";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import { prepareSessionsPatchEntry, projectSessionsPatchEntry } from "../sessions-patch.js";
import type { SessionPatchDiagnostics } from "./sessions-patch-diagnostics.js";

export type SessionPatchCatalogResult = Result<ModelCatalogEntry[], unknown>;

export function createSessionPatchCatalogPreparation(
  loadCatalog: (agentId: string) => Promise<ModelCatalogEntry[]>,
  diagnostics?: SessionPatchDiagnostics,
) {
  const preparations = new Map<string, Promise<SessionPatchCatalogResult>>();
  const prepare = (agentId: string) => {
    let promise = preparations.get(agentId);
    if (!promise) {
      promise = (async () => {
        const timing = diagnostics?.scope("catalog");
        try {
          const catalog = await loadCatalog(agentId);
          return ok(Array.isArray(catalog) ? catalog : []);
        } catch (error) {
          return err(error);
        } finally {
          timing?.finish();
        }
      })();
      preparations.set(agentId, promise);
    }
    return promise;
  };
  const load = async (agentId: string) => {
    const catalog = await prepare(agentId);
    if (!catalog.ok) {
      throw catalog.error;
    }
    return catalog.value;
  };
  return {
    prepare,
    load,
    available: async (agentId: string) => {
      const catalog = await preparations.get(agentId);
      // A fresh row may no longer need a failed preparation. Required failures
      // belong at projection use; a committed response consumes available facts.
      return catalog?.ok ? catalog.value : undefined;
    },
    project: async (params: {
      agentId: string;
      mode: "prepare" | "ordered";
      catalog?: SessionPatchCatalogResult;
      projection: Parameters<typeof prepareSessionsPatchEntry>[0];
    }): Promise<
      | { kind: "model-catalog" }
      | { kind: "complete"; result: Awaited<ReturnType<typeof projectSessionsPatchEntry>> }
    > => {
      if (params.mode === "ordered") {
        return {
          kind: "complete",
          result: await projectSessionsPatchEntry({
            ...params.projection,
            loadGatewayModelCatalog: () => load(params.agentId),
          }),
        };
      }
      const projection = prepareSessionsPatchEntry(params.projection);
      if (projection.kind === "complete") {
        return projection;
      }
      if (!params.catalog) {
        return { kind: "model-catalog" };
      }
      if (!params.catalog.ok) {
        throw params.catalog.error;
      }
      return { kind: "complete", result: projection.finish(params.catalog.value) };
    },
  };
}
