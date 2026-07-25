// Canonical Gateway-backed cron inventory and exact-ID/name lookup.
import { randomUUID } from "node:crypto";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type {
  CronListPageOptions,
  CronListPageResult,
} from "../../cron/service/list-page-types.js";
import type { CronDeliveryPreview, CronJob } from "../../cron/types.js";
import type { GatewayRpcOpts } from "../gateway-rpc.js";
import { callGatewayFromCli } from "../gateway-rpc.js";

const CRON_LIST_PAGE_SIZE = 200;
const CRON_LIST_MAX_PAGES = 50;
const CRON_LIST_MAX_SNAPSHOT_RESTARTS = 3;

type GatewayCronListPage = Partial<CronListPageResult> & {
  deliveryPreviews?: Record<string, CronDeliveryPreview>;
};

type GatewayCronJobInventory = GatewayCronListPage & {
  jobs: CronJob[];
  deliveryPreviews?: Record<string, CronDeliveryPreview>;
};

/** Recognize the explicit protocol-v4 capability boundary, not transport failures. */
export function isUnknownCronGetMethodError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    error.name === "GatewayClientRequestError" &&
    (error as Error & { gatewayCode?: unknown }).gatewayCode === "INVALID_REQUEST" &&
    error.message.includes("unknown method: cron.get")
  );
}

/** Read every bounded Gateway page from one complete cron inventory revision. */
export async function listCronJobsFromGateway(
  opts: GatewayRpcOpts,
  filters: Pick<CronListPageOptions, "includeDisabled" | "agentId" | "query">,
  options: { allowLegacyUnversionedPagination?: boolean } = {},
): Promise<GatewayCronJobInventory> {
  let allowLegacyUnversionedPagination = options.allowLegacyUnversionedPagination === true;
  for (let restart = 0; restart <= CRON_LIST_MAX_SNAPSHOT_RESTARTS; restart += 1) {
    let offset = 0;
    let snapshotRevision: string | undefined;
    let total: number | undefined;
    let pageMetadataMode: "canonical" | "legacy" | undefined;
    let firstPage: GatewayCronListPage | undefined;
    let snapshotChanged = false;
    const jobs: CronJob[] = [];
    const deliveryPreviews: Record<string, CronDeliveryPreview> = {};

    for (let pageNumber = 0; pageNumber < CRON_LIST_MAX_PAGES; pageNumber += 1) {
      const page = (await callGatewayFromCli("cron.list", opts, {
        ...filters,
        limit: CRON_LIST_PAGE_SIZE,
        offset,
      })) as GatewayCronListPage | null;

      const hasCanonicalMetadata =
        page !== null &&
        typeof page === "object" &&
        (page.snapshotRevision !== undefined ||
          page.total !== undefined ||
          page.offset !== undefined ||
          page.limit !== undefined);
      if (
        !page ||
        typeof page !== "object" ||
        !Array.isArray(page.jobs) ||
        page.jobs.length > CRON_LIST_PAGE_SIZE ||
        (page.snapshotRevision !== undefined &&
          (typeof page.snapshotRevision !== "string" || page.snapshotRevision.length === 0)) ||
        (page.total !== undefined &&
          (typeof page.total !== "number" ||
            !Number.isSafeInteger(page.total) ||
            page.total < 0)) ||
        (page.offset !== undefined &&
          (typeof page.offset !== "number" ||
            !Number.isSafeInteger(page.offset) ||
            page.offset < 0)) ||
        (page.limit !== undefined &&
          (typeof page.limit !== "number" ||
            !Number.isSafeInteger(page.limit) ||
            page.limit < 1 ||
            page.limit > CRON_LIST_PAGE_SIZE ||
            page.jobs.length > page.limit)) ||
        (page.hasMore !== undefined && typeof page.hasMore !== "boolean") ||
        (hasCanonicalMetadata &&
          (page.snapshotRevision === undefined ||
            page.total === undefined ||
            page.offset === undefined ||
            page.limit === undefined ||
            page.hasMore === undefined ||
            page.nextOffset === undefined))
      ) {
        throw new Error("cron.list returned an invalid inventory page");
      }

      const currentMetadataMode = hasCanonicalMetadata ? "canonical" : "legacy";
      if (pageMetadataMode !== undefined && pageMetadataMode !== currentMetadataMode) {
        // Mixed-version Gateway routes cannot prove legacy rows belong to a
        // later canonical snapshot, even when the apparent job total matches.
        snapshotChanged = true;
        break;
      }

      if (
        (snapshotRevision !== undefined && page.snapshotRevision !== snapshotRevision) ||
        (total !== undefined && page.total !== total)
      ) {
        // Offset pages are snapshots, not a live cursor. Discard the old rows
        // and restart so scheduler churn cannot mix two different inventories.
        snapshotChanged = true;
        break;
      }

      if (page.offset !== undefined && page.offset !== offset) {
        throw new Error("cron.list returned an invalid inventory page");
      }

      if (!hasCanonicalMetadata && !allowLegacyUnversionedPagination) {
        const probeJob = page.jobs[0];
        if (probeJob && (typeof probeJob.id !== "string" || probeJob.id.length === 0)) {
          throw new Error("cron.list returned an invalid inventory page");
        }
        // Empty legacy inventories still need an explicit capability proof;
        // a fresh nonempty ID avoids colliding with actual scheduled jobs.
        const probeJobId = probeJob?.id ?? randomUUID();
        try {
          await callGatewayFromCli("cron.get", opts, { id: probeJobId });
        } catch (error) {
          if (isUnknownCronGetMethodError(error)) {
            // Only an explicitly unsupported cron.get identifies a shipped v4
            // Gateway; malformed modern pages must keep revision checks.
            allowLegacyUnversionedPagination = true;
          } else if (!isMissingCronGetError(error, probeJobId)) {
            throw error;
          }
        }
        if (!allowLegacyUnversionedPagination) {
          throw new Error("cron.list returned an invalid inventory page");
        }
      }

      pageMetadataMode ??= currentMetadataMode;
      firstPage ??= page;
      snapshotRevision ??= page.snapshotRevision;
      total ??= page.total;
      jobs.push(...page.jobs);
      if (page.deliveryPreviews) {
        Object.assign(deliveryPreviews, page.deliveryPreviews);
      }

      if (!page.hasMore) {
        if (
          (total !== undefined && jobs.length !== total) ||
          (page.nextOffset !== undefined && page.nextOffset !== null)
        ) {
          throw new Error("cron.list returned an inconsistent terminal inventory page");
        }
        return {
          ...firstPage,
          jobs,
          ...(Object.keys(deliveryPreviews).length > 0 ? { deliveryPreviews } : {}),
          ...(total !== undefined ? { total } : {}),
          ...(snapshotRevision !== undefined ? { snapshotRevision } : {}),
          ...(firstPage.offset !== undefined ? { offset: firstPage.offset } : {}),
          ...(firstPage.limit !== undefined ? { limit: firstPage.limit } : {}),
          ...(firstPage.hasMore !== undefined ? { hasMore: false, nextOffset: null } : {}),
        };
      }

      if (
        typeof page.nextOffset !== "number" ||
        !Number.isSafeInteger(page.nextOffset) ||
        page.nextOffset <= offset ||
        (total !== undefined && page.nextOffset !== offset + page.jobs.length)
      ) {
        throw new Error("cron.list pagination did not advance while looking up cron job");
      }
      offset = page.nextOffset;
    }

    if (!snapshotChanged) {
      throw new Error("cron.list pagination exceeded maximum pages while looking up cron job");
    }
    if (restart === CRON_LIST_MAX_SNAPSHOT_RESTARTS) {
      throw new Error("cron.list inventory changed repeatedly while reading cron jobs");
    }
  }

  throw new Error("cron.list inventory changed repeatedly while reading cron jobs");
}

