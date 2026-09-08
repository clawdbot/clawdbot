import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  GatewayErrorDetailCodes,
  errorShape,
  PROJECTS_LIST_DEFAULT_LIMIT,
  PROJECTS_LIST_MAX_CHECKOUTS_PER_PROJECT,
  PROJECTS_LIST_MAX_IDENTITY_PROBES,
  type ProjectRecord,
  type ProjectRecent,
  validateProjectsAddParams,
  type ProjectSummary,
  validateProjectsListParams,
  validateProjectsRegisterParams,
  validateProjectsRemoveParams,
  validateProjectsSearchRemoteParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { listRegistryWorktrees } from "../../agents/worktrees/registry.js";
import { managedWorktrees, type ManagedWorktreeService } from "../../agents/worktrees/service.js";
import { sessionCreatorProfileId } from "../../config/sessions/session-entry-provenance.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { isPathInside } from "../../infra/path-guards.js";
import { ProjectCloneError } from "../../projects/project-clone-runtime.js";
import {
  materializeProjectClone,
  removeClonedProjectCheckout,
} from "../../projects/project-clone.js";
import {
  listProjectRegistry,
  ProjectCheckoutError,
  registerProjectRegistry,
  removeProjectRegistry,
  resolveProjectRegistry,
} from "../../projects/project-registry.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { isTrustedSecretSurfaceUnavailableError } from "../../secrets/runtime-degraded-state.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { listProfiles, resolveUserProfileId } from "../../state/user-profiles.js";
import {
  CONTROL_UI_GITHUB_CREDENTIAL_UNAVAILABLE_MESSAGE,
  githubApiToken,
} from "../control-ui-github-api.js";
import { WRITE_SCOPE, authorizeOperatorScopesForRequiredScope } from "../method-scopes.js";
import { searchRemoteProjects } from "../project-github-search.js";
import { createSessionListEntryFilter } from "../session-sharing.js";
import { loadCombinedSessionStoreForGatewayCore } from "../session-utils.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

type ProjectRegistryEntry = ReturnType<typeof listProjectRegistry>[number];
type ProjectWorktreeService = Pick<
  ManagedWorktreeService,
  "listRegistryRecords" | "resolveRepositoryIdentity"
>;

type ProjectCandidate = {
  checkoutPath: string;
  fingerprint: string;
  lastUsedAt: number;
  originUrl?: string;
};

type RawProjectCandidate =
  | { kind: "session"; checkoutPath: string; lastUsedAt: number }
  | {
      kind: "worktree";
      checkoutPath: string;
      fingerprint: string;
      lastUsedAt: number;
      repoRoot: string;
    };

type ProjectGroup = {
  checkouts: Map<string, { path: string; lastUsedAt: number }>;
  lastUsedAt: number;
  name: string;
  nameUsedAt: number;
  originUrl?: string;
};

// This buffer must cover the largest possible response/checkouts while remaining independent of
// session history. Identity resolution has its own lower subprocess ceiling within this bound.
const PROJECTS_LIST_MAX_RAW_CANDIDATES = Math.max(
  PROJECTS_LIST_DEFAULT_LIMIT,
  PROJECTS_LIST_MAX_CHECKOUTS_PER_PROJECT,
  PROJECTS_LIST_MAX_IDENTITY_PROBES,
);

function folderDisplayName(folder: string): string {
  const trimmed = folder.replace(/[\\/]+$/u, "");
  return trimmed.split(/[\\/]/u).at(-1) || folder;
}

function checkoutName(checkoutPath: string): string {
  const trimmed = checkoutPath.replace(/[\\/]+$/u, "");
  return trimmed.split(/[\\/]/u).at(-1) || trimmed;
}

function compareRawProjectCandidates(left: RawProjectCandidate, right: RawProjectCandidate) {
  return (
    right.lastUsedAt - left.lastUsedAt ||
    left.checkoutPath.localeCompare(right.checkoutPath) ||
    left.kind.localeCompare(right.kind)
  );
}

