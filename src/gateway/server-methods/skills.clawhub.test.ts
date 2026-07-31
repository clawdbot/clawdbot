// ClawHub skills tests cover install/update/detail/status flows, security
// verdicts, local skill cards, and workspace skill status reports.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { callGatewayHandler } from "./skills.test-helpers.js";

const loadConfigMock = vi.fn(() => ({}));
const listAgentIdsMock = vi.fn<(_cfg: unknown) => string[]>(() => ["main"]);
const resolveDefaultAgentIdMock = vi.fn(() => "main");
const resolveAgentWorkspaceDirMock = vi.fn<(_cfg: unknown, _agentId: string) => string>(
  () => "/tmp/workspace",
);
const buildWorkspaceSkillStatusMock = vi.fn();
const readLocalSkillCardContentSyncMock = vi.fn();
const fetchClawHubSkillSecurityVerdictsMock = vi.fn();
const installSkillFromClawHubMock = vi.fn();
const installSkillMock = vi.fn();
const updateSkillsFromClawHubMock = vi.fn();

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: () => loadConfigMock(),
  writeConfigFile: vi.fn(),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  listAgentIds: (cfg: unknown) => listAgentIdsMock(cfg),
  resolveAgentConfig: vi.fn(() => undefined),
  resolveDefaultAgentId: () => resolveDefaultAgentIdMock(),
  resolveAgentWorkspaceDir: (cfg: unknown, agentId: string) =>
    resolveAgentWorkspaceDirMock(cfg, agentId),
  resolveSessionAgentId: vi.fn(() => undefined),
}));

vi.mock("../../skills/lifecycle/clawhub.js", () => ({
  installSkillFromClawHub: (...args: unknown[]) => installSkillFromClawHubMock(...args),
  readLocalSkillCardContentSync: (...args: unknown[]) => readLocalSkillCardContentSyncMock(...args),
  updateSkillsFromClawHub: (...args: unknown[]) => updateSkillsFromClawHubMock(...args),
}));

vi.mock("../../skills/discovery/status.js", () => ({
  buildWorkspaceSkillStatus: (...args: unknown[]) => buildWorkspaceSkillStatusMock(...args),
}));

vi.mock("../../skills/lifecycle/install.js", () => ({
  installSkill: (...args: unknown[]) => installSkillMock(...args),
}));

vi.mock("../../infra/clawhub.js", () => ({
  fetchClawHubSkillDetail: vi.fn(),
  fetchClawHubSkillSecurityVerdicts: (...args: unknown[]) =>
    fetchClawHubSkillSecurityVerdictsMock(...args),
  resolveClawHubBaseUrl: () => "https://clawhub.ai",
}));

const { skillsHandlers } = await import("./skills.js");

type SkillsHandlerName = keyof typeof skillsHandlers;

function emptySkillStatusReport() {
  return {
    workspaceDir: "/tmp/workspace",
    managedSkillsDir: "/tmp/openclaw/skills",
    skills: [],
  };
}

async function callSkillsHandler(method: SkillsHandlerName, params: Record<string, unknown>) {
  return callGatewayHandler(skillsHandlers, method, params);
}

function expectEmptySecurityVerdicts(response: unknown): void {
  expect(response).toEqual({
    schema: "openclaw.skills.security-verdicts.v1",
    items: [],
  });
}

async function expectEmptySecurityVerdictsWithoutFetch(): Promise<void> {
  const { ok, response, error } = await callSkillsHandler("skills.securityVerdicts", {});

  expect(error).toBeUndefined();
  expect(ok).toBe(true);
  expect(fetchClawHubSkillSecurityVerdictsMock).not.toHaveBeenCalled();
  expectEmptySecurityVerdicts(response);
}

