// @vitest-environment node
// Control UI tests cover skills behavior.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createRuntimeConfigCapability } from "../config/runtime-config-capability.ts";
import { searchClawHub } from "./clawhub-search.ts";
import {
  clawhubVerdictKey,
  installFromClawHub,
  installSkill,
  loadSkills,
  loadSkillCard,
  loadClawHubDetail,
  refreshSkills,
  reconcileSkillsAgentId,
  saveSkillApiKey,
  setSkillsAgentId,
  updateSkillEdit,
  updateSkillEnabled,
} from "./index.ts";

type SkillsState = Parameters<typeof loadSkills>[0];

type TestRequest = (method: string, payload?: unknown) => Promise<unknown>;

function createState(): { state: SkillsState; request: ReturnType<typeof vi.fn<TestRequest>> } {
  const request = vi.fn<TestRequest>();
  const state: SkillsState = {
    client: {
      request,
    } as unknown as SkillsState["client"],
    connected: true,
    runtimeConfig: {
      runExternalMutation: async (task) => {
        try {
          return {
            ok: true,
            value: await task(expectDefined(state.client, "connected skill mutation client")),
            refresh: { ok: true },
          };
        } catch (error) {
          return {
            ok: false,
            reason: "error",
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
    },
    skillsAgentId: null,
    skillsAgentRevision: 0,
    skillsLoading: false,
    skillsReport: null,
    skillsError: null,
    skillOperation: null,
    skillEdits: {},
    skillMessages: {},
    clawhubSearchQuery: "github",
    clawhubSearchResults: [
      {
        score: 0.9,
        slug: "github",
        displayName: "GitHub",
        summary: "Previous result",
        version: "1.0.0",
      },
    ],
    clawhubSearchLoading: false,
    clawhubSearchError: "old error",
    clawhubDetail: null,
    clawhubDetailRef: null,
    clawhubDetailLoading: false,
    clawhubDetailError: null,
    clawhubInstallMessage: null,
    clawhubVerdicts: {},
    clawhubVerdictsLoading: false,
    clawhubVerdictsError: null,
    skillCardContents: {},
    skillCardContentKeys: {},
    skillCardLoadingKey: null,
    skillCardErrors: {},
  };
  return { state, request };
}

function createDeferredRequestQueue(request: ReturnType<typeof vi.fn<TestRequest>>) {
  const resolvers: Array<(value: unknown) => void> = [];
  request.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolvers.push(resolve);
      }),
  );
  return {
    resolveNext(value: unknown) {
      resolvers.shift()?.(value);
    },
  };
}

function mockSkillMutationRequests(
  request: ReturnType<typeof vi.fn<TestRequest>>,
  installMessage?: string,
) {
  request.mockImplementation(async (method: string) => {
    if (method === "skills.install" && installMessage) {
      return { message: installMessage };
    }
    return {};
  });
}

