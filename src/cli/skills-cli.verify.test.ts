// Skills CLI verify tests cover skill verification command behavior and diagnostics.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerSkillsCli } from "./skills-cli.js";

const mocks = vi.hoisted(() => {
  const runtimeStdout: string[] = [];
  const runtimeErrors: string[] = [];
  const defaultRuntime = {
    log: vi.fn(),
    error: vi.fn((value: unknown) => {
      runtimeErrors.push(String(value));
    }),
    writeStdout: vi.fn((value: string) => {
      runtimeStdout.push(value.endsWith("\n") ? value.slice(0, -1) : value);
    }),
    writeJson: vi.fn((value: unknown, space = 2) => {
      runtimeStdout.push(JSON.stringify(value, null, space > 0 ? space : undefined));
    }),
    exit: vi.fn((code: number) => {
      throw new Error(`__exit__:${code}`);
    }),
  };
  return {
    defaultRuntime,
    runtimeStdout,
    runtimeErrors,
    loadConfigMock: vi.fn(() => ({})),
    resolveAgentIdByWorkspacePathMock: vi.fn(
      (_config: unknown, _workspacePath: string): string | undefined => undefined,
    ),
    resolveDefaultAgentIdMock: vi.fn((_config: unknown) => "main"),
    resolveAgentWorkspaceDirMock: vi.fn((_config: unknown, _agentId: string) => ""),
    resolveClawHubBaseUrlMock: vi.fn((baseUrl?: string) =>
      (baseUrl ?? "https://clawhub.ai").replace(/\/+$/, ""),
    ),
    fetchClawHubSkillVerificationMock: vi.fn(),
    fetchClawHubSkillCardMock: vi.fn(),
    noopAsync: vi.fn(),
  };
});

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.defaultRuntime,
}));

vi.mock("../utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils.js")>()),
  CONFIG_DIR: "/tmp/openclaw-config",
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => mocks.loadConfigMock(),
  loadConfig: () => mocks.loadConfigMock(),
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentIdByWorkspacePath: (config: unknown, workspacePath: string) =>
    mocks.resolveAgentIdByWorkspacePathMock(config, workspacePath),
  resolveDefaultAgentId: (config: unknown) => mocks.resolveDefaultAgentIdMock(config),
  resolveAgentWorkspaceDir: (config: unknown, agentId: string) =>
    mocks.resolveAgentWorkspaceDirMock(config, agentId),
}));

vi.mock("../infra/clawhub.js", () => ({
  CLAWHUB_SKILLS_SH_TRUST_LABEL: "Not scanned by ClawHub",
  CLAWHUB_SKILLS_SH_TRUST_STATE: "not-scanned-by-clawhub",
  downloadClawHubSkillArchive: mocks.noopAsync,
  fetchClawHubSkillCard: (...args: unknown[]) => mocks.fetchClawHubSkillCardMock(...args),
  fetchClawHubSkillDetail: mocks.noopAsync,
  fetchClawHubSkillVerification: (...args: unknown[]) =>
    mocks.fetchClawHubSkillVerificationMock(...args),
  resolveClawHubBaseUrl: (baseUrl?: string) => mocks.resolveClawHubBaseUrlMock(baseUrl),
  searchClawHubSkills: mocks.noopAsync,
}));

