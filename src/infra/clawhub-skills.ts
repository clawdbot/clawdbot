// ClawHub skill metadata, trust, install resolution, cards, and telemetry.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  createClawHubError,
  decodeClawHubResponseBody,
  fetchClawHubJson,
  isClawHubTelemetryDisabled,
  parseClawHubJsonBody,
  readClawHubBytes,
  requestClawHub,
  resolveClawHubAuthToken,
  resolveClawHubBaseUrl,
  resolveClawHubImageUrl,
  type ClawHubFetch,
} from "./clawhub-client.js";

const SKILL_CARD_MAX_BYTES = 256 * 1024;

export const CLAWHUB_SKILLS_SH_TRUST_STATE = "not-scanned-by-clawhub" as const;
export const CLAWHUB_SKILLS_SH_TRUST_LABEL = "Not scanned by ClawHub" as const;
/** Marks a reference ClawHub resolves from an external source it never scanned. */
export const CLAWHUB_SKILLS_SH_REF_PREFIX = "skills-sh:" as const;
export type ClawHubSkillsShTrustState = typeof CLAWHUB_SKILLS_SH_TRUST_STATE;

export type ClawHubSkillSearchResult = {
  score: number;
  slug: string;
  /**
   * Reference install must send back. Search returns the same slug for several publishers, so
   * the bare slug alone resolves to 409 AMBIGUOUS_SKILL_SLUG. This names the result's own
   * source: rewriting an external reference into `@owner/slug` would install a different skill.
   */
  installRef: string;
  /**
   * Set only for sources ClawHub serves install-only, so clients install directly instead of
   * opening a detail card that cannot resolve. Absence means the ordinary review-then-install
   * flow, which is what every released Gateway already implies by omitting this field.
   */
  installOnly?: true;
  trustState?: ClawHubSkillsShTrustState;
  // Search may return the same slug for multiple publishers; exact install refs need this handle.
  ownerHandle?: string | null;
  displayName: string;
  summary?: string;
  icon?: string | null;
  version?: string;
  updatedAt?: number;
};

/** Source variants ClawHub resolves search results from. Anything else is unidentifiable. */
const CLAWHUB_NATIVE_SOURCE_KIND = "clawhub";
const CLAWHUB_SKILLS_SH_SOURCE_KIND = "skills-sh";
const CLAWHUB_SUPPORTED_INSTALL_KINDS = new Set(["clawhub", "github", "skills-sh"]);

/**
 * Wire shape of one `/api/v1/search` row. ClawHub reports each result's origin under `install`,
 * never as a flat `installRef`, so the mapping below is what keeps search identity honest.
 */
type ClawHubSkillSearchWireEntry = Omit<
  ClawHubSkillSearchResult,
  "installRef" | "installOnly" | "trustState"
> & {
  source?: string | null;
  install?: { kind?: string | null; reference?: string | null } | null;
};

export type ClawHubSkillDetail = {
  skill: {
    slug: string;
    displayName: string;
    summary?: string;
    icon?: string | null;
    tags?: Record<string, string>;
    channel?: string | null;
    isOfficial?: boolean | null;
    createdAt: number;
    updatedAt: number;
  } | null;
  latestVersion?: {
    version: string;
    createdAt: number;
    changelog?: string;
  } | null;
  metadata?: {
    os?: string[] | null;
    systems?: string[] | null;
  } | null;
  owner?: {
    handle?: string | null;
    displayName?: string | null;
    image?: string | null;
    official?: boolean | null;
    channel?: string | null;
    isOfficial?: boolean | null;
  } | null;
};

export type ClawHubSkillInstallResolutionResponse =
  | {
      ok: true;
      slug: string;
      channel?: string | null;
      isOfficial?: boolean | null;
      installKind: "archive";
      archive: {
        version: string;
        downloadUrl: string;
        channel?: string | null;
        isOfficial?: boolean | null;
      };
    }
  | {
      ok: true;
      slug: string;
      channel?: string | null;
      isOfficial?: boolean | null;
      installKind: "github";
      trust?: {
        state: ClawHubSkillsShTrustState;
      };
      /** Commit-pinned source approved by ClawHub's install resolver policy. */
      github: {
        repo: string;
        path: string;
        commit: string;
        contentHash: string;
        sourceUrl: string;
      };
    }
  | {
      ok: false;
      slug: string;
      reason: string;
      message: string;
      status: number;
    };

