import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROJECTS_LIST_MAX_CHECKOUTS_PER_PROJECT,
  PROJECTS_LIST_MAX_IDENTITY_PROBES,
} from "../../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../../config/sessions.js";
import { createProjectsHandlers } from "./projects.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

type ProjectWorktreeService = Parameters<typeof createProjectsHandlers>[0];

const seededSessions = vi.hoisted(() => ({
  store: {} as Record<string, SessionEntry>,
}));

vi.mock("../session-utils.js", () => ({
  loadCombinedSessionStoreForGatewayCore: () => ({ store: seededSessions.store }),
}));

vi.mock("../../projects/project-registry.js", () => ({
  listProjectRegistry: () => [],
  ProjectCheckoutError: class ProjectCheckoutError extends Error {},
  registerProjectRegistry: vi.fn(),
  removeProjectRegistry: vi.fn(),
}));

function authenticatedClient(user: string, scopes = ["operator.write"]): GatewayClient {
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: "openclaw-control-ui",
        version: "test",
        platform: "test",
        mode: "webchat",
      },
      role: "operator",
      scopes,
    },
    authenticatedUserId: user,
    authenticatedUserProfile: {
      profileId: user,
      displayName: user,
      hasAvatar: false,
      updatedAt: 1,
    },
  };
}

function assertObservedProjectsPayload(
  payload: unknown,
): asserts payload is { observedProjects: unknown[] } {
  if (!isRecord(payload) || !Array.isArray(payload.observedProjects)) {
    throw new TypeError("projects.list response is missing observedProjects");
  }
}

async function listObservedProjects(params: {
  service: {
    listRegistryRecords: () => unknown[];
    resolveRepositoryIdentity: (checkoutPath: string) => Promise<{
      checkoutRoot: string;
      repoRoot: string;
      originUrl: string;
      fingerprint: string;
    }>;
  };
  client?: GatewayClient;
}) {
  const handlers = createProjectsHandlers(params.service as never);
  const responses: Parameters<RespondFn>[] = [];
  await handlers["projects.list"]?.({
    params: { includeObserved: true },
    respond: (...response: Parameters<RespondFn>) => responses.push(response),
    context: {
      getRuntimeConfig: () => ({ agents: { list: [{ id: "main", default: true }] } }),
    } as GatewayRequestContext,
    client: params.client ?? authenticatedClient("operator@example.com"),
  } as never);
  expect(responses).toHaveLength(1);
  const response = responses[0];
  if (!response) {
    throw new Error("projects.list did not respond");
  }
  expect(response[0]).toBe(true);
  assertObservedProjectsPayload(response[1]);
  return response[1].observedProjects;
}

beforeEach(() => {
  seededSessions.store = {};
});

