import { describe, expect, it, vi } from "vitest";
import {
  installSkill,
  loadSkills,
  loadSkillCard,
  loadClawHubDetail,
  saveSkillApiKey,
  searchClawHub,
  setClawHubSearchQuery,
  updateSkillEnabled,
  type SkillsState,
} from "./skills.ts";

type TestRequest = (method: string, payload?: unknown) => Promise<unknown>;

function createState(): { state: SkillsState; request: ReturnType<typeof vi.fn<TestRequest>> } {
  const request = vi.fn<TestRequest>();
  const state: SkillsState = {
    client: {
      request,
    } as unknown as SkillsState["client"],
    connected: true,
    skillsLoading: false,
    skillsReport: null,
    skillsError: null,
    skillsBusyKey: null,
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
    clawhubDetailSlug: null,
    clawhubDetailLoading: false,
    clawhubDetailError: null,
    clawhubInstallSlug: null,
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
      "https://clawhub.ai\u0000agentreceipt\u00001.2.3": expect.objectContaining({
        ok: true,
        decision: "pass",
        securityStatus: "clean",
        securityPassed: true,
      }),
    });
    expect(state.clawhubVerdictsLoading).toBe(false);
    expect(state.clawhubVerdictsError).toBeNull();
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
          requirements: { bins: [], env: [], config: [], os: [] },
          missing: { bins: [], env: [], config: [], os: [] },
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

    expect(request).toHaveBeenCalledWith("skills.skillCard", { skillKey: "agentreceipt" });
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
          requirements: { bins: [], env: [], config: [], os: [] },
          missing: { bins: [], env: [], config: [], os: [] },
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
          ...state.skillsReport.skills[0],
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
  it("clears stale query state immediately when the input changes", () => {
    const { state } = createState();

    state.clawhubSearchLoading = true;
    state.clawhubInstallMessage = { kind: "success", text: "Installed github" };

    setClawHubSearchQuery(state, "github app");

    expect(state.clawhubSearchQuery).toBe("github app");
    expect(state.clawhubSearchResults).toBeNull();
    expect(state.clawhubSearchError).toBeNull();
    expect(state.clawhubSearchLoading).toBe(false);
    expect(state.clawhubInstallMessage).toBeNull();
  });

  it("clears stale results as soon as a new search starts", async () => {
    const { state, request } = createState();
    type SearchResponse = { results: SkillsState["clawhubSearchResults"] };
    let resolveRequest: (value: SearchResponse) => void = () => {
      throw new Error("expected search request promise to be pending");
    };
    request.mockImplementation(
      () =>
        new Promise<SearchResponse>((resolve) => {
          resolveRequest = resolve;
        }),
    );

    const pending = searchClawHub(state, "github");

    expect(state.clawhubSearchResults).toBeNull();
    expect(state.clawhubSearchLoading).toBe(true);
    expect(state.clawhubSearchError).toBeNull();

    resolveRequest({
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
    await pending;

    expect(state.clawhubSearchResults).toEqual([
      {
        score: 0.95,
        slug: "github-new",
        displayName: "GitHub New",
        summary: "Fresh result",
        version: "2.0.0",
      },
    ]);
    expect(state.clawhubSearchLoading).toBe(false);
  });

  it("clears stale results when the query is emptied", async () => {
    const { state, request } = createState();

    await searchClawHub(state, "   ");

    expect(request).not.toHaveBeenCalled();
    expect(state.clawhubSearchResults).toBeNull();
    expect(state.clawhubSearchError).toBeNull();
    expect(state.clawhubSearchLoading).toBe(false);
  });

  it("ignores stale search responses after query changes", async () => {
    const { state, request } = createState();
    const queue = createDeferredRequestQueue(request);

    const pending = searchClawHub(state, "github");
    setClawHubSearchQuery(state, "gitlab");
    queue.resolveNext({
      results: [{ score: 1, slug: "github", displayName: "GitHub" }],
    });
    await pending;

    expect(state.clawhubSearchQuery).toBe("gitlab");
    expect(state.clawhubSearchResults).toBeNull();
    expect(state.clawhubSearchError).toBeNull();
    expect(state.clawhubSearchLoading).toBe(false);
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
});

describe("skill mutations", () => {
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
        state.skillEdits.github = "sk-test";
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
    expect(state.skillsBusyKey).toBeNull();
    expect(state.skillsError).toBeNull();
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
    expect(state.skillsBusyKey).toBeNull();
  });
});