type ClawHubSkillVerificationDecision = "pass" | "fail" | (string & {});

export type ClawHubSkillVerificationResponse = {
  schema: "clawhub.skill.verify.v1";
  ok: boolean;
  decision: ClawHubSkillVerificationDecision;
  reasons: string[];
  slug?: string | null;
  displayName?: string | null;
  pageUrl?: string | null;
  publisherHandle?: string | null;
  publisherDisplayName?: string | null;
  createdAt?: number | null;
  skill: unknown;
  publisher: unknown;
  version: unknown;
  card: unknown;
  artifact: unknown;
  provenance: unknown;
  security: unknown;
  signature: unknown;
};

type ClawHubSkillSecurityVerdictRequestItem = {
  slug: string;
  ownerHandle?: string;
  version: string;
};

export type ClawHubSkillSecurityVerdictItem = {
  ok: boolean;
  decision: ClawHubSkillVerificationDecision;
  reasons: string[];
  requestedSlug: string;
  requestedOwnerHandle?: string;
  requestedVersion: string;
  slug?: string | null;
  version?: string | null;
  displayName?: string | null;
  publisherHandle?: string | null;
  publisherDisplayName?: string | null;
  createdAt?: number | null;
  checkedAt?: number | null;
  skillUrl?: string | null;
  overview?: string | null;
  securityAuditUrl?: string | null;
  security?: unknown;
  error?: {
    code?: string;
    message?: string;
  };
};

type ClawHubSkillSecurityVerdictsResponse = {
  schema: "clawhub.skill.security-verdicts.v1";
  items: ClawHubSkillSecurityVerdictItem[];
};

function buildVersionOrTagSearch(params: {
  version?: string;
  tag?: string;
  ownerHandle?: string;
}): { version?: string; tag?: string; ownerHandle?: string } | undefined {
  const version = normalizeOptionalString(params.version);
  const ownerHandle = normalizeOptionalString(params.ownerHandle);
  if (version) {
    return { version, ...(ownerHandle ? { ownerHandle } : {}) };
  }
  const tag = normalizeOptionalString(params.tag);
  if (tag) {
    return { tag, ...(ownerHandle ? { ownerHandle } : {}) };
  }
  return ownerHandle ? { ownerHandle } : undefined;
}

export async function searchClawHubSkills(params: {
  query: string;
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
  fetchImpl?: ClawHubFetch;
  limit?: number;
}): Promise<ClawHubSkillSearchResult[]> {
  const result = await fetchClawHubJson<{ results: ClawHubSkillSearchWireEntry[] }>({
    baseUrl: params.baseUrl,
    path: "/api/v1/search",
    token: params.token,
    timeoutMs: params.timeoutMs,
    fetchImpl: params.fetchImpl,
    search: {
      q: params.query.trim(),
      limit: params.limit ? String(params.limit) : undefined,
    },
  });
  return (result.results ?? []).flatMap((entry) => {
    const mapped = toClawHubSkillSearchResult(entry, params.baseUrl);
    return mapped ? [mapped] : [];
  });
}

/**
 * Records each result's own source once, here, so no consumer rebuilds it. A row whose source is
 * unknown, or whose external reference is missing, is dropped rather than published under
 * `@owner/slug`: that spelling would point install at a different publisher's skill.
 */