describe("loadSkills", () => {
  it("does not request ClawHub verdicts when no installed skills are linked", async () => {
    const { state, request } = createState();
    request.mockResolvedValueOnce({
      workspaceDir: "/tmp/workspace",
      managedSkillsDir: "/tmp/skills",
      skills: [{ name: "Local", skillKey: "local", source: "workspace" }],
    });

    await loadSkills(state);

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("skills.status", {});
    expect(state.clawhubVerdicts).toEqual({});
    expect(state.clawhubVerdictsError).toBeNull();
  });

  it("requests one bulk ClawHub verdict batch for linked installed skills", async () => {
    const { state, request } = createState();
    request.mockImplementation(async (method: string) => {
      if (method === "skills.status") {
        return {
          workspaceDir: "/tmp/workspace",
          managedSkillsDir: "/tmp/skills",
          skills: [
            {
              name: "AgentReceipt",
              skillKey: "agentreceipt",
              source: "workspace",
              clawhub: {
                status: "linked",
                valid: true,
                registry: "https://clawhub.ai",
                slug: "agentreceipt",
                installedVersion: "1.2.3",
                installedAt: 123,
              },
            },
            { name: "Local", skillKey: "local", source: "workspace" },
          ],
        };
      }
      if (method === "skills.securityVerdicts") {
        return {
          schema: "openclaw.skills.security-verdicts.v1",
          items: [
            {
              registry: "https://clawhub.ai",
              ok: true,
              decision: "pass",
              reasons: [],
              requestedSlug: "agentreceipt",
              requestedVersion: "1.2.3",
              slug: "agentreceipt",
              version: "1.2.3",
              securityStatus: "clean",
              securityPassed: true,
            },
          ],
        };
      }
      return {};
    });

    await loadSkills(state);

    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(1, "skills.status", {});
    expect(request).toHaveBeenNthCalledWith(2, "skills.securityVerdicts", {});
    expect(state.clawhubVerdicts).toEqual({
      [clawhubVerdictKey({
        registry: "https://clawhub.ai",
        slug: "agentreceipt",
        version: "1.2.3",
      })]: expect.objectContaining({
        ok: true,
        decision: "pass",
        securityStatus: "clean",
        securityPassed: true,
      }),
    });
    expect(state.clawhubVerdictsLoading).toBe(false);
    expect(state.clawhubVerdictsError).toBeNull();
  });

  it("keeps verdicts for the same slug distinct by installed owner", async () => {
    const { state, request } = createState();
    request.mockImplementation(async (method: string) => {
      if (method === "skills.status") {
        return {
          workspaceDir: "/tmp/workspace",
          managedSkillsDir: "/tmp/skills",
          skills: [
            {
              name: "Alice Weather",
              skillKey: "alice-weather",
              source: "workspace",
              clawhub: {
                status: "linked",
                valid: true,
                registry: "https://clawhub.ai",
                slug: "weather",
                ownerHandle: "alice",
                installedVersion: "1.2.3",
                installedAt: 123,
              },
            },
            {
              name: "Bob Weather",
              skillKey: "bob-weather",
              source: "workspace",
              clawhub: {
                status: "linked",
                valid: true,
                registry: "https://clawhub.ai",
                slug: "weather",
                ownerHandle: "bob",
                installedVersion: "1.2.3",
                installedAt: 456,
              },
            },
          ],
        };
      }
      if (method === "skills.securityVerdicts") {
        return {
          schema: "openclaw.skills.security-verdicts.v1",
          items: [
            {
              registry: "https://clawhub.ai",
              ok: true,
              decision: "pass",
              reasons: [],
              requestedSlug: "weather",
              requestedOwnerHandle: "alice",
              requestedVersion: "1.2.3",
              publisherHandle: "alice",
              securityStatus: "clean",
              securityPassed: true,
            },
            {
              registry: "https://clawhub.ai",
              ok: false,
              decision: "fail",
              reasons: ["security.suspicious"],
              requestedSlug: "weather",
              requestedOwnerHandle: "bob",
              requestedVersion: "1.2.3",
              publisherHandle: "bob",
              securityStatus: "suspicious",
              securityPassed: false,
            },
          ],
        };
      }
      return {};
    });

    await loadSkills(state);

    const aliceKey = clawhubVerdictKey({
      registry: "https://clawhub.ai",
      slug: "weather",
      ownerHandle: "alice",
      version: "1.2.3",
    });
    const bobKey = clawhubVerdictKey({
      registry: "https://clawhub.ai",
      slug: "weather",
      ownerHandle: "bob",
      version: "1.2.3",
    });
    expect(aliceKey).not.toBe(bobKey);
    expect(Object.keys(state.clawhubVerdicts)).toHaveLength(2);
    expect(state.clawhubVerdicts[aliceKey]?.publisherHandle).toBe("alice");
    expect(state.clawhubVerdicts[bobKey]?.publisherHandle).toBe("bob");
  });

  it("loads selected agent skills and verdicts with the agent id", async () => {
    const { state, request } = createState();
    state.skillsAgentId = "research";
    request.mockImplementation(async (method: string) => {
      if (method === "skills.status") {
        return {
          workspaceDir: "/tmp/research",
          managedSkillsDir: "/tmp/skills",
          skills: [
            {
              name: "AgentReceipt",
              skillKey: "agentreceipt",
              source: "workspace",
              clawhub: {
                status: "linked",
                valid: true,
                registry: "https://clawhub.ai",
                slug: "agentreceipt",
                installedVersion: "1.2.3",
                installedAt: 123,
              },
            },
          ],
        };
      }
      if (method === "skills.securityVerdicts") {
        return {
          schema: "openclaw.skills.security-verdicts.v1",
          items: [],
        };
      }
      return {};
    });

    await loadSkills(state);

    expect(request).toHaveBeenNthCalledWith(1, "skills.status", { agentId: "research" });
    expect(request).toHaveBeenNthCalledWith(2, "skills.securityVerdicts", {
      agentId: "research",
    });
    expect(state.skillsReport?.workspaceDir).toBe("/tmp/research");
  });

  it("ignores stale skill reports after switching agents mid-request", async () => {
    const { state, request } = createState();
    const pendingRequests: Array<{
      method: string;
      payload: unknown;
      resolve: (value: unknown) => void;
    }> = [];
    request.mockImplementation(
      (method, payload) =>
        new Promise((resolve) => {
          pendingRequests.push({ method, payload, resolve });
        }),
    );

    state.skillsAgentId = "alpha";
    state.skillEdits = { shared: "stale-secret" };
    const firstLoad = loadSkills(state);
    await Promise.resolve();

    setSkillsAgentId(state, "beta");
    expect(state.skillEdits).toEqual({});
    const secondLoad = loadSkills(state);
    await Promise.resolve();

    expect(pendingRequests.map(({ method, payload }) => [method, payload])).toEqual([
      ["skills.status", { agentId: "alpha" }],
      ["skills.status", { agentId: "beta" }],
    ]);

    expectDefined(pendingRequests[1], "beta skills request").resolve({
      workspaceDir: "/tmp/beta",
      managedSkillsDir: "/tmp/skills",
      skills: [{ name: "Beta", skillKey: "beta", source: "workspace" }],
    });
    await secondLoad;

    expectDefined(pendingRequests[0], "alpha skills request").resolve({
      workspaceDir: "/tmp/alpha",
      managedSkillsDir: "/tmp/skills",
      skills: [{ name: "Alpha", skillKey: "alpha", source: "workspace" }],
    });
    await firstLoad;

    expect(state.skillsAgentId).toBe("beta");
    expect(state.skillsReport?.workspaceDir).toBe("/tmp/beta");
    expect(state.skillsReport?.skills.map((skill) => skill.name)).toEqual(["Beta"]);
    expect(state.skillsLoading).toBe(false);
  });

  it("ignores stale skill reports after switching away and back to the same agent", async () => {
    const { state, request } = createState();
    const queue = createDeferredRequestQueue(request);
    state.skillsAgentId = "alpha";

    const firstLoad = loadSkills(state);
    await Promise.resolve();
    setSkillsAgentId(state, "beta");
    setSkillsAgentId(state, "alpha");
    const secondLoad = loadSkills(state);
    await Promise.resolve();

    queue.resolveNext({
      workspaceDir: "/tmp/stale-alpha",
      managedSkillsDir: "/tmp/skills",
      skills: [{ name: "Stale Alpha", skillKey: "stale-alpha", source: "workspace" }],
    });
    await firstLoad;

    expect(state.skillsReport).toBeNull();
    expect(state.skillsLoading).toBe(true);

    queue.resolveNext({
      workspaceDir: "/tmp/current-alpha",
      managedSkillsDir: "/tmp/skills",
      skills: [{ name: "Current Alpha", skillKey: "current-alpha", source: "workspace" }],
    });
    await secondLoad;

    expect(state.skillsReport?.workspaceDir).toBe("/tmp/current-alpha");
    expect(state.skillsReport?.skills.map((skill) => skill.name)).toEqual(["Current Alpha"]);
    expect(state.skillsLoading).toBe(false);
  });

  it("releases loading ownership when the current client disconnects", async () => {
    const { state, request } = createState();
    let rejectStatus: ((reason: unknown) => void) | undefined;
    request.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectStatus = reject;
        }),
    );

    const load = loadSkills(state);
    await waitForFast(() => expect(state.skillsLoading).toBe(true));
    state.connected = false;
    expect(rejectStatus).toBeDefined();
    rejectStatus?.(new Error("gateway disconnected"));
    await load;

    expect(state.skillsLoading).toBe(false);
    expect(state.skillsReport).toBeNull();
    expect(state.skillsError).toBeNull();
  });

  it("does not keep skills loading while the optional verdict refresh is pending", async () => {
    const { state, request } = createState();
    let resolveVerdicts: (value: unknown) => void = () => {
      throw new Error("expected verdict request to be pending");
    };
    request.mockImplementation((method: string) => {
      if (method === "skills.status") {
        return Promise.resolve({
          workspaceDir: "/tmp/workspace",
          managedSkillsDir: "/tmp/skills",
          skills: [
            {
              name: "AgentReceipt",
              skillKey: "agentreceipt",
              source: "workspace",
              clawhub: {
                status: "linked",
                valid: true,
                registry: "https://clawhub.ai",
                slug: "agentreceipt",
                installedVersion: "1.2.3",
                installedAt: 123,
              },
            },
          ],
        });
      }
      if (method === "skills.securityVerdicts") {
        return new Promise((resolve) => {
          resolveVerdicts = resolve;
        });
      }
      return Promise.resolve({});
    });

    await loadSkills(state);

    expect(state.skillsLoading).toBe(false);
    expect(state.clawhubVerdictsLoading).toBe(true);

    resolveVerdicts({ schema: "openclaw.skills.security-verdicts.v1", items: [] });
    await Promise.resolve();
    await Promise.resolve();

    expect(state.clawhubVerdictsLoading).toBe(false);
  });

  it("drops cached Skill Card content when refreshed card metadata changes", async () => {
    const { state, request } = createState();
    state.skillCardContents = { agentreceipt: "old card" };
    state.skillCardContentKeys = {
      agentreceipt: "/tmp/workspace/skills/agentreceipt/skill-card.md\u000034\u00001.2.3",
    };
    request.mockResolvedValueOnce({
      workspaceDir: "/tmp/workspace",
      managedSkillsDir: "/tmp/skills",
      skills: [
        {
          name: "AgentReceipt",
          description: "Trust card fixture",
          skillKey: "agentreceipt",
          source: "workspace",
          clawhub: {
            status: "linked",
            valid: true,
            registry: "https://clawhub.ai",
            slug: "agentreceipt",
            installedVersion: "1.2.4",
            installedAt: 456,
          },
          skillCard: {
            present: true,
            path: "/tmp/workspace/skills/agentreceipt/skill-card.md",
            sizeBytes: 34,
          },
        },
      ],
    });

    await loadSkills(state);

    expect(state.skillCardContents.agentreceipt).toBeUndefined();
    expect(state.skillCardContentKeys.agentreceipt).toBeUndefined();
  });
});