function retainNewestRawProjectCandidate(
  candidates: RawProjectCandidate[],
  candidate: RawProjectCandidate,
) {
  const insertionIndex = candidates.findIndex(
    (existing) => compareRawProjectCandidates(candidate, existing) < 0,
  );
  if (insertionIndex < 0) {
    if (candidates.length < PROJECTS_LIST_MAX_RAW_CANDIDATES) {
      candidates.push(candidate);
    }
    return;
  }
  candidates.splice(insertionIndex, 0, candidate);
  if (candidates.length > PROJECTS_LIST_MAX_RAW_CANDIDATES) {
    candidates.pop();
  }
}

function sanitizePublicOriginUrl(originUrl: string): string | undefined {
  const trimmed = originUrl.trim();
  const suffixIndex = trimmed.search(/[?#]/u);
  const withoutSuffix = suffixIndex < 0 ? trimmed : trimmed.slice(0, suffixIndex);
  const scp = /^[^@\s/:]+@(\[[^\]]+\]|[^:\s]+):(.+)$/u.exec(withoutSuffix);
  if (scp) {
    return `${scp[1]}:${scp[2]}`;
  }
  let parsed: URL;
  try {
    parsed = new URL(withoutSuffix);
  } catch {
    return undefined;
  }
  if (!parsed.username && !parsed.password) {
    return withoutSuffix;
  }
  parsed.username = "";
  parsed.password = "";
  return parsed.toString();
}

function sanitizeProjectRecord(project: ProjectRecord): ProjectRecord {
  const { originUrl, ...record } = project;
  const sanitizedOriginUrl = originUrl ? sanitizePublicOriginUrl(originUrl) : undefined;
  return {
    ...record,
    ...(sanitizedOriginUrl ? { originUrl: sanitizedOriginUrl } : {}),
  };
}

function resolvePathProject(
  projects: readonly ProjectRegistryEntry[],
  folder: string,
  sessionKey: string,
): ProjectRegistryEntry | undefined {
  const sessionAgentId = parseAgentSessionKey(sessionKey)?.agentId;
  return projects
    .filter((project) => project.repoRoot === folder)
    .toSorted((left, right) => {
      const rank = (project: ProjectRegistryEntry) =>
        project.source === "workspace" && project.agentId === sessionAgentId
          ? 0
          : project.source !== "workspace"
            ? 1
            : 2;
      return rank(left) - rank(right) || left.id.localeCompare(right.id);
    })[0];
}

function listProjectRecents(
  cfg: Parameters<typeof listProjectRegistry>[0],
  profileIds: ReadonlySet<string>,
  projects: readonly ProjectRegistryEntry[],
): ProjectRecent[] {
  const store = loadCombinedSessionStoreForGatewayCore(cfg, { projection: "list" }).store;
  const candidates = Object.entries(store)
    .filter(
      ([, entry]) =>
        Boolean(sessionCreatorProfileId(entry.createdActor)) &&
        Boolean(entry.createdActor?.id && profileIds.has(entry.createdActor.id)),
    )
    .toSorted(
      ([leftKey, left], [rightKey, right]) =>
        (right.updatedAt ?? 0) - (left.updatedAt ?? 0) || leftKey.localeCompare(rightKey),
    );
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  const seen = new Set<string>();
  const recents: ProjectRecent[] = [];
  for (const [sessionKey, entry] of candidates) {
    if (entry.repositoryWorkspaceId) {
      const repository = getSessionRepositoryWorkspaceStore().get(entry.repositoryWorkspaceId);
      const sessionAgentId = parseAgentSessionKey(sessionKey)?.agentId;
      if (
        !repository ||
        repository.sessionKey !== sessionKey ||
        (sessionAgentId && repository.agentId !== sessionAgentId) ||
        seen.has(repository.url)
      ) {
        continue;
      }
      seen.add(repository.url);
      recents.push({
        kind: "repository",
        url: repository.url,
        displayName: path.posix.basename(repository.url, ".git"),
      });
      if (recents.length === 8) {
        break;
      }
      continue;
    }
    const projectId = normalizeOptionalString(entry.projectId);
    const explicitProject = projectId ? projectsById.get(projectId) : undefined;
    const worktreeRoot = normalizeOptionalString(entry.worktree?.repoRoot);
    const spawnedCwd = normalizeOptionalString(entry.spawnedCwd);
    const execCwd = normalizeOptionalString(entry.execCwd);
    const folder = worktreeRoot ?? spawnedCwd ?? execCwd;
    const project =
      explicitProject ?? (folder ? resolvePathProject(projects, folder, sessionKey) : undefined);
    const key = project
      ? `project:${project.id}`
      : folder
        ? `folder:${normalizeOptionalString(entry.execNode) ?? ""}\0${folder}`
        : undefined;
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    recents.push(
      project
        ? { kind: "project", projectId: project.id, displayName: project.displayName }
        : {
            kind: "folder",
            folder: folder!,
            displayName: folderDisplayName(folder!),
            ...(normalizeOptionalString(entry.execNode)
              ? { execNode: normalizeOptionalString(entry.execNode) }
              : {}),
          },
    );
    if (recents.length === 8) {
      break;
    }
  }
  return recents;
}

function projectCandidatesToSummaries(candidates: readonly ProjectCandidate[]): ProjectSummary[] {
  const groups = new Map<string, ProjectGroup>();
  for (const candidate of candidates) {
    const group: ProjectGroup = groups.get(candidate.fingerprint) ?? {
      checkouts: new Map(),
      lastUsedAt: candidate.lastUsedAt,
      name: checkoutName(candidate.checkoutPath),
      nameUsedAt: candidate.lastUsedAt,
    };
    const checkout = group.checkouts.get(candidate.checkoutPath);
    if (!checkout || candidate.lastUsedAt > checkout.lastUsedAt) {
      group.checkouts.set(candidate.checkoutPath, {
        path: candidate.checkoutPath,
        lastUsedAt: candidate.lastUsedAt,
      });
    }
    group.lastUsedAt = Math.max(group.lastUsedAt, candidate.lastUsedAt);
    if (candidate.lastUsedAt > group.nameUsedAt) {
      group.name = checkoutName(candidate.checkoutPath);
      group.nameUsedAt = candidate.lastUsedAt;
    }
    if (!group.originUrl && candidate.originUrl) {
      group.originUrl = candidate.originUrl;
    }
    groups.set(candidate.fingerprint, group);
  }
  return [...groups.values()]
    .toSorted(
      (left, right) => right.lastUsedAt - left.lastUsedAt || left.name.localeCompare(right.name),
    )
    .slice(0, PROJECTS_LIST_DEFAULT_LIMIT)
    .map((group) => {
      const summary: ProjectSummary = {
        name: group.name,
        checkouts: [...group.checkouts.values()]
          .toSorted(
            (left, right) =>
              right.lastUsedAt - left.lastUsedAt || left.path.localeCompare(right.path),
          )
          .slice(0, PROJECTS_LIST_MAX_CHECKOUTS_PER_PROJECT)
          .map((checkout) => ({ runnerId: "gateway", path: checkout.path })),
        lastUsedAt: group.lastUsedAt,
      };
      if (group.originUrl) {
        const originUrl = sanitizePublicOriginUrl(group.originUrl);
        if (originUrl) {
          summary.originUrl = originUrl;
        }
      }
      return summary;
    });
}

async function listObservedProjects(
  service: ProjectWorktreeService,
  context: Parameters<GatewayRequestHandlers["projects.list"]>[0]["context"],
  client: Parameters<GatewayRequestHandlers["projects.list"]>[0]["client"],
): Promise<ProjectSummary[]> {
  const cfg = context.getRuntimeConfig();
  const { store } = loadCombinedSessionStoreForGatewayCore(cfg, {
    projection: "list",
  });
  const rawCandidates: RawProjectCandidate[] = [];
  const visibilityFilter = createSessionListEntryFilter({ client, cfg });
  const canSeeAll = !visibilityFilter;
  for (const [sessionKey, entry] of Object.entries(store)) {
    if (visibilityFilter && !visibilityFilter(sessionKey, entry)) {
      continue;
    }
    const checkoutPath = entry.execCwd?.trim();
    if (checkoutPath && !entry.execNode?.trim()) {
      retainNewestRawProjectCandidate(rawCandidates, {
        kind: "session",
        checkoutPath,
        lastUsedAt: entry.updatedAt,
      });
    }
  }
  for (const worktree of service.listRegistryRecords()) {
    if (worktree.removedAt !== undefined) {
      continue;
    }
    if (!canSeeAll) {
      // Session-owned worktrees use their canonical session key as ownerId, so the same
      // visibility policy that admitted the session also owns its managed checkout.
      const ownerId = worktree.ownerKind === "session" ? worktree.ownerId?.trim() : undefined;
      const ownerEntry = ownerId ? store[ownerId] : undefined;
      if (!ownerId || !ownerEntry || !visibilityFilter?.(ownerId, ownerEntry)) {
        continue;
      }
    }
    retainNewestRawProjectCandidate(rawCandidates, {
      kind: "worktree",
      checkoutPath: worktree.path,
      fingerprint: worktree.repoFingerprint,
      lastUsedAt: worktree.lastActiveAt,
      repoRoot: worktree.repoRoot,
    });
  }

  const candidates: ProjectCandidate[] = [];
  type RepositoryIdentity = Awaited<
    ReturnType<ProjectWorktreeService["resolveRepositoryIdentity"]>
  >;
  const identities = new Map<string, Promise<RepositoryIdentity>>();
  let identityProbeCount = 0;
  const resolveIdentity = (checkoutPath: string) => {
    const existing = identities.get(checkoutPath);
    if (existing) {
      return existing;
    }
    if (identityProbeCount >= PROJECTS_LIST_MAX_IDENTITY_PROBES) {
      return undefined;
    }
    identityProbeCount += 1;
    const identity = Promise.resolve().then(() => service.resolveRepositoryIdentity(checkoutPath));
    identities.set(checkoutPath, identity);
    return identity;
  };

  // The buffer is already newest-first, so probes always go to the retained top-K candidates.
  for (const raw of rawCandidates) {
    if (raw.kind === "worktree") {
      let originUrl: string | undefined;
      const pendingIdentity = resolveIdentity(raw.repoRoot);
      try {
        const identity = pendingIdentity ? await pendingIdentity : undefined;
        originUrl = identity?.originUrl || undefined;
      } catch {
        // The registry fingerprint and checkout path remain authoritative if the source checkout
        // disappears after the managed worktree record was written.
      }
      candidates.push({
        checkoutPath: raw.checkoutPath,
        fingerprint: raw.fingerprint,
        lastUsedAt: raw.lastUsedAt,
        ...(originUrl ? { originUrl } : {}),
      });
      continue;
    }
    const pendingIdentity = resolveIdentity(raw.checkoutPath);
    if (!pendingIdentity) {
      continue;
    }
    try {
      const identity = await pendingIdentity;
      candidates.push({
        checkoutPath: identity.checkoutRoot,
        fingerprint: identity.fingerprint,
        lastUsedAt: raw.lastUsedAt,
        ...(identity.originUrl ? { originUrl: identity.originUrl } : {}),
      });
    } catch {
      // Plain folders remain available through the existing folder picker.
    }
  }

  // M5: merge operator-enabled device checkout advertisements at this seam.
  return projectCandidatesToSummaries(candidates);
}

function findProjectCheckoutReference(
  cfg: Parameters<typeof listProjectRegistry>[0],
  repoRoot: string,
): string | undefined {
  const normalizedRoot = path.resolve(repoRoot);
  const workspaceReference = listProjectRegistry(cfg).find(
    (candidate) =>
      candidate.source === "workspace" && path.resolve(candidate.repoRoot) === normalizedRoot,
  );
  const worktreeReference = listRegistryWorktrees(process.env).find(
    (worktree) => !worktree.removedAt && path.resolve(worktree.repoRoot) === normalizedRoot,
  );
  const sessionReference = Object.entries(
    loadCombinedSessionStoreForGatewayCore(cfg, { projection: "list" }).store,
  ).find(([, entry]) => {
    if (entry.archivedAt) {
      return false;
    }
    const sessionRoot = entry.worktree?.repoRoot;
    if (sessionRoot && path.resolve(sessionRoot) === normalizedRoot) {
      return true;
    }
    const cwd = entry.spawnedCwd;
    return Boolean(
      cwd &&
      (path.resolve(cwd) === normalizedRoot || isPathInside(normalizedRoot, path.resolve(cwd))),
    );
  });
  return workspaceReference
    ? `agent workspace ${workspaceReference.displayName}`
    : worktreeReference
      ? `managed worktree ${worktreeReference.name}`
      : sessionReference
        ? `session ${sessionReference[0]}`
        : undefined;
}

export function createProjectsHandlers(service: ProjectWorktreeService): GatewayRequestHandlers {
  return {
    "projects.list": async ({ params, respond, context, client }) => {
      if (!assertValidParams(params, validateProjectsListParams, "projects.list", respond)) {
        return;
      }
      const registryProjects = listProjectRegistry(context.getRuntimeConfig());
      const projects = registryProjects.map(sanitizeProjectRecord);
      const profileId = client?.authenticatedUserProfile?.profileId;
      const canonicalProfileId = profileId
        ? (resolveUserProfileId(profileId) ?? profileId)
        : undefined;
      const recentProfileIds = canonicalProfileId
        ? new Set([
            canonicalProfileId,
            ...listProfiles()
              .filter((profile) => profile.mergedInto === canonicalProfileId)
              .map((profile) => profile.id),
          ])
        : undefined;
      const recents = recentProfileIds
        ? listProjectRecents(context.getRuntimeConfig(), recentProfileIds, registryProjects)
        : undefined;
      const scopes = Array.isArray(client?.connect.scopes) ? client.connect.scopes : [];
      const canWrite = authorizeOperatorScopesForRequiredScope(WRITE_SCOPE, scopes).allowed;
      if (params.includeObserved && canWrite) {
        try {
          const observedProjects = await listObservedProjects(service, context, client);
          respond(true, { projects, ...(recents ? { recents } : {}), observedProjects }, undefined);
        } catch (error) {
          respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
        }
        return;
      }
      if (canWrite) {
        respond(true, { projects, ...(recents ? { recents } : {}) }, undefined);
        return;
      }
      // Project identity is read-safe; host paths, origins, folders, and observed checkouts are
      // placement details reserved for clients that can create sessions.
      respond(
        true,
        {
          projects: projects.map((project) =>
            project.agentId
              ? {
                  id: project.id,
                  displayName: project.displayName,
                  source: project.source,
                  agentId: project.agentId,
                }
              : {
                  id: project.id,
                  displayName: project.displayName,
                  source: project.source,
                },
          ),
          ...(recents ? { recents: recents.filter((recent) => recent.kind === "project") } : {}),
        },
        undefined,
      );
    },
    "projects.register": async ({ params, respond }) => {
      if (
        !assertValidParams(params, validateProjectsRegisterParams, "projects.register", respond)
      ) {
        return;
      }
      try {
        respond(
          true,
          sanitizeProjectRecord(
            await registerProjectRegistry({ path: params.path, name: params.name }),
          ),
          undefined,
        );
      } catch (error) {
        respond(
          false,
          undefined,
          errorShape(
            error instanceof ProjectCheckoutError
              ? ErrorCodes.INVALID_REQUEST
              : ErrorCodes.UNAVAILABLE,
            formatErrorMessage(error),
          ),
        );
      }
    },
    "projects.add": async ({ params, respond, context, signal }) => {
      if (!assertValidParams(params, validateProjectsAddParams, "projects.add", respond)) {
        return;
      }
      try {
        respond(
          true,
          await materializeProjectClone(
            { cfg: context.getRuntimeConfig(), gitUrl: params.gitUrl, name: params.name },
            { signal, token: githubApiToken() },
          ),
          undefined,
        );
      } catch (error) {
        if (isTrustedSecretSurfaceUnavailableError(error)) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.UNAVAILABLE, CONTROL_UI_GITHUB_CREDENTIAL_UNAVAILABLE_MESSAGE, {
              details: {
                code: GatewayErrorDetailCodes.PROJECT_CLONE_FAILED,
                cause: "auth_required",
              },
              retryable: false,
            }),
          );
          return;
        }
        if (error instanceof ProjectCloneError) {
          respond(
            false,
            undefined,
            errorShape(
              error.failure === "invalid_url" ? ErrorCodes.INVALID_REQUEST : ErrorCodes.UNAVAILABLE,
              error.message,
              {
                details: {
                  code: GatewayErrorDetailCodes.PROJECT_CLONE_FAILED,
                  cause: error.failure,
                },
                retryable: error.failure === "network" || error.failure === "clone_failed",
              },
            ),
          );
          return;
        }
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
      }
    },
    "projects.searchRemote": async ({ params, respond }) => {
      if (
        !assertValidParams(
          params,
          validateProjectsSearchRemoteParams,
          "projects.searchRemote",
          respond,
        )
      ) {
        return;
      }
      try {
        respond(true, await searchRemoteProjects(params.query), undefined);
      } catch (error) {
        const credentialUnavailable = isTrustedSecretSurfaceUnavailableError(error);
        const message = credentialUnavailable
          ? CONTROL_UI_GITHUB_CREDENTIAL_UNAVAILABLE_MESSAGE
          : "GitHub project search is unavailable. Retry shortly.";
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, message, { retryable: !credentialUnavailable }),
        );
      }
    },
    "projects.remove": async ({ params, respond, context }) => {
      if (!assertValidParams(params, validateProjectsRemoveParams, "projects.remove", respond)) {
        return;
      }
      const respondUnknownProject = () => {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `unknown project id: ${params.id}`),
        );
      };
      const project = resolveProjectRegistry(context.getRuntimeConfig(), params.id);
      if (!project || project.source === "workspace") {
        respondUnknownProject();
        return;
      }
      let removed: boolean;
      if (params.deleteCheckout) {
        if (project.source !== "cloned") {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              "Only projects cloned by the Gateway can delete their checkout.",
            ),
          );
          return;
        }
        try {
          removed = await removeClonedProjectCheckout(project, () => {
            const reference = findProjectCheckoutReference(
              context.getRuntimeConfig(),
              project.repoRoot,
            );
            if (reference) {
              throw new ProjectCheckoutError(
                `Project checkout is still referenced by ${reference}. Remove that reference before deleting the checkout.`,
              );
            }
          });
        } catch (error) {
          respond(
            false,
            undefined,
            errorShape(
              error instanceof ProjectCheckoutError
                ? ErrorCodes.INVALID_REQUEST
                : ErrorCodes.UNAVAILABLE,
              formatErrorMessage(error),
            ),
          );
          return;
        }
      } else {
        removed = await removeProjectRegistry(project);
      }
      if (!removed) {
        respondUnknownProject();
        return;
      }
      respond(true, { removed: true }, undefined);
    },
  };
}

export const projectsHandlers = createProjectsHandlers(managedWorktrees);