function toClawHubSkillSearchResult(
  entry: ClawHubSkillSearchWireEntry,
  baseUrl?: string,
): ClawHubSkillSearchResult | undefined {
  const { install: _install, source: _source, ...rest } = entry;
  const base = { ...rest, icon: resolveClawHubImageUrl(entry.icon, baseUrl) };
  const source = normalizeOptionalString(entry.source);
  const installKind = normalizeOptionalString(entry.install?.kind);
  const reference = normalizeOptionalString(entry.install?.reference);
  // Source identifies the catalog row. Install kind only describes how ClawHub will deliver it:
  // native ClawHub rows may legitimately be GitHub-backed.
  if (installKind && !CLAWHUB_SUPPORTED_INSTALL_KINDS.has(installKind)) {
    return undefined;
  }
  switch (source) {
    case CLAWHUB_SKILLS_SH_SOURCE_KIND: {
      // An external row is only installable as itself. Without its own reference there is no
      // identity to install, so the row cannot be offered at all.
      if (!reference?.startsWith(CLAWHUB_SKILLS_SH_REF_PREFIX)) {
        return undefined;
      }
      return {
        ...base,
        installRef: reference,
        installOnly: true,
        trustState: CLAWHUB_SKILLS_SH_TRUST_STATE,
      };
    }
    case CLAWHUB_NATIVE_SOURCE_KIND: {
      // Native rows report `owner/slug`; this repo's reference grammar is `@owner/slug`. Without
      // a publisher the bare slug answers 409 AMBIGUOUS_SKILL_SLUG for every action.
      const ownerHandle = normalizeOptionalString(entry.ownerHandle);
      return ownerHandle ? { ...base, installRef: `@${ownerHandle}/${entry.slug}` } : undefined;
    }
    default:
      return undefined;
  }
}

export async function fetchClawHubSkillDetail(params: {
  slug: string;
  ownerHandle?: string;
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
  fetchImpl?: ClawHubFetch;
}): Promise<ClawHubSkillDetail> {
  const detail = await fetchClawHubJson<ClawHubSkillDetail>({
    baseUrl: params.baseUrl,
    path: `/api/v1/skills/${encodeURIComponent(params.slug)}`,
    token: params.token,
    timeoutMs: params.timeoutMs,
    fetchImpl: params.fetchImpl,
    search: params.ownerHandle ? { ownerHandle: params.ownerHandle } : undefined,
  });
  return {
    ...detail,
    skill: detail.skill
      ? {
          ...detail.skill,
          icon: resolveClawHubImageUrl(detail.skill.icon, params.baseUrl),
        }
      : null,
  };
}

export async function fetchClawHubSkillInstallResolution(params: {
  slug: string;
  ownerHandle?: string;
  requestedReference?: string;
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
  fetchImpl?: ClawHubFetch;
  forceInstall?: boolean;
}): Promise<ClawHubSkillInstallResolutionResponse> {
  const { response, url, hasToken } = await requestClawHub({
    baseUrl: params.baseUrl,
    path: `/api/v1/skills/${encodeURIComponent(params.slug)}/install`,
    token: params.token,
    timeoutMs: params.timeoutMs,
    fetchImpl: params.fetchImpl,
    search: {
      ownerHandle: params.ownerHandle,
      reference: params.requestedReference,
      forceInstall: params.forceInstall ? "1" : undefined,
    },
  });
  const isStructuredBlock = [403, 409, 410, 423].includes(response.status);
  if (!response.ok && !isStructuredBlock) {
    throw await createClawHubError(response, url, hasToken, params.timeoutMs);
  }
  return parseClawHubJsonBody<ClawHubSkillInstallResolutionResponse>(
    response,
    url,
    params.timeoutMs,
  );
}

export async function fetchClawHubSkillVerification(params: {
  slug: string;
  ownerHandle?: string;
  requestedReference?: string;
  version?: string;
  tag?: string;
  baseUrl?: string;
  token?: string;
  skipAuth?: boolean;
  timeoutMs?: number;
  fetchImpl?: ClawHubFetch;
}): Promise<ClawHubSkillVerificationResponse> {
  return await fetchClawHubJson<ClawHubSkillVerificationResponse>({
    baseUrl: params.baseUrl,
    path: `/api/v1/skills/${encodeURIComponent(params.slug)}/verify`,
    token: params.token,
    skipAuth: params.skipAuth,
    timeoutMs: params.timeoutMs,
    fetchImpl: params.fetchImpl,
    search: {
      ...buildVersionOrTagSearch(params),
      reference: params.requestedReference,
    },
  });
}

