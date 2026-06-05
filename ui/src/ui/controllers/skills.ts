// Control UI controller manages skills gateway state.
import type { GatewayBrowserClient } from "../gateway.ts";
import type { SkillClawHubLink, SkillStatusEntry, SkillStatusReport } from "../types.ts";

export type ClawHubSearchResult = {
  score: number;
  slug: string;
  displayName: string;
  summary?: string;
  version?: string;
  updatedAt?: number;
};

export type ClawHubSkillDetail = {
  skill: {
    slug: string;
    displayName: string;
    summary?: string;
    tags?: Record<string, string>;
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
  } | null;
};

export type ClawHubSkillSecurityVerdict = {
  registry: string;
  ok: boolean;
  decision: string;
  reasons: string[];
  requestedSlug: string;
  requestedVersion: string;
  slug?: string | null;
  version?: string | null;
  displayName?: string | null;
  publisherHandle?: string | null;
  publisherDisplayName?: string | null;
  createdAt?: number | null;
  checkedAt?: number | null;
  skillUrl?: string | null;
  securityAuditUrl?: string | null;
  securityStatus?: string | null;
  securityPassed?: boolean | null;
  error?: {
    code?: string;
    message?: string;
  };
};

export type SkillsState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  skillsLoading: boolean;
  skillsReport: SkillStatusReport | null;
  skillsError: string | null;
  skillsBusyKey: string | null;
  skillEdits: Record<string, string>;
  skillMessages: SkillMessageMap;
  clawhubSearchQuery: string;
  clawhubSearchResults: ClawHubSearchResult[] | null;
  clawhubSearchLoading: boolean;
  clawhubSearchError: string | null;
  clawhubDetail: ClawHubSkillDetail | null;
  clawhubDetailSlug: string | null;
  clawhubDetailLoading: boolean;
  clawhubDetailError: string | null;
  clawhubInstallSlug: string | null;
  clawhubInstallMessage: { kind: "success" | "error"; text: string } | null;
  clawhubVerdicts: Record<string, ClawHubSkillSecurityVerdict>;
  clawhubVerdictsLoading: boolean;
  clawhubVerdictsError: string | null;
  skillCardContents: Record<string, string>;
  skillCardContentKeys: Record<string, string>;
  skillCardLoadingKey: string | null;
  skillCardErrors: Record<string, string>;
};

export type SkillMessage = {
  kind: "success" | "error";
  message: string;
};

export type SkillMessageMap = Record<string, SkillMessage>;

function setSkillMessage(state: SkillsState, key: string, message: SkillMessage) {
  if (!key.trim()) {
    return;
  }
  state.skillMessages = { ...state.skillMessages, [key]: message };
}

const getErrorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function clawhubVerdictKey(target: {
  registry: string;
  slug: string;
  version: string;
}): string {
  return `${target.registry}\0${target.slug}\0${target.version}`;
}

function isValidClawHubLink(
  link: SkillClawHubLink | undefined,
): link is Extract<SkillClawHubLink, { status: "linked"; valid: true }> {
  return Boolean(link && link.status === "linked" && link.valid);
}

function reportHasLinkedClawHubSkills(report: SkillStatusReport): boolean {
  return report.skills.some((skill) => isValidClawHubLink(skill.clawhub));
}

function skillCardCacheKey(skill: SkillStatusEntry): string | undefined {
  if (!skill.skillCard?.present) {
    return undefined;
  }
  const installedVersion =
    skill.clawhub?.status === "linked" && skill.clawhub.valid ? skill.clawhub.installedVersion : "";
  return `${skill.skillCard.path}\0${skill.skillCard.sizeBytes}\0${installedVersion}`;
}

function currentSkillCardCacheKey(state: SkillsState, skillKey: string): string | undefined {
  const skill = state.skillsReport?.skills.find((entry) => entry.skillKey === skillKey);
  return skill ? skillCardCacheKey(skill) : undefined;
}

async function runStaleAwareRequest<T>(
  isCurrent: () => boolean,
  request: () => Promise<T>,
  onSuccess: (value: T) => void,
  onError: (err: unknown) => void,
  onFinally: () => void,
) {
  try {
    const result = await request();
    if (!isCurrent()) {
      return;
    }
    onSuccess(result);
  } catch (err) {
    if (!isCurrent()) {
      return;
    }
    onError(err);
  }
  onFinally();
}

export function setClawHubSearchQuery(state: SkillsState, query: string) {
  state.clawhubSearchQuery = query;
  state.clawhubInstallMessage = null;
  state.clawhubSearchResults = null;
  state.clawhubSearchError = null;
  state.clawhubSearchLoading = false;
}