describe("loadSkillCard", () => {
  it("loads local Skill Card content on demand", async () => {
    const { state, request } = createState();
    state.skillsAgentId = "research";
    request.mockResolvedValueOnce({
      schema: "openclaw.skills.skill-card.v1",
      skillKey: "agentreceipt",
      path: "/tmp/workspace/skills/agentreceipt/skill-card.md",
      sizeBytes: 34,
      content: "# AgentReceipt\n\nLocal trust card.\n",
    });
    state.skillsReport = {
      workspaceDir: "/tmp/workspace",
      managedSkillsDir: "/tmp/skills",
      skills: [
        {
          name: "AgentReceipt",
          description: "Trust card fixture",
          skillKey: "agentreceipt",
          source: "workspace",
          filePath: "/tmp/workspace/skills/agentreceipt/SKILL.md",
          baseDir: "/tmp/workspace/skills/agentreceipt",
          always: false,
          disabled: false,
          blockedByAllowlist: false,
          eligible: true,
          requirements: { anyBins: [], bins: [], env: [], config: [], os: [] },
          missing: { anyBins: [], bins: [], env: [], config: [], os: [] },
          configChecks: [],
          install: [],
          skillCard: {
            present: true,
            path: "/tmp/workspace/skills/agentreceipt/skill-card.md",
            sizeBytes: 34,
          },
        },
      ],
    };

    await loadSkillCard(state, "agentreceipt");

    expect(request).toHaveBeenCalledWith("skills.skillCard", {
      agentId: "research",
      skillKey: "agentreceipt",
    });
    expect(state.skillCardContents.agentreceipt).toBe("# AgentReceipt\n\nLocal trust card.\n");
    expect(state.skillCardContentKeys.agentreceipt).toBe(
      "/tmp/workspace/skills/agentreceipt/skill-card.md\u000034\u0000",
    );
    expect(state.skillCardLoadingKey).toBeNull();
    expect(state.skillCardErrors).toEqual({});
  });

  it("does not cache stale Skill Card content after local metadata changes mid-request", async () => {
    const { state, request } = createState();
    let resolveCard: (value: unknown) => void = () => {
      throw new Error("expected card request to be pending");
    };
    request.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCard = resolve;
        }),
    );
    state.skillsReport = {
      workspaceDir: "/tmp/workspace",
      managedSkillsDir: "/tmp/skills",
      skills: [
        {
          name: "AgentReceipt",
          description: "Trust card fixture",
          skillKey: "agentreceipt",
          source: "workspace",
          filePath: "/tmp/workspace/skills/agentreceipt/SKILL.md",
          baseDir: "/tmp/workspace/skills/agentreceipt",
          always: false,
          disabled: false,
          blockedByAllowlist: false,
          eligible: true,
          requirements: { anyBins: [], bins: [], env: [], config: [], os: [] },
          missing: { anyBins: [], bins: [], env: [], config: [], os: [] },
          configChecks: [],
          install: [],
          clawhub: {
            status: "linked",
            valid: true,
            registry: "https://clawhub.ai",
            slug: "agentreceipt",
            installedVersion: "1.2.3",
            installedAt: 123,
          },
          skillCard: {
            present: true,
            path: "/tmp/workspace/skills/agentreceipt/skill-card.md",
            sizeBytes: 34,
          },
        },
      ],
    };

    const pending = loadSkillCard(state, "agentreceipt");
    state.skillsReport = {
      ...state.skillsReport,
      skills: [
        {
          ...expectDefined(state.skillsReport.skills[0], "skill card report entry"),
          clawhub: {
            status: "linked",
            valid: true,
            registry: "https://clawhub.ai",
            slug: "agentreceipt",
            installedVersion: "1.2.4",
            installedAt: 456,
          },
        },
      ],
    };
    resolveCard({
      schema: "openclaw.skills.skill-card.v1",
      skillKey: "agentreceipt",
      path: "/tmp/workspace/skills/agentreceipt/skill-card.md",
      sizeBytes: 34,
      content: "old card",
    });
    await pending;

    expect(state.skillCardContents.agentreceipt).toBeUndefined();
    expect(state.skillCardContentKeys.agentreceipt).toBeUndefined();
  });
});