export async function fetchClawHubSkillSecurityVerdicts(params: {
  items: ClawHubSkillSecurityVerdictRequestItem[];
  baseUrl?: string;
  token?: string;
  skipAuth?: boolean;
  timeoutMs?: number;
  fetchImpl?: ClawHubFetch;
}): Promise<ClawHubSkillSecurityVerdictsResponse> {
  return await fetchClawHubJson<ClawHubSkillSecurityVerdictsResponse>({
    baseUrl: params.baseUrl,
    path: "/api/v1/skills/-/security-verdicts",
    method: "POST",
    json: { items: params.items },
    token: params.token,
    skipAuth: params.skipAuth,
    timeoutMs: params.timeoutMs,
    fetchImpl: params.fetchImpl,
  });
}

export async function fetchClawHubSkillCard(params: {
  slug?: string;
  ownerHandle?: string;
  url?: string;
  version?: string;
  tag?: string;
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
  fetchImpl?: ClawHubFetch;
}): Promise<string> {
  const cardUrl = normalizeOptionalString(params.url);
  const slug = normalizeOptionalString(params.slug);
  if (!cardUrl && !slug) {
    throw new Error("ClawHub skill card fetch requires a slug or card URL");
  }
  const providedToken = normalizeOptionalString(params.token);
  const skipAuth =
    cardUrl != null &&
    providedToken == null &&
    new URL(cardUrl, `${resolveClawHubBaseUrl(params.baseUrl)}/`).origin !==
      new URL(`${resolveClawHubBaseUrl(params.baseUrl)}/`).origin;
  const { response, url, hasToken } = await requestClawHub({
    baseUrl: params.baseUrl,
    url: cardUrl,
    path: slug ? `/api/v1/skills/${encodeURIComponent(slug)}/card` : undefined,
    token: providedToken,
    timeoutMs: params.timeoutMs,
    fetchImpl: params.fetchImpl,
    search: cardUrl ? undefined : buildVersionOrTagSearch(params),
    skipAuth,
  });
  if (!response.ok) {
    throw await createClawHubError(response, url, hasToken, params.timeoutMs);
  }
  const bytes = await readClawHubBytes({
    response,
    maxBytes: SKILL_CARD_MAX_BYTES,
    timeoutMs: params.timeoutMs,
    resourceLabel: slug ? `skill card for ${slug}` : `skill card at ${url.pathname}`,
  });
  return decodeClawHubResponseBody(bytes);
}

export async function reportClawHubSkillInstallTelemetry(params: {
  baseUrl?: string;
  token?: string;
  slug: string;
  ownerHandle?: string;
  requestedReference?: string;
  trustState?: ClawHubSkillsShTrustState;
  version?: string | null;
  timeoutMs?: number;
  fetchImpl?: ClawHubFetch;
}): Promise<void> {
  const token = normalizeOptionalString(params.token) ?? (await resolveClawHubAuthToken());
  if (!token || isClawHubTelemetryDisabled()) {
    return;
  }
  const slug = params.slug.trim();
  if (!slug) {
    return;
  }

  const { response, url, hasToken } = await requestClawHub({
    baseUrl: params.baseUrl,
    path: "/api/cli/telemetry/install",
    method: "POST",
    token,
    timeoutMs: params.timeoutMs,
    fetchImpl: params.fetchImpl,
    json: {
      event: "install",
      slug,
      ...(params.ownerHandle ? { ownerHandle: params.ownerHandle } : {}),
      ...(params.requestedReference ? { reference: params.requestedReference } : {}),
      ...(params.trustState ? { trustState: params.trustState } : {}),
      version: params.version ?? undefined,
    },
  });
  if (!response.ok) {
    throw await createClawHubError(response, url, hasToken, params.timeoutMs);
  }
}