describe("projects.list observed projects", () => {
  it.each([["operator.write"], ["operator.admin"]])(
    "returns detailed observed projects to %s callers",
    async (scope) => {
      seededSessions.store = {
        "agent:main:old": {
          sessionId: "old",
          updatedAt: 100,
          execCwd: "/links/alpha-old",
        },
        "agent:main:new": {
          sessionId: "new",
          updatedAt: 300,
          execCwd: "/links/alpha-new",
        },
        "agent:main:device": {
          sessionId: "device",
          updatedAt: 400,
          execCwd: "/device/alpha",
          execNode: "paired-mac",
        },
      };
      const resolveRepositoryIdentity = vi.fn(async (checkoutPath: string) => ({
        checkoutRoot: checkoutPath.replace("/links/", "/physical/"),
        repoRoot: "/physical/alpha",
        originUrl: "https://github.com/openclaw/alpha.git",
        fingerprint: "alpha-fingerprint",
      }));

      await expect(
        listObservedProjects({
          service: { listRegistryRecords: () => [], resolveRepositoryIdentity },
          client: authenticatedClient(`${scope}@example.com`, [scope]),
        }),
      ).resolves.toEqual([
        {
          name: "alpha-new",
          originUrl: "https://github.com/openclaw/alpha.git",
          checkouts: [
            { runnerId: "gateway", path: "/physical/alpha-new" },
            { runnerId: "gateway", path: "/physical/alpha-old" },
          ],
          lastUsedAt: 300,
        },
      ]);
      expect(resolveRepositoryIdentity).not.toHaveBeenCalledWith("/device/alpha");
    },
  );

  it("admits managed worktrees only when their owning session is visible", async () => {
    seededSessions.store = {
      "agent:main:visible": {
        sessionId: "visible",
        updatedAt: 200,
        visibility: "shared",
        createdActor: { type: "human", id: "owner@example.com" },
      },
      "agent:main:private": {
        sessionId: "private",
        updatedAt: 300,
        visibility: "draft",
        createdActor: { type: "human", id: "owner@example.com" },
      },
    };
    const worktree = (name: string, ownerId: string, lastActiveAt: number) => ({
      id: name,
      name,
      repoFingerprint: name,
      repoRoot: `/repos/${name}`,
      path: `/worktrees/${name}`,
      branch: `openclaw/${name}`,
      baseRef: "main",
      ownerKind: "session",
      ownerId,
      createdAt: 100,
      lastActiveAt,
    });
    const worktrees = [
      worktree("visible", "agent:main:visible", 500),
      worktree("private", "agent:main:private", 490),
      worktree("orphan", "agent:main:missing", 480),
      {
        ...worktree("manual", "ignored", 470),
        ownerKind: "manual",
        ownerId: undefined,
      },
    ];
    const resolveRepositoryIdentity = vi.fn(async (checkoutPath: string) => ({
      checkoutRoot: checkoutPath,
      repoRoot: checkoutPath,
      originUrl: `https://example.test${checkoutPath}.git`,
      fingerprint: checkoutPath,
    }));
    const service = { listRegistryRecords: () => worktrees, resolveRepositoryIdentity };

    const viewer = (await listObservedProjects({
      service,
      client: authenticatedClient("viewer@example.com"),
    })) as Array<{ name: string }>;
    expect(viewer.map((project) => project.name)).toEqual(["visible"]);

    const admin = (await listObservedProjects({
      service,
      client: authenticatedClient("admin@example.com", ["operator.admin"]),
    })) as Array<{ name: string }>;
    expect(admin.map((project) => project.name)).toEqual([
      "visible",
      "private",
      "orphan",
      "manual",
    ]);
  });

  it("redacts URL and SCP-style userinfo and omits unknown remote forms", async () => {
    seededSessions.store = Object.fromEntries(
      ["url", "token-scp", "git-scp", "unknown"].map((name, index) => [
        `agent:main:${name}`,
        { sessionId: name, updatedAt: 400 - index, execCwd: `/repos/${name}` },
      ]),
    );
    const origins: Record<string, string> = {
      "/repos/url": ["https://user", ":placeholder", "@host/repo.git?visible=value#branch"].join(
        "",
      ),
      "/repos/token-scp": ["placeholder", "@host:org/private.git"].join(""),
      "/repos/git-scp": "git@host:org/public.git",
      "/repos/unknown": "opaque credential-shaped remote",
    };

    const projects = (await listObservedProjects({
      service: {
        listRegistryRecords: () => [],
        resolveRepositoryIdentity: async (checkoutPath: string) => ({
          checkoutRoot: checkoutPath,
          repoRoot: checkoutPath,
          originUrl: origins[checkoutPath] ?? "",
          fingerprint: checkoutPath,
        }),
      },
    })) as Array<{ name: string; originUrl?: string }>;

    expect(projects.map(({ name, originUrl }) => ({ name, originUrl }))).toEqual([
      { name: "url", originUrl: "https://host/repo.git" },
      { name: "token-scp", originUrl: "host:org/private.git" },
      { name: "git-scp", originUrl: "host:org/public.git" },
      { name: "unknown", originUrl: undefined },
    ]);
  });

  it("caps checkout arrays in deterministic newest-first order", async () => {
    const worktrees = Array.from(
      { length: PROJECTS_LIST_MAX_CHECKOUTS_PER_PROJECT + 3 },
      (_, index) => ({
        id: `worktree-${index}`,
        name: `worktree-${index}`,
        repoFingerprint: "alpha-fingerprint",
        repoRoot: "/repos/alpha",
        path: `/worktrees/${String(index).padStart(2, "0")}`,
        branch: `openclaw/worktree-${index}`,
        baseRef: "main",
        ownerKind: "manual",
        createdAt: 1,
        lastActiveAt: index,
      }),
    );

    const projects = (await listObservedProjects({
      service: {
        listRegistryRecords: () => worktrees,
        resolveRepositoryIdentity: async (checkoutPath: string) => ({
          checkoutRoot: checkoutPath,
          repoRoot: checkoutPath,
          originUrl: "https://github.com/openclaw/alpha.git",
          fingerprint: "alpha-fingerprint",
        }),
      },
      client: authenticatedClient("admin@example.com", ["operator.admin"]),
    })) as Array<{ checkouts: Array<{ path: string }> }>;

    expect(projects[0]?.checkouts).toHaveLength(PROJECTS_LIST_MAX_CHECKOUTS_PER_PROJECT);
    expect(projects[0]?.checkouts[0]?.path).toBe("/worktrees/52");
    expect(projects[0]?.checkouts.at(-1)?.path).toBe("/worktrees/03");
  });

  it("retains only the newest bounded candidates before identity resolution", async () => {
    const rawCandidateLimit = Math.max(
      PROJECTS_LIST_MAX_CHECKOUTS_PER_PROJECT,
      PROJECTS_LIST_MAX_IDENTITY_PROBES,
      50,
    );
    seededSessions.store = Object.fromEntries(
      Array.from({ length: rawCandidateLimit + 5 }, (_, index) => [
        `agent:main:session-${index}`,
        { sessionId: `session-${index}`, updatedAt: index, execCwd: `/repos/${index}` },
      ]),
    );
    const resolveRepositoryIdentity = vi.fn<ProjectWorktreeService["resolveRepositoryIdentity"]>(
      async (_checkoutPath) => {
        throw new Error("checkout unavailable");
      },
    );

    await expect(
      listObservedProjects({
        service: { listRegistryRecords: () => [], resolveRepositoryIdentity },
      }),
    ).resolves.toEqual([]);
    expect(resolveRepositoryIdentity).toHaveBeenCalledTimes(PROJECTS_LIST_MAX_IDENTITY_PROBES);
    expect(resolveRepositoryIdentity.mock.calls.length).toBeLessThanOrEqual(rawCandidateLimit);
    expect(resolveRepositoryIdentity.mock.calls[0]?.[0]).toBe(`/repos/${rawCandidateLimit + 4}`);
    expect(resolveRepositoryIdentity).not.toHaveBeenCalledWith("/repos/0");
  });
});