describe("searchClawHub", () => {
  it("skips the RPC when the query is empty", async () => {
    const { state, request } = createState();

    await expect(searchClawHub(state.client!, "   ")).resolves.toEqual([]);

    expect(request).not.toHaveBeenCalled();
  });

  it("returns search results and forwards cancellation", async () => {
    const { state, request } = createState();
    const controller = new AbortController();
    request.mockResolvedValue({
      results: [
        {
          score: 0.95,
          slug: "github-new",
          displayName: "GitHub New",
          summary: "Fresh result",
          version: "2.0.0",
        },
      ],
    });

    await expect(searchClawHub(state.client!, "github", controller.signal)).resolves.toEqual([
      expect.objectContaining({ slug: "github-new" }),
    ]);
    expect(request).toHaveBeenCalledWith(
      "skills.search",
      { query: "github", limit: 20 },
      { signal: controller.signal },
    );
  });
});

describe("loadClawHubDetail", () => {
  it("ignores stale detail responses after slug changes", async () => {
    const { state, request } = createState();
    const queue = createDeferredRequestQueue(request);

    const firstPending = loadClawHubDetail(state, "github");
    const secondPending = loadClawHubDetail(state, "gitlab");

    queue.resolveNext({
      skill: { slug: "github", displayName: "GitHub", createdAt: 1, updatedAt: 2 },
    });
    await firstPending;

    queue.resolveNext({
      skill: { slug: "gitlab", displayName: "GitLab", createdAt: 3, updatedAt: 4 },
    });
    await secondPending;

    expect(state.clawhubDetailLoading).toBe(false);
    expect(state.clawhubDetail?.skill?.slug).toBe("gitlab");
  });

  it("ignores a same-client detail response from an older connection epoch", async () => {
    const { state, request } = createState();
    const queue = createDeferredRequestQueue(request);

    const pending = loadClawHubDetail(state, "github");
    state.connected = false;
    state.skillsAgentRevision++;
    state.clawhubDetailLoading = false;
    state.connected = true;
    queue.resolveNext({
      skill: { slug: "stale", displayName: "Stale", createdAt: 1, updatedAt: 2 },
    });
    await pending;

    expect(state.clawhubDetail).toBeNull();
    expect(state.clawhubDetailLoading).toBe(false);
  });
});