export async function loadSkills(state: SkillsState, options?: { clearMessages?: boolean }) {
  if (options?.clearMessages && Object.keys(state.skillMessages).length > 0) {
    state.skillMessages = {};
  }
  if (!state.client || !state.connected || state.skillsLoading) {
    return;
  }
  state.skillsLoading = true;
  state.skillsError = null;
  try {
    const res = await state.client.request<SkillStatusReport | undefined>("skills.status", {});
    if (res && Array.isArray(res.skills)) {
      state.skillsReport = res;
      pruneSkillCardState(state, res);
      void loadClawHubSecurityVerdicts(state, res);
    }
  } catch (err) {
    state.skillsError = getErrorMessage(err);
  } finally {
    state.skillsLoading = false;
  }
}

function pruneSkillCardState(state: SkillsState, report: SkillStatusReport) {
  const cacheKeys = new Map(
    report.skills
      .map((skill) => [skill.skillKey, skillCardCacheKey(skill)] as const)
      .filter((entry): entry is readonly [string, string] => entry[1] !== undefined),
  );
  state.skillCardContents = Object.fromEntries(
    Object.entries(state.skillCardContents).filter(
      ([key]) => state.skillCardContentKeys[key] === cacheKeys.get(key),
    ),
  );
  state.skillCardContentKeys = Object.fromEntries(
    Object.entries(state.skillCardContentKeys).filter(
      ([key, value]) => value === cacheKeys.get(key),
    ),
  );
  state.skillCardErrors = Object.fromEntries(
    Object.entries(state.skillCardErrors).filter(([key]) => cacheKeys.has(key)),
  );
  if (state.skillCardLoadingKey && !cacheKeys.has(state.skillCardLoadingKey)) {
    state.skillCardLoadingKey = null;
  }
}

export async function loadSkillCard(state: SkillsState, skillKey: string) {
  if (
    !state.client ||
    !state.connected ||
    state.skillCardLoadingKey === skillKey ||
    (state.skillCardContents[skillKey] !== undefined &&
      state.skillCardContentKeys[skillKey] === currentSkillCardCacheKey(state, skillKey))
  ) {
    return;
  }
  const cacheKey = currentSkillCardCacheKey(state, skillKey);
  if (!cacheKey) {
    return;
  }
  state.skillCardLoadingKey = skillKey;
  const { [skillKey]: _previousError, ...nextErrors } = state.skillCardErrors;
  state.skillCardErrors = nextErrors;
  try {
    const response = await state.client.request<{
      schema: "openclaw.skills.skill-card.v1";
      skillKey: string;
      path: string;
      sizeBytes: number;
      content: string;
    }>("skills.skillCard", { skillKey });
    if (
      response?.skillKey === skillKey &&
      typeof response.content === "string" &&
      currentSkillCardCacheKey(state, skillKey) === cacheKey
    ) {
      state.skillCardContents = { ...state.skillCardContents, [skillKey]: response.content };
      state.skillCardContentKeys = { ...state.skillCardContentKeys, [skillKey]: cacheKey };
    }
  } catch (err) {
    state.skillCardErrors = { ...state.skillCardErrors, [skillKey]: getErrorMessage(err) };
  } finally {
    if (state.skillCardLoadingKey === skillKey) {
      state.skillCardLoadingKey = null;
    }
  }
}

async function loadClawHubSecurityVerdicts(state: SkillsState, report: SkillStatusReport) {
  const client = state.client;
  if (!client || !state.connected || !reportHasLinkedClawHubSkills(report)) {
    state.clawhubVerdicts = {};
    state.clawhubVerdictsLoading = false;
    state.clawhubVerdictsError = null;
    return;
  }
  state.clawhubVerdictsLoading = true;
  state.clawhubVerdictsError = null;
  try {
    const response = await client.request<{
      schema: "openclaw.skills.security-verdicts.v1";
      items: ClawHubSkillSecurityVerdict[];
    }>("skills.securityVerdicts", {});
    state.clawhubVerdicts = Object.fromEntries(
      (response?.items ?? []).map((item) => [
        clawhubVerdictKey({
          registry: item.registry,
          slug: item.requestedSlug,
          version: item.requestedVersion,
        }),
        item,
      ]),
    );
  } catch (err) {
    state.clawhubVerdicts = {};
    state.clawhubVerdictsError = getErrorMessage(err);
  } finally {
    state.clawhubVerdictsLoading = false;
  }
}