describe("skills verify CLI", () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-verify-cli-"));
    mocks.runtimeStdout.length = 0;
    mocks.runtimeErrors.length = 0;
    mocks.resolveAgentWorkspaceDirMock.mockReset();
    mocks.resolveAgentWorkspaceDirMock.mockReturnValue(workspaceDir);
    mocks.fetchClawHubSkillVerificationMock.mockReset();
    mocks.fetchClawHubSkillCardMock.mockReset();
    mocks.defaultRuntime.log.mockClear();
    mocks.defaultRuntime.error.mockClear();
    mocks.defaultRuntime.writeStdout.mockClear();
    mocks.defaultRuntime.writeJson.mockClear();
    mocks.defaultRuntime.exit.mockClear();
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  async function runCommand(argv: string[]) {
    const program = new Command();
    program.exitOverride();
    registerSkillsCli(program);
    try {
      await program.parseAsync(argv, { from: "user" });
    } catch (error) {
      if (error instanceof Error && error.message === "__exit__:0") {
        return;
      }
      throw error;
    }
  }

  async function writeInstalledGeneratedCardSkill() {
    const skillDir = path.join(workspaceDir, "skills", "agentreceipt");
    await fs.mkdir(path.join(skillDir, ".clawhub"), { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Agent Receipt\n", "utf8");
    await fs.writeFile(
      path.join(skillDir, "skill-card.md"),
      "# Generated Skill Card\n\nThis file is added by ClawHub during bundle assembly.\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(skillDir, ".clawhub", "origin.json"),
      `${JSON.stringify(
        {
          version: 1,
          registry: "https://private.example.com/clawhub",
          slug: "agentreceipt",
          installedVersion: "1.2.3",
          installedAt: 123,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await fs.mkdir(path.join(workspaceDir, ".clawhub"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, ".clawhub", "lock.json"),
      `${JSON.stringify(
        {
          version: 1,
          skills: {
            agentreceipt: {
              version: "1.2.3",
              installedAt: 123,
              registry: "https://private.example.com/clawhub",
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }

  async function writeInstalledSkillsShSkill(
    requestedReference = "skills-sh:patrick-erichsen/skills/html",
  ) {
    const trustState = "not-scanned-by-clawhub";
    const installedVersion = "a".repeat(40);
    const skillDir = path.join(workspaceDir, "skills", "html");
    await fs.mkdir(path.join(skillDir, ".clawhub"), { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "# HTML\n", "utf8");
    await fs.writeFile(
      path.join(skillDir, ".clawhub", "origin.json"),
      `${JSON.stringify(
        {
          version: 1,
          registry: "https://private.example.com/clawhub",
          slug: "html",
          requestedReference,
          trustState,
          installedVersion,
          installedAt: 123,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await fs.mkdir(path.join(workspaceDir, ".clawhub"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, ".clawhub", "lock.json"),
      `${JSON.stringify(
        {
          version: 1,
          skills: {
            html: {
              version: installedVersion,
              installedAt: 123,
              registry: "https://private.example.com/clawhub",
              requestedReference,
              trustState,
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    return { requestedReference, trustState };
  }

  function mockUnscannedSkillsShVerification() {
    mocks.fetchClawHubSkillVerificationMock.mockResolvedValueOnce({
      schema: "clawhub.skill.verify.v1",
      ok: true,
      decision: "unscanned",
      reasons: ["security.not_scanned_by_clawhub"],
      skill: { slug: "html" },
      publisher: { handle: "patrick-erichsen" },
      version: { version: "a".repeat(40) },
      card: { available: true },
      artifact: { sourceFingerprint: "source-fp" },
      provenance: null,
      security: { status: "not-scanned", passed: false },
      signature: { status: "unsigned" },
    });
  }

  it("verifies an installed skills.sh skill by its exact reference without a version selector", async () => {
    const { requestedReference, trustState } = await writeInstalledSkillsShSkill();
    mockUnscannedSkillsShVerification();

    await expect(runCommand(["skills", "verify", requestedReference])).rejects.toThrow(
      "__exit__:1",
    );

    expect(mocks.fetchClawHubSkillVerificationMock).toHaveBeenCalledWith({
      slug: "html",
      requestedReference,
      version: undefined,
      tag: undefined,
      baseUrl: "https://private.example.com/clawhub",
    });
    const payload = JSON.parse(mocks.runtimeStdout.at(-1) ?? "{}") as {
      openclaw?: { trust?: { state?: string; label?: string } };
    };
    expect(payload.openclaw?.trust).toEqual({
      state: trustState,
      label: "Not scanned by ClawHub",
    });
  });

  it("rejects a different installed skills.sh reference before network verification", async () => {
    await writeInstalledSkillsShSkill("skills-sh:owner-a/repo-a/html");

    await expect(runCommand(["skills", "verify", "skills-sh:owner-b/repo-b/html"])).rejects.toThrow(
      "__exit__:1",
    );

    expect(mocks.runtimeErrors).toContain(
      'Skill "html" is not tracked from skills-sh:owner-b/repo-b/html.',
    );
    expect(mocks.fetchClawHubSkillVerificationMock).not.toHaveBeenCalled();
  });

  it("verifies an installed skills.sh skill by slug without a version selector", async () => {
    const { requestedReference } = await writeInstalledSkillsShSkill();
    mockUnscannedSkillsShVerification();

    await expect(runCommand(["skills", "verify", "html"])).rejects.toThrow("__exit__:1");

    expect(mocks.fetchClawHubSkillVerificationMock).toHaveBeenCalledWith({
      slug: "html",
      requestedReference,
      version: undefined,
      tag: undefined,
      baseUrl: "https://private.example.com/clawhub",
    });
    expect(mocks.defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("does not reject an installed bundle just because ClawHub generated skill-card.md", async () => {
    await writeInstalledGeneratedCardSkill();
    mocks.fetchClawHubSkillVerificationMock.mockResolvedValueOnce({
      schema: "clawhub.skill.verify.v1",
      ok: true,
      decision: "pass",
      reasons: [],
      skill: { slug: "agentreceipt" },
      publisher: { handle: "openclaw" },
      version: { version: "1.2.3" },
      card: { available: true },
      artifact: {
        sourceFingerprint: "publisher-source-fingerprint-without-generated-card",
        bundleFingerprints: ["generated-bundle-fingerprint-with-skill-card"],
      },
      provenance: null,
      security: { status: "clean" },
      signature: { status: "unsigned" },
    });

    await runCommand(["skills", "verify", "agentreceipt"]);

    expect(mocks.fetchClawHubSkillVerificationMock).toHaveBeenCalledWith({
      slug: "agentreceipt",
      version: "1.2.3",
      tag: undefined,
      baseUrl: "https://private.example.com/clawhub",
    });
    const payload = JSON.parse(mocks.runtimeStdout.at(-1) ?? "{}") as Record<string, unknown>;
    expect(payload.ok).toBe(true);
    expect(payload.artifact).toEqual({
      sourceFingerprint: "publisher-source-fingerprint-without-generated-card",
      bundleFingerprints: ["generated-bundle-fingerprint-with-skill-card"],
    });
    expect(mocks.defaultRuntime.exit).not.toHaveBeenCalled();
    expect(mocks.runtimeErrors).toStrictEqual([]);
  });

  it("verifies owner-qualified registry refs with explicit versions", async () => {
    mocks.fetchClawHubSkillVerificationMock.mockResolvedValueOnce({
      schema: "clawhub.skill.verify.v1",
      ok: true,
      decision: "pass",
      reasons: [],
      skill: { slug: "weather" },
      publisher: { handle: "demo-owner" },
      version: { version: "2.0.0" },
      card: { available: true },
      artifact: { sourceFingerprint: "source-fp" },
      provenance: null,
      security: { status: "clean" },
      signature: { status: "unsigned" },
    });

    await runCommand(["skills", "verify", "@demo-owner/weather", "--version", "2.0.0"]);

    expect(mocks.fetchClawHubSkillVerificationMock).toHaveBeenCalledWith({
      slug: "weather",
      ownerHandle: "demo-owner",
      version: "2.0.0",
      tag: undefined,
      baseUrl: "https://clawhub.ai",
    });
    const payload = JSON.parse(mocks.runtimeStdout.at(-1) ?? "{}") as {
      openclaw?: { resolution?: { source?: string; selector?: string } };
    };
    expect(payload.openclaw?.resolution).toMatchObject({
      source: "registry",
      selector: "version",
    });
    expect(mocks.defaultRuntime.exit).not.toHaveBeenCalled();
    expect(mocks.runtimeErrors).toStrictEqual([]);
  });

  it("prints cards for owner-qualified tag verification", async () => {
    mocks.fetchClawHubSkillVerificationMock.mockResolvedValueOnce({
      schema: "clawhub.skill.verify.v1",
      ok: true,
      decision: "pass",
      reasons: [],
      skill: { slug: "weather" },
      publisher: { handle: "demo-owner" },
      version: { version: "2.0.0" },
      card: {
        available: true,
        url: "https://cards.example.test/generated/weather.md",
      },
      artifact: { sourceFingerprint: "source-fp" },
      provenance: null,
      security: { status: "clean" },
      signature: { status: "unsigned" },
    });
    mocks.fetchClawHubSkillCardMock.mockResolvedValueOnce("# Weather\n");

    await runCommand(["skills", "verify", "@demo-owner/weather", "--tag", "latest", "--card"]);

    expect(mocks.fetchClawHubSkillVerificationMock).toHaveBeenCalledWith({
      slug: "weather",
      ownerHandle: "demo-owner",
      version: undefined,
      tag: "latest",
      baseUrl: "https://clawhub.ai",
    });
    expect(mocks.fetchClawHubSkillCardMock).toHaveBeenCalledWith({
      url: "https://cards.example.test/generated/weather.md",
      baseUrl: "https://clawhub.ai",
    });
    expect(mocks.runtimeStdout.at(-1)).toBe("# Weather");
    expect(mocks.defaultRuntime.exit).not.toHaveBeenCalled();
    expect(mocks.runtimeErrors).toStrictEqual([]);
  });

  it("surfaces only server-verified source provenance in verify JSON", async () => {
    const sourceUrl = "https://github.com/openclaw/skills/tree/main/agentreceipt";
    const verifiedSourceUrl =
      "https://github.com/openclaw/skills/tree/0123456789abcdef0123456789abcdef01234567/agentreceipt";
    mocks.fetchClawHubSkillVerificationMock.mockResolvedValueOnce({
      schema: "clawhub.skill.verify.v1",
      ok: true,
      decision: "pass",
      reasons: [],
      skill: { slug: "agentreceipt" },
      publisher: { handle: "openclaw" },
      version: { version: "1.0.0" },
      card: { available: true },
      artifact: { sourceFingerprint: "source-fp" },
      provenance: {
        source: "server-resolved-github-import",
        kind: "github",
        url: sourceUrl,
        repo: "openclaw/skills",
        ref: "main",
        commit: "0123456789abcdef0123456789abcdef01234567",
        path: "agentreceipt",
      },
      security: { status: "clean" },
      signature: { status: "unsigned" },
    });

    await runCommand(["skills", "verify", "agentreceipt"]);

    const payload = JSON.parse(mocks.runtimeStdout.at(-1) ?? "{}") as {
      openclaw?: { verifiedSourceUrl?: string };
    };
    expect(payload.openclaw?.verifiedSourceUrl).toBe(verifiedSourceUrl);
    expect(mocks.defaultRuntime.exit).not.toHaveBeenCalled();
    expect(mocks.runtimeErrors).toStrictEqual([]);
  });

  it("does not promote unavailable provenance URLs in verify JSON", async () => {
    mocks.fetchClawHubSkillVerificationMock.mockResolvedValueOnce({
      schema: "clawhub.skill.verify.v1",
      ok: true,
      decision: "pass",
      reasons: [],
      skill: { slug: "agentreceipt" },
      publisher: { handle: "openclaw" },
      version: { version: "1.0.0" },
      card: { available: true },
      artifact: { sourceFingerprint: "source-fp" },
      provenance: {
        source: "unavailable",
        url: "https://github.com/openclaw/skills/tree/unverified/agentreceipt",
      },
      security: { status: "clean" },
      signature: { status: "unsigned" },
    });

    await runCommand(["skills", "verify", "agentreceipt"]);

    const payload = JSON.parse(mocks.runtimeStdout.at(-1) ?? "{}") as {
      openclaw?: { verifiedSourceUrl?: string };
    };
    expect(payload.openclaw?.verifiedSourceUrl).toBeUndefined();
    expect(mocks.defaultRuntime.exit).not.toHaveBeenCalled();
    expect(mocks.runtimeErrors).toStrictEqual([]);
  });
});