describe("skill mutations", () => {
  it("reserves the shared operation while agent refresh is pending", async () => {
    const { state, request } = createState();
    request.mockResolvedValue({
      workspaceDir: "/tmp/workspace",
      managedSkillsDir: "/tmp/skills",
      skills: [],
    });
    let releaseAgents: (() => void) | undefined;
    const loadAgents = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseAgents = resolve;
        }),
    );
    const overlappingLoadAgents = vi.fn(async () => undefined);

    const refresh = refreshSkills(state, loadAgents);
    await waitForFast(() => expect(state.skillOperation).toEqual({ kind: "refresh" }));
    await refreshSkills(state, overlappingLoadAgents);
    await updateSkillEnabled(state, "github", true);

    expect(overlappingLoadAgents).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(releaseAgents).toBeDefined();
    releaseAgents?.();
    await refresh;

    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith("skills.status", {});
    expect(state.skillOperation).toBeNull();
  });

  it("retries a refresh when agent reconciliation changes scope", async () => {
    const { state, request } = createState();
    const pending: Array<(value: unknown) => void> = [];
    request.mockImplementation(
      () =>
        new Promise((resolve) => {
          pending.push(resolve);
        }),
    );
    state.skillsAgentId = "alpha";

    const refresh = refreshSkills(state, async () => undefined);
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());
    setSkillsAgentId(state, "beta");
    expectDefined(
      pending[0],
      "alpha status request",
    )({
      workspaceDir: "/tmp/alpha",
      managedSkillsDir: "/tmp/skills",
      skills: [],
    });
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    expectDefined(
      pending[1],
      "beta status request",
    )({
      workspaceDir: "/tmp/beta",
      managedSkillsDir: "/tmp/skills",
      skills: [],
    });
    await refresh;

    expect(request.mock.calls).toEqual([
      ["skills.status", { agentId: "alpha" }],
      ["skills.status", { agentId: "beta" }],
    ]);
    expect(state.skillsReport?.workspaceDir).toBe("/tmp/beta");
    expect(state.skillOperation).toBeNull();
  });

  it.each([
    {
      name: "updates skill enablement and records a success message",
      run: (state: SkillsState) => updateSkillEnabled(state, "github", true),
      expectedRequest: ["skills.update", { skillKey: "github", enabled: true }],
      expectedMessage: "Skill enabled",
    },
    {
      name: "saves API keys and reports success",
      run: async (state: SkillsState) => {
        state.skillEdits.github = "  sk-test  ";
        await saveSkillApiKey(state, "github");
      },
      expectedRequest: ["skills.update", { skillKey: "github", apiKey: "sk-test" }],
      expectedMessage: "API key saved — stored in openclaw.json (skills.entries.github)",
    },
    {
      name: "installs skills and uses server success messages",
      run: (state: SkillsState) => installSkill(state, "github", "GitHub", "install-123", true),
      expectedRequest: [
        "skills.install",
        {
          name: "GitHub",
          installId: "install-123",
          dangerouslyForceUnsafeInstall: true,
          timeoutMs: 120000,
        },
      ],
      expectedMessage: "Installed from registry",
      installMessage: "Installed from registry",
    },
  ])("$name", async ({ run, expectedRequest, expectedMessage, installMessage }) => {
    const { state, request } = createState();
    mockSkillMutationRequests(request, installMessage);

    await run(state);

    const [method, params] = expectedRequest;
    expect(request).toHaveBeenCalledWith(method, params);
    expect(state.skillMessages.github).toEqual({ kind: "success", message: expectedMessage });
    expect(state.skillOperation).toBeNull();
    expect(state.skillsError).toBeNull();
  });

  it.each([undefined, "", "   ", "\t\n"])(
    "does not clear an existing API key when its replacement is blank: %j",
    async (editValue) => {
      const { state, request } = createState();
      if (editValue !== undefined) {
        state.skillEdits.github = editValue;
      }

      await saveSkillApiKey(state, "github");

      expect(request).not.toHaveBeenCalled();
      expect(state.skillMessages.github).toBeUndefined();
      expect(state.skillOperation).toBeNull();
    },
  );

  it("serializes skill changes after pending settings drafts and refreshes both owners", async () => {
    const { state, request } = createState();
    const methods: string[] = [];
    let storedConfig: Record<string, unknown> = { count: 1 };
    let hash = "hash-1";
    request.mockImplementation(async (method, params) => {
      methods.push(method);
      if (method === "config.get") {
        return {
          config: storedConfig,
          raw: JSON.stringify(storedConfig),
          hash,
          valid: true,
          issues: [],
        };
      }
      if (method === "config.set") {
        storedConfig = JSON.parse((params as { raw: string }).raw) as Record<string, unknown>;
        hash = "hash-2";
        return { hash };
      }
      if (method === "skills.update") {
        storedConfig = { ...storedConfig, skillEnabled: true };
        hash = "hash-3";
        return {};
      }
      return { workspaceDir: "/tmp/workspace", managedSkillsDir: "/tmp/skills", skills: [] };
    });
    const client = expectDefined(state.client, "connected skill mutation client");
    const runtimeConfig = createRuntimeConfigCapability({
      snapshot: { client, phase: "connected", sessionKey: "main" },
      subscribe: () => () => undefined,
    });
    state.runtimeConfig = runtimeConfig;
    await runtimeConfig.ensureLoaded();
    methods.length = 0;

    try {
      runtimeConfig.patchForm(["count"], 2);
      await updateSkillEnabled(state, "github", true);

      expect(methods).toEqual(["config.set", "skills.update", "config.get", "skills.status"]);
      expect(runtimeConfig.state.configForm).toEqual({ count: 2, skillEnabled: true });
      expect(state.skillMessages.github).toEqual({ kind: "success", message: "Skill enabled" });
    } finally {
      runtimeConfig.dispose();
    }
  });

  it("does not dispatch a queued skill update after access changes", async () => {
    const { state, request } = createState();
    const firstSet = createDeferred<unknown>();
    const methods: string[] = [];
    let canDispatch = true;
    request.mockImplementation((method) => {
      methods.push(method);
      if (method === "config.get") {
        return Promise.resolve({
          config: { count: 1 },
          raw: '{"count":1}',
          hash: "hash-1",
          valid: true,
          issues: [],
        });
      }
      if (method === "config.set") {
        return firstSet.promise;
      }
      return Promise.resolve({
        workspaceDir: "/tmp/workspace",
        managedSkillsDir: "/tmp/skills",
        skills: [],
      });
    });
    const client = expectDefined(state.client, "connected skill mutation client");
    const runtimeConfig = createRuntimeConfigCapability({
      snapshot: { client, phase: "connected", sessionKey: "main" },
      subscribe: () => () => undefined,
    });
    state.runtimeConfig = runtimeConfig;
    await runtimeConfig.ensureLoaded();
    methods.length = 0;

    try {
      runtimeConfig.patchForm(["count"], 2);
      const mutation = updateSkillEnabled(state, "github", true, () => canDispatch);
      await waitForFast(() => expect(methods).toEqual(["config.set"]));
      canDispatch = false;
      firstSet.resolve({ hash: "hash-2" });
      await mutation;

      expect(methods).toEqual(["config.set"]);
      expect(state.skillMessages.github).toEqual({
        kind: "error",
        message: "Access changed before the skill update started.",
      });
    } finally {
      runtimeConfig.dispose();
    }
  });

  it("reports a committed skill update when its configuration refresh fails", async () => {
    const { state, request } = createState();
    state.runtimeConfig.runExternalMutation = async (task) => ({
      ok: true,
      value: await task(expectDefined(state.client, "connected skill mutation client")),
      refresh: { ok: false, error: "Configuration refresh failed" },
    });
    mockSkillMutationRequests(request);

    await updateSkillEnabled(state, "github", true);

    expect(state.skillMessages.github).toEqual({
      kind: "success",
      message: "Skill enabled\nConfiguration refresh failed",
    });
  });

  it.each([
    {
      name: "skill update blocks ClawHub install",
      firstMethod: "skills.update",
      start: (state: SkillsState) => updateSkillEnabled(state, "github", true),
      blocked: (state: SkillsState) => installFromClawHub(state, "calendar"),
      expectedMutation: { kind: "skill", skillKey: "github" } as const,
    },
    {
      name: "ClawHub install blocks skill update",
      firstMethod: "skills.install",
      start: (state: SkillsState) => installFromClawHub(state, "github"),
      blocked: (state: SkillsState) => updateSkillEnabled(state, "calendar", true),
      expectedMutation: { kind: "clawhub", ref: "github" } as const,
    },
  ])("serializes $name and locks API key edits", async (fixture) => {
    const { state, request } = createState();
    let releaseFirst: ((value: unknown) => void) | undefined;
    request.mockImplementation((method) => {
      if (method === fixture.firstMethod && !releaseFirst) {
        return new Promise((resolve) => {
          releaseFirst = resolve;
        });
      }
      if (method === "skills.status") {
        return Promise.resolve({
          workspaceDir: "/tmp/workspace",
          managedSkillsDir: "/tmp/skills",
          skills: [],
        });
      }
      return Promise.resolve({});
    });
    state.skillEdits.github = "submitted-value";

    const first = fixture.start(state);
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(1));
    expect(state.skillOperation).toEqual(fixture.expectedMutation);

    await fixture.blocked(state);
    updateSkillEdit(state, "github", "late-value");
    expect(request).toHaveBeenCalledTimes(1);
    expect(state.skillEdits.github).toBe("submitted-value");

    expect(releaseFirst).toBeDefined();
    releaseFirst?.({});
    await first;

    expect(request.mock.calls.map(([method]) => method)).toEqual([
      fixture.firstMethod,
      "skills.status",
    ]);
    expect(state.skillOperation).toBeNull();
  });

  it("rejects mutations while a status refresh is active", async () => {
    const { state, request } = createState();
    state.skillsLoading = true;
    state.skillEdits.github = "submitted-value";

    await updateSkillEnabled(state, "github", true);
    await installFromClawHub(state, "github");
    updateSkillEdit(state, "github", "late-value");

    expect(request).not.toHaveBeenCalled();
    expect(state.skillEdits.github).toBe("submitted-value");
    expect(state.skillOperation).toBeNull();
  });

  it("drops an old-client mutation continuation without releasing the current owner", async () => {
    const { state, request: oldRequest } = createState();
    const oldMutationResult = createDeferred<unknown>();
    oldRequest.mockReturnValue(oldMutationResult.promise);

    const oldMutation = updateSkillEnabled(state, "github", true);
    await waitForFast(() => expect(oldRequest).toHaveBeenCalledOnce());

    const currentMutationResult = createDeferred<unknown>();
    const currentRequest = vi.fn<TestRequest>((method) =>
      method === "skills.update"
        ? currentMutationResult.promise
        : Promise.resolve({
            workspaceDir: "/tmp/current",
            managedSkillsDir: "/tmp/skills",
            skills: [],
          }),
    );
    state.client = { request: currentRequest } as unknown as SkillsState["client"];
    state.skillsAgentRevision += 1;
    state.skillOperation = null;

    const currentMutation = updateSkillEnabled(state, "calendar", true);
    await waitForFast(() => expect(currentRequest).toHaveBeenCalledOnce());
    const currentOperation = state.skillOperation;

    oldMutationResult.resolve({});
    await oldMutation;
    expect(state.skillOperation).toBe(currentOperation);

    currentMutationResult.resolve({});
    await currentMutation;
    expect(currentRequest.mock.calls.map(([method]) => method)).toEqual([
      "skills.update",
      "skills.status",
    ]);
    expect(state.skillsReport?.workspaceDir).toBe("/tmp/current");
    expect(state.skillOperation).toBeNull();
  });

  it("records errors from failed mutations", async () => {
    const { state, request } = createState();
    request.mockRejectedValue(new Error("skills update failed"));

    await updateSkillEnabled(state, "github", false);

    expect(state.skillsError).toBe("skills update failed");
    expect(state.skillMessages.github).toEqual({
      kind: "error",
      message: "skills update failed",
    });
    expect(state.skillOperation).toBeNull();
  });

  it("defers a new agent refresh until a stale global config mutation succeeds", async () => {
    const { state, request } = createState();
    const pendingRequests: Array<{
      method: string;
      payload: unknown;
      resolve: (value: unknown) => void;
    }> = [];
    request.mockImplementation(
      (method, payload) =>
        new Promise((resolve) => {
          pendingRequests.push({ method, payload, resolve });
        }),
    );
    state.skillsAgentId = "alpha";

    const mutation = updateSkillEnabled(state, "github", true);
    await Promise.resolve();
    setSkillsAgentId(state, "beta");
    const betaLoad = loadSkills(state);
    await Promise.resolve();
    await betaLoad;
    expect(pendingRequests).toHaveLength(1);

    expectDefined(pendingRequests[0], "skills update request").resolve({});
    await waitForFast(() => {
      expect(pendingRequests).toHaveLength(2);
    });
    expectDefined(pendingRequests[1], "beta skills request after update").resolve({
      workspaceDir: "/tmp/beta-after-update",
      managedSkillsDir: "/tmp/skills",
      skills: [],
    });
    await mutation;

    expect(pendingRequests.map(({ method, payload }) => [method, payload])).toEqual([
      ["skills.update", { skillKey: "github", enabled: true }],
      ["skills.status", { agentId: "beta" }],
    ]);
    expect(state.skillsReport?.workspaceDir).toBe("/tmp/beta-after-update");
    expect(state.skillMessages).toEqual({});
  });

  it("loads the current agent after a stale mutation fails", async () => {
    const { state, request } = createState();
    let rejectUpdate: ((reason: unknown) => void) | undefined;
    request.mockImplementation((method) => {
      if (method === "skills.update") {
        return new Promise((_resolve, reject) => {
          rejectUpdate = reject;
        });
      }
      return Promise.resolve({
        workspaceDir: "/tmp/beta-after-error",
        managedSkillsDir: "/tmp/skills",
        skills: [],
      });
    });
    state.skillsAgentId = "alpha";

    const mutation = updateSkillEnabled(state, "github", true);
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());
    setSkillsAgentId(state, "beta");
    expect(rejectUpdate).toBeDefined();
    rejectUpdate?.(new Error("stale update failed"));
    await mutation;

    expect(request.mock.calls).toEqual([
      ["skills.update", { skillKey: "github", enabled: true }],
      ["skills.status", { agentId: "beta" }],
    ]);
    expect(state.skillsReport?.workspaceDir).toBe("/tmp/beta-after-error");
    expect(state.skillsError).toBeNull();
    expect(state.skillMessages).toEqual({});
  });

  it("routes selected agent installs through the selected workspace", async () => {
    const { state, request } = createState();
    state.skillsAgentId = "research";
    mockSkillMutationRequests(request, "Installed from registry");

    await installSkill(state, "github", "GitHub", "install-123", true);

    expect(request).toHaveBeenCalledWith("skills.install", {
      agentId: "research",
      name: "GitHub",
      installId: "install-123",
      dangerouslyForceUnsafeInstall: true,
      timeoutMs: 120000,
    });
  });

  it("routes selected agent ClawHub installs through the selected workspace", async () => {
    const { state, request } = createState();
    state.skillsAgentId = "research";
    request.mockResolvedValue({});

    await installFromClawHub(state, "github");

    expect(request).toHaveBeenCalledWith("skills.install", {
      agentId: "research",
      source: "clawhub",
      slug: "github",
    });
    expect(state.clawhubInstallMessage).toEqual({
      kind: "success",
      text: "Installed github",
    });
  });

  it("shows ClawHub trust warnings returned by successful skill installs", async () => {
    const { state, request } = createState();
    request.mockImplementation(async (method: string) => {
      if (method === "skills.install") {
        return {
          message: "Installed github@1.2.3",
          warning: "REVIEW RECOMMENDED - ClawHub has not completed a fresh clean check",
        };
      }
      return {};
    });

    await installFromClawHub(state, "github");

    expect(state.clawhubInstallMessage).toEqual({
      kind: "success",
      text:
        "Installed github@1.2.3\n\n" +
        "REVIEW RECOMMENDED - ClawHub has not completed a fresh clean check",
    });
  });

  it("shows ClawHub trust warnings from failed skill install error details", async () => {
    const { state, request } = createState();
    const error = new Error("ClawHub blocked this release; install was not started.") as Error & {
      details?: unknown;
    };
    error.details = {
      warning: "BLOCKED - ClawHub flagged this release as malicious",
    };
    request.mockRejectedValue(error);

    await installFromClawHub(state, "github");

    expect(state.clawhubInstallMessage).toEqual({
      kind: "error",
      text:
        "ClawHub blocked this release; install was not started.\n\n" +
        "BLOCKED - ClawHub flagged this release as malicious",
    });
  });

  it("allows retrying acknowledgement-required ClawHub skill installs", async () => {
    const { state, request } = createState();
    const error = new Error("ClawHub requires acknowledgement before installing.") as Error & {
      details?: unknown;
    };
    error.details = {
      clawhubTrustCode: "clawhub_risk_acknowledgement_required",
      version: "1.2.3",
      warning: "REVIEW REQUIRED - ClawHub found suspicious behavior.",
    };
    request.mockImplementation(async (method: string) => {
      if (method === "skills.install" && request.mock.calls.length === 1) {
        throw error;
      }
      if (method === "skills.install") {
        return { message: "Installed github@1.2.3" };
      }
      return {
        workspaceDir: "/tmp/workspace",
        managedSkillsDir: "/tmp/skills",
        skills: [],
      };
    });

    await installFromClawHub(state, "github");

    expect(state.clawhubInstallMessage).toEqual({
      kind: "error",
      text:
        "Review the ClawHub warning before installing this skill.\n\n" +
        "REVIEW REQUIRED - ClawHub found suspicious behavior.",
      acknowledgeRef: "github",
      acknowledgeVersion: "1.2.3",
      acknowledgeLabel: "Acknowledge risk and install",
    });

    await installFromClawHub(
      state,
      "github",
      true,
      state.clawhubInstallMessage!.acknowledgeVersion,
    );

    expect(request).toHaveBeenNthCalledWith(2, "skills.install", {
      source: "clawhub",
      slug: "github",
      version: "1.2.3",
      acknowledgeClawHubRisk: true,
    });
    expect(state.clawhubInstallMessage).toEqual({
      kind: "success",
      text: "Installed github@1.2.3",
    });
  });

  it.each([
    {
      name: "legacy install",
      run: (state: SkillsState) => installSkill(state, "github", "GitHub", "install-123"),
      expectedRequest: {
        agentId: "alpha",
        name: "GitHub",
        installId: "install-123",
        dangerouslyForceUnsafeInstall: false,
        timeoutMs: 120000,
      },
    },
    {
      name: "ClawHub install",
      run: (state: SkillsState) => installFromClawHub(state, "github"),
      expectedRequest: {
        agentId: "alpha",
        source: "clawhub",
        slug: "github",
      },
    },
  ])(
    "refreshes the current scope after switching during $name",
    async ({ run, expectedRequest }) => {
      const { state, request } = createState();
      const queue = createDeferredRequestQueue(request);
      state.skillsAgentId = "alpha";

      const pending = run(state);
      await Promise.resolve();
      setSkillsAgentId(state, "beta");
      queue.resolveNext({ message: "Installed" });
      await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
      queue.resolveNext({
        workspaceDir: "/tmp/beta-after-install",
        managedSkillsDir: "/tmp/skills",
        skills: [],
      });
      await pending;

      expect(request).toHaveBeenCalledTimes(2);
      expect(request).toHaveBeenNthCalledWith(1, "skills.install", expectedRequest);
      expect(request).toHaveBeenNthCalledWith(2, "skills.status", { agentId: "beta" });
      expect(state.skillsAgentId).toBe("beta");
      expect(state.skillsReport?.workspaceDir).toBe("/tmp/beta-after-install");
      expect(state.skillMessages).toEqual({});
      expect(state.clawhubInstallMessage).toBeNull();
      expect(state.skillOperation).toBeNull();
    },
  );
});

describe("reconcileSkillsAgentId", () => {
  it("resets a deleted selected agent without releasing its active operation", () => {
    const { state } = createState();
    state.skillsAgentId = "deleted";
    state.skillsReport = {
      workspaceDir: "/tmp/deleted",
      managedSkillsDir: "/tmp/skills",
      skills: [],
    };
    state.skillOperation = { kind: "clawhub", ref: "calendar" };

    reconcileSkillsAgentId(state, {
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "main" }],
    });

    expect(state.skillsAgentId).toBeNull();
    expect(state.skillsAgentRevision).toBe(1);
    expect(state.skillsReport).toBeNull();
    expect(state.skillOperation).toEqual({ kind: "clawhub", ref: "calendar" });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