function isMissingCronGetError(error: unknown, id: string): error is Error {
  return (
    isUnknownCronGetMethodError(error) ||
    (error instanceof Error &&
      error.name === "GatewayClientRequestError" &&
      (error as Error & { gatewayCode?: unknown }).gatewayCode === "INVALID_REQUEST" &&
      error.message.includes(`cron job not found: ${id}`))
  );
}

/** Resolve stable IDs before exact names without trusting page order. */
export async function findCronJobByIdOrName(
  opts: GatewayRpcOpts,
  idOrName: string,
  options: { includeDeliveryPreview?: boolean } = {},
): Promise<{ job?: CronJob; deliveryPreview?: CronDeliveryPreview }> {
  let allowLegacyUnversionedPagination = false;
  try {
    const directJob = (await callGatewayFromCli("cron.get", opts, { id: idOrName })) as
      | CronJob
      | undefined;
    if (directJob?.id === idOrName) {
      if (!options.includeDeliveryPreview) {
        return { job: directJob };
      }
      const inventory = await listCronJobsFromGateway(opts, {
        includeDisabled: true,
        query: idOrName,
      });
      return { job: directJob, deliveryPreview: inventory.deliveryPreviews?.[directJob.id] };
    }
  } catch (error) {
    if (!isMissingCronGetError(error, idOrName)) {
      throw error;
    }
    // Only protocol-v4 Gateways lack both cron.get and revisioned pages.
    allowLegacyUnversionedPagination = isUnknownCronGetMethodError(error);
  }

  const inventory = await listCronJobsFromGateway(
    opts,
    { includeDisabled: true },
    { allowLegacyUnversionedPagination },
  );
  const needle = normalizeLowercaseStringOrEmpty(idOrName);
  const job =
    inventory.jobs.find((candidate) => normalizeLowercaseStringOrEmpty(candidate.id) === needle) ??
    inventory.jobs.find((candidate) => normalizeLowercaseStringOrEmpty(candidate.name) === needle);
  return { job, deliveryPreview: job ? inventory.deliveryPreviews?.[job.id] : undefined };
}