describe("skills gateway handlers (clawhub)", () => {
  beforeEach(() => {
    loadConfigMock.mockReset();
    listAgentIdsMock.mockReset();
    resolveDefaultAgentIdMock.mockReset();
    resolveAgentWorkspaceDirMock.mockReset();
    buildWorkspaceSkillStatusMock.mockReset();
    readLocalSkillCardContentSyncMock.mockReset();
    fetchClawHubSkillSecurityVerdictsMock.mockReset();
    installSkillFromClawHubMock.mockReset();
    installSkillMock.mockReset();
    updateSkillsFromClawHubMock.mockReset();

    loadConfigMock.mockReturnValue({});
    listAgentIdsMock.mockReturnValue(["main"]);
    resolveDefaultAgentIdMock.mockReturnValue("main");
    resolveAgentWorkspaceDirMock.mockReturnValue("/tmp/workspace");
    buildWorkspaceSkillStatusMock.mockReturnValue(emptySkillStatusReport());
  });

  it("returns an empty verdict batch without calling ClawHub when no skills are linked", async () => {
    await expectEmptySecurityVerdictsWithoutFetch();
  });

  it("builds status with the selected agent filter", async () => {
    listAgentIdsMock.mockReturnValue(["main", "research"]);
    resolveAgentWorkspaceDirMock.mockImplementation((_cfg, agentId) =>
      agentId === "research" ? "/tmp/research-workspace" : "/tmp/workspace",
    );

    const { ok, error } = await callSkillsHandler("skills.status", { agentId: "research" });

    expect(ok).toBe(true);
    expect(error).toBeUndefined();
    expect(buildWorkspaceSkillStatusMock).toHaveBeenCalledWith(
      "/tmp/research-workspace",
      expect.objectContaining({
        agentId: "research",
        config: {},
        eligibility: expect.objectContaining({
          nodeSkills: expect.objectContaining({ canExec: expect.any(Boolean) }),
        }),
      }),
    );
  });

  it("fetches one bulk ClawHub verdict batch for linked installed skills", async () => {
    buildWorkspaceSkillStatusMock.mockReturnValue({
      workspaceDir: "/tmp/workspace",
      managedSkillsDir: "/tmp/openclaw/skills",
      skills: [
        {
          name: "agentreceipt",
          skillKey: "agentreceipt",
          clawhub: {
            status: "linked",
            valid: true,
            registry: "https://clawhub.ai",
            slug: "agentreceipt",
            installedVersion: "1.2.3",
            installedAt: 123,
          },
        },
        {
          name: "local-only",
          skillKey: "local-only",
        },
      ],
    });
    fetchClawHubSkillSecurityVerdictsMock.mockResolvedValue({
      schema: "clawhub.skill.security-verdicts.v1",
      items: [
        {
          ok: true,
          decision: "pass",
          reasons: [],
          requestedSlug: "agentreceipt",
          slug: "agentreceipt",
          requestedVersion: "1.2.3",
          version: "1.2.3",
          securityAuditUrl:
            "https://clawhub.ai/openclaw/skills/agentreceipt/security-audit?version=1.2.3",
          security: { status: "clean", passed: true },
          scannerPayload: { ignored: true },
        },
      ],
    });

    const { ok, response, error } = await callSkillsHandler("skills.securityVerdicts", {});

    expect(error).toBeUndefined();
    expect(fetchClawHubSkillSecurityVerdictsMock).toHaveBeenCalledTimes(1);
    expect(fetchClawHubSkillSecurityVerdictsMock).toHaveBeenCalledWith({
      baseUrl: "https://clawhub.ai",
      items: [{ slug: "agentreceipt", version: "1.2.3" }],
      skipAuth: true,
    });
    expect(ok).toBe(true);
    expect(error).toBeUndefined();
    expect(response).toEqual({
      schema: "openclaw.skills.security-verdicts.v1",
      items: [
        expect.objectContaining({
          registry: "https://clawhub.ai",
          ok: true,
          requestedSlug: "agentreceipt",
          requestedVersion: "1.2.3",
          securityStatus: "clean",
          securityPassed: true,
        }),
      ],
    });
    expect(JSON.stringify(response)).not.toContain("scannerPayload");
    expect(JSON.stringify(response)).not.toContain('"security":');
  });

  it("does not passively fetch verdicts from a non-default registry", async () => {
    buildWorkspaceSkillStatusMock.mockReturnValue({
      workspaceDir: "/tmp/workspace",
      managedSkillsDir: "/tmp/openclaw/skills",
      skills: [
        {
          name: "agentreceipt",
          skillKey: "agentreceipt",
          clawhub: {
            status: "linked",
            valid: true,
            registry: "http://127.0.0.1:3999",
            slug: "agentreceipt",
            installedVersion: "1.2.3",
            installedAt: 123,
          },
        },
      ],
    });

    await expectEmptySecurityVerdictsWithoutFetch();
  });

  it("loads local Skill Card content for a known installed skill", async () => {
    buildWorkspaceSkillStatusMock.mockReturnValue({
      workspaceDir: "/tmp/workspace",
      managedSkillsDir: "/tmp/openclaw/skills",
      skills: [
        {
          name: "AgentReceipt",
          skillKey: "agentreceipt",
          baseDir: "/tmp/workspace/skills/agentreceipt",
          skillCard: {
            present: true,
            path: "/tmp/workspace/skills/agentreceipt/skill-card.md",
            sizeBytes: 34,
          },
        },
      ],
    });
    readLocalSkillCardContentSyncMock.mockReturnValue("# AgentReceipt\n\nLocal trust card.\n");

    const { ok, response, error } = await callSkillsHandler("skills.skillCard", {
      skillKey: "agentreceipt",
    });

    expect(error).toBeUndefined();
    expect(ok).toBe(true);
    expect(readLocalSkillCardContentSyncMock).toHaveBeenCalledWith(
      "/tmp/workspace/skills/agentreceipt",
    );
    expect(response).toEqual({
      schema: "openclaw.skills.skill-card.v1",
      skillKey: "agentreceipt",
      path: "/tmp/workspace/skills/agentreceipt/skill-card.md",
      sizeBytes: 34,
      content: "# AgentReceipt\n\nLocal trust card.\n",
    });
  });

  it("installs a ClawHub skill through skills.install", async () => {
    installSkillFromClawHubMock.mockResolvedValue({
      ok: true,
      slug: "calendar",
      version: "1.2.3",
      targetDir: "/tmp/workspace/skills/calendar",
      warning: "Review ClawHub security details before installing.",
    });

    const { ok, response, error } = await callSkillsHandler("skills.install", {
      source: "clawhub",
      slug: "calendar",
      version: "1.2.3",
    });

    expect(installSkillFromClawHubMock).toHaveBeenCalledWith({
      workspaceDir: "/tmp/workspace",
      slug: "calendar",
      version: "1.2.3",
      force: false,
      logger: expect.objectContaining({ warn: expect.any(Function) }),
      config: {},
    });
    expect(ok).toBe(true);
    expect(error).toBeUndefined();
    const result = response as
      | { ok?: boolean; message?: string; slug?: string; version?: string; warning?: string }
      | undefined;
    expect(result?.ok).toBe(true);
    expect(result?.message).toBe("Installed calendar@1.2.3");
    expect(result?.slug).toBe("calendar");
    expect(result?.version).toBe("1.2.3");
    expect(result?.warning).toBe("Review ClawHub security details before installing.");
  });

  it("deduplicates concurrent exact ClawHub installs across reconnects", async () => {
    let finishInstall: ((value: unknown) => void) | undefined;
    installSkillFromClawHubMock.mockReturnValue(
      new Promise((resolve) => {
        finishInstall = resolve;
      }),
    );

    const params = {
      source: "clawhub",
      slug: "calendar",
      version: "1.2.3",
    } as const;
    const first = callSkillsHandler("skills.install", params);
    const reconnectRetry = callSkillsHandler("skills.install", params);

    await vi.waitFor(() => expect(installSkillFromClawHubMock).toHaveBeenCalledTimes(1));
    finishInstall?.({
      ok: true,
      slug: "calendar",
      version: "1.2.3",
      targetDir: "/tmp/workspace/skills/calendar",
    });

    const [firstResult, retryResult] = await Promise.all([first, reconnectRetry]);
    expect(firstResult.ok).toBe(true);
    expect(retryResult.ok).toBe(true);
  });

  it("returns ClawHub skill install trust warnings in Gateway error details", async () => {
    installSkillFromClawHubMock.mockResolvedValue({
      ok: false,
      error: "ClawHub blocked this release; install was not started.",
      code: "clawhub_download_blocked",
      version: "1.2.3",
      warning: "BLOCKED - ClawHub flagged this release as malicious",
    });

    const { ok, response, error } = await callSkillsHandler("skills.install", {
      source: "clawhub",
      slug: "calendar",
    });

    expect(ok).toBe(false);
    expect(response).toEqual({
      ok: false,
      error: "ClawHub blocked this release; install was not started.",
      code: "clawhub_download_blocked",
      version: "1.2.3",
      warning: "BLOCKED - ClawHub flagged this release as malicious",
    });
    expect(error).toEqual({
      code: "UNAVAILABLE",
      message: "ClawHub blocked this release; install was not started.",
      details: {
        clawhubTrustCode: "clawhub_download_blocked",
        version: "1.2.3",
        warning: "BLOCKED - ClawHub flagged this release as malicious",
      },
    });
  });

  it("forwards ClawHub skill install risk acknowledgements", async () => {
    installSkillFromClawHubMock.mockResolvedValue({
      ok: true,
      slug: "calendar",
      version: "1.2.3",
      targetDir: "/tmp/workspace/skills/calendar",
    });

    const { ok, error } = await callSkillsHandler("skills.install", {
      source: "clawhub",
      slug: "calendar",
      version: "1.2.3",
      acknowledgeClawHubRisk: true,
    });

    expect(installSkillFromClawHubMock).toHaveBeenCalledWith({
      workspaceDir: "/tmp/workspace",
      slug: "calendar",
      version: "1.2.3",
      force: false,
      acknowledgeClawHubRisk: true,
      logger: expect.objectContaining({ warn: expect.any(Function) }),
      config: {},
    });
    expect(ok).toBe(true);
    expect(error).toBeUndefined();
  });

  it("routes explicit agent ClawHub installs through that agent workspace", async () => {
    listAgentIdsMock.mockReturnValue(["main", "research"]);
    resolveAgentWorkspaceDirMock.mockImplementation((_cfg, agentId) =>
      agentId === "research" ? "/tmp/research-workspace" : "/tmp/workspace",
    );
    installSkillFromClawHubMock.mockResolvedValue({
      ok: true,
      slug: "calendar",
      version: "1.2.3",
      targetDir: "/tmp/research-workspace/skills/calendar",
    });

    const { ok, error } = await callSkillsHandler("skills.install", {
      agentId: "research",
      source: "clawhub",
      slug: "calendar",
      version: "1.2.3",
    });

    expect(resolveAgentWorkspaceDirMock).toHaveBeenCalledWith({}, "research");
    expect(installSkillFromClawHubMock).toHaveBeenCalledWith({
      workspaceDir: "/tmp/research-workspace",
      slug: "calendar",
      version: "1.2.3",
      force: false,
      logger: expect.objectContaining({ warn: expect.any(Function) }),
      config: {},
    });
    expect(ok).toBe(true);
    expect(error).toBeUndefined();
  });

  it("accepts deprecated unsafe override without forwarding it to skill installs", async () => {
    installSkillMock.mockResolvedValue({
      ok: true,
      message: "Installed",
      stdout: "",
      stderr: "",
      code: 0,
    });

    const { ok, response, error } = await callSkillsHandler("skills.install", {
      name: "calendar",
      installId: "deps",
      dangerouslyForceUnsafeInstall: true,
      timeoutMs: 120_000,
    });

    expect(installSkillMock).toHaveBeenCalledWith({
      workspaceDir: "/tmp/workspace",
      skillName: "calendar",
      installId: "deps",
      timeoutMs: 120_000,
      config: {},
    });
    expect(ok).toBe(true);
    expect(error).toBeUndefined();
    const result = response as { ok?: boolean; message?: string } | undefined;
    expect(result?.ok).toBe(true);
    expect(result?.message).toBe("Installed");
  });

  it("updates ClawHub skills through skills.update", async () => {
    updateSkillsFromClawHubMock.mockResolvedValue([
      {
        ok: true,
        slug: "calendar",
        previousVersion: "1.2.2",
        version: "1.2.3",
        changed: true,
        targetDir: "/tmp/workspace/skills/calendar",
        warning: "Latest skill version needs review before use.",
      },
    ]);

    const { ok, response, error } = await callSkillsHandler("skills.update", {
      source: "clawhub",
      slug: "calendar",
    });

    expect(updateSkillsFromClawHubMock).toHaveBeenCalledWith({
      workspaceDir: "/tmp/workspace",
      slug: "calendar",
      logger: expect.objectContaining({ warn: expect.any(Function) }),
      config: {},
    });
    expect(ok).toBe(true);
    expect(error).toBeUndefined();
    const result = response as
      | {
          ok?: boolean;
          skillKey?: string;
          config?: {
            source?: string;
            results?: Array<{ ok?: boolean; slug?: string; version?: string; warning?: string }>;
          };
        }
      | undefined;
    expect(result?.ok).toBe(true);
    expect(result?.skillKey).toBe("calendar");
    expect(result?.config?.source).toBe("clawhub");
    expect(result?.config?.results).toHaveLength(1);
    expect(result?.config?.results?.[0]?.ok).toBe(true);
    expect(result?.config?.results?.[0]?.slug).toBe("calendar");
    expect(result?.config?.results?.[0]?.version).toBe("1.2.3");
    expect(result?.config?.results?.[0]?.warning).toBe(
      "Latest skill version needs review before use.",
    );
  });

  it("forwards ClawHub skill update risk acknowledgements", async () => {
    updateSkillsFromClawHubMock.mockResolvedValue([
      {
        ok: true,
        slug: "calendar",
        previousVersion: "1.2.2",
        version: "1.2.3",
        changed: true,
        targetDir: "/tmp/workspace/skills/calendar",
      },
    ]);

    const { ok, error } = await callSkillsHandler("skills.update", {
      source: "clawhub",
      slug: "calendar",
      acknowledgeClawHubRisk: true,
    });

    expect(updateSkillsFromClawHubMock).toHaveBeenCalledWith({
      workspaceDir: "/tmp/workspace",
      slug: "calendar",
      acknowledgeClawHubRisk: true,
      logger: expect.objectContaining({ warn: expect.any(Function) }),
      config: {},
    });
    expect(ok).toBe(true);
    expect(error).toBeUndefined();
  });

  it("returns ClawHub skill update trust warnings in Gateway error details", async () => {
    updateSkillsFromClawHubMock.mockResolvedValue([
      {
        ok: false,
        error: "ClawHub blocked this release; update was not started.",
        code: "clawhub_download_blocked",
        warning: "Latest skill version is marked malicious; OpenClaw will not download it.",
      },
    ]);

    const { ok, response, error } = await callSkillsHandler("skills.update", {
      source: "clawhub",
      slug: "calendar",
    });

    expect(ok).toBe(false);
    expect(response).toEqual({
      ok: false,
      skillKey: "calendar",
      config: {
        source: "clawhub",
        results: [
          {
            ok: false,
            error: "ClawHub blocked this release; update was not started.",
            code: "clawhub_download_blocked",
            warning: "Latest skill version is marked malicious; OpenClaw will not download it.",
          },
        ],
      },
    });
    expect(error).toEqual({
      code: "UNAVAILABLE",
      message: "ClawHub blocked this release; update was not started.",
      details: {
        results: [
          {
            ok: false,
            error: "ClawHub blocked this release; update was not started.",
            code: "clawhub_download_blocked",
            warning: "Latest skill version is marked malicious; OpenClaw will not download it.",
          },
        ],
        warnings: ["Latest skill version is marked malicious; OpenClaw will not download it."],
      },
    });
  });

  it("rejects ClawHub skills.update requests without slug or all", async () => {
    const { ok, error } = await callSkillsHandler("skills.update", {
      source: "clawhub",
    });
    const typedError = error as { code?: string; message?: string } | undefined;

    expect(ok).toBe(false);
    expect(typedError?.message).toContain('requires "slug" or "all"');
    expect(updateSkillsFromClawHubMock).not.toHaveBeenCalled();
  });
});