export function updateSkillEdit(state: SkillsState, skillKey: string, value: string) {
  state.skillEdits = { ...state.skillEdits, [skillKey]: value };
}

async function runSkillMutation(
  state: SkillsState,
  skillKey: string,
  run: (client: GatewayBrowserClient) => Promise<SkillMessage>,
) {
  const client = state.client;
  if (!client || !state.connected) {
    return;
  }
  state.skillsBusyKey = skillKey;
  state.skillsError = null;
  try {
    const message = await run(client);
    await loadSkills(state);
    setSkillMessage(state, skillKey, message);
  } catch (err) {
    const message = getErrorMessage(err);
    state.skillsError = message;
    setSkillMessage(state, skillKey, {
      kind: "error",
      message,
    });
  } finally {
    state.skillsBusyKey = null;
  }
}

export async function updateSkillEnabled(state: SkillsState, skillKey: string, enabled: boolean) {
  await runSkillMutation(state, skillKey, async (client) => {
    await client.request("skills.update", { skillKey, enabled });
    return {
      kind: "success",
      message: enabled ? "Skill enabled" : "Skill disabled",
    };
  });
}

export async function saveSkillApiKey(state: SkillsState, skillKey: string) {
  await runSkillMutation(state, skillKey, async (client) => {
    const apiKey = state.skillEdits[skillKey] ?? "";
    await client.request("skills.update", { skillKey, apiKey });
    return {
      kind: "success",
      message: `API key saved — stored in openclaw.json (skills.entries.${skillKey})`,
    };
  });
}

export async function installSkill(
  state: SkillsState,
  skillKey: string,
  name: string,
  installId: string,
  dangerouslyForceUnsafeInstall = false,
) {
  await runSkillMutation(state, skillKey, async (client) => {
    const result = await client.request<{ message?: string }>("skills.install", {
      name,
      installId,
      dangerouslyForceUnsafeInstall,
      timeoutMs: 120000,
    });
    return {
      kind: "success",
      message: result?.message ?? "Installed",
    };
  });
}

export async function searchClawHub(state: SkillsState, query: string) {
  if (!state.client || !state.connected) {
    return;
  }
  if (!query.trim()) {
    state.clawhubSearchResults = null;
    state.clawhubSearchError = null;
    state.clawhubSearchLoading = false;
    return;
  }
  const client = state.client;
  // Clear stale entries as soon as a new search begins so the UI cannot act on
  // results that no longer match the current query while the next request is in flight.
  state.clawhubSearchResults = null;
  state.clawhubSearchLoading = true;
  state.clawhubSearchError = null;
  await runStaleAwareRequest(
    () => query === state.clawhubSearchQuery,
    () =>
      client.request<{ results: ClawHubSearchResult[] }>("skills.search", {
        query,
        limit: 20,
      }),
    (res) => {
      state.clawhubSearchResults = res?.results ?? [];
    },
    (err) => {
      state.clawhubSearchError = getErrorMessage(err);
    },
    () => {
      state.clawhubSearchLoading = false;
    },
  );
}

export async function loadClawHubDetail(state: SkillsState, slug: string) {
  if (!state.client || !state.connected) {
    return;
  }
  const client = state.client;
  state.clawhubDetailSlug = slug;
  state.clawhubDetailLoading = true;
  state.clawhubDetailError = null;
  state.clawhubDetail = null;
  await runStaleAwareRequest(
    () => slug === state.clawhubDetailSlug,
    () => client.request<ClawHubSkillDetail>("skills.detail", { slug }),
    (res) => {
      state.clawhubDetail = res ?? null;
    },
    (err) => {
      state.clawhubDetailError = getErrorMessage(err);
    },
    () => {
      state.clawhubDetailLoading = false;
    },
  );
}

export function closeClawHubDetail(state: SkillsState) {
  state.clawhubDetailSlug = null;
  state.clawhubDetail = null;
  state.clawhubDetailError = null;
  state.clawhubDetailLoading = false;
}

export async function installFromClawHub(state: SkillsState, slug: string) {
  if (!state.client || !state.connected) {
    return;
  }
  state.clawhubInstallSlug = slug;
  state.clawhubInstallMessage = null;
  try {
    await state.client.request("skills.install", { source: "clawhub", slug });
    await loadSkills(state);
    state.clawhubInstallMessage = { kind: "success", text: `Installed ${slug}` };
  } catch (err) {
    state.clawhubInstallMessage = { kind: "error", text: getErrorMessage(err) };
  } finally {
    state.clawhubInstallSlug = null;
  }
}
