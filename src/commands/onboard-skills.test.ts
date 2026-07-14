// Onboard skills tests cover skill setup prompts, package manager config, and skip behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";

const mocks = vi.hoisted(() => ({
  buildWorkspaceSkillStatus: vi.fn(),
  installSkill: vi.fn(),
  resolveInstallerKindReadiness: vi.fn(),
  detectBinary: vi.fn(),
  isContainerEnvironment: vi.fn(),
  resolveBrewExecutable: vi.fn(),
}));

// Module under test imports these at module scope.
vi.mock("../skills/discovery/status.js", () => ({
  buildWorkspaceSkillStatus: mocks.buildWorkspaceSkillStatus,
}));
vi.mock("../skills/lifecycle/install.js", () => ({
  installSkill: mocks.installSkill,
  resolveInstallerKindReadiness: mocks.resolveInstallerKindReadiness,
  MIN_AUTO_GO_VERSION: "1.21",
}));
vi.mock("../infra/container-environment.js", () => ({
  isContainerEnvironment: mocks.isContainerEnvironment,
}));
vi.mock("../infra/brew.js", () => ({
  resolveBrewExecutable: mocks.resolveBrewExecutable,
}));
vi.mock("./onboard-helpers.js", () => ({
  detectBinary: mocks.detectBinary,
}));

import { setupSkills, testing } from "./onboard-skills.js";

describe("skill onboarding text bounds", () => {
  it("keeps install failures and hints UTF-16 well-formed", () => {
    expect(testing.summarizeInstallFailure(`${"x".repeat(138)}🚀tail`)).toBe(`${"x".repeat(138)}…`);
    expect(testing.formatSkillHint({ description: `${"x".repeat(88)}🚀tail`, install: [] })).toBe(
      `${"x".repeat(88)}…`,
    );
  });
});

function createBundledSkill(params: {
  name: string;
  description: string;
  bins: string[];
  env?: string[];
  os?: string[];
  installLabel: string;
  installKind?: string;
}): {
  name: string;
  description: string;
  source: string;
  bundled: boolean;
  filePath: string;
  baseDir: string;
  skillKey: string;
  always: boolean;
  disabled: boolean;
  blockedByAllowlist: boolean;
  eligible: boolean;
  requirements: {
    bins: string[];
    anyBins: string[];
    env: string[];
    config: string[];
    os: string[];
  };
  missing: { bins: string[]; anyBins: string[]; env: string[]; config: string[]; os: string[] };
  configChecks: [];
  install: Array<{ id: string; kind: string; label: string; bins: string[] }>;
} {
  return {
    name: params.name,
    description: params.description,
    source: "openclaw-bundled",
    bundled: true,
    filePath: `/tmp/skills/${params.name}`,
    baseDir: `/tmp/skills/${params.name}`,
    skillKey: params.name,
    always: false,
    disabled: false,
    blockedByAllowlist: false,
    eligible: false,
    requirements: {
      bins: params.bins,
      anyBins: [],
      env: params.env ?? [],
      config: [],
      os: params.os ?? [],
    },
    missing: {
      bins: params.bins,
      anyBins: [],
      env: params.env ?? [],
      config: [],
      os: params.os ?? [],
    },
    configChecks: [],
    install: [
      {
        id: params.installKind ?? "brew",
        kind: params.installKind ?? "brew",
        label: params.installLabel,
        bins: params.bins,
      },
    ],
  };
}

function createWorkspaceSkill(
  params: Parameters<typeof createBundledSkill>[0],
): ReturnType<typeof createBundledSkill> {
  return {
    ...createBundledSkill(params),
    source: "openclaw-workspace",
    bundled: false,
  };
}

function mockMissingBrewStatus(skills: Array<ReturnType<typeof createBundledSkill>>): void {
  mocks.detectBinary.mockResolvedValue(false);
  mocks.resolveBrewExecutable.mockReturnValue(undefined);
  mocks.installSkill.mockResolvedValue({
    ok: true,
    message: "Installed",
    stdout: "",
    stderr: "",
    code: 0,
  });
  mocks.buildWorkspaceSkillStatus.mockReturnValue({
    workspaceDir: "/tmp/ws",
    managedSkillsDir: "/tmp/managed",
    skills,
  } as never);
}

function createPrompter(params: {
  configure?: boolean;
  showBrewInstall?: boolean;
  multiselect?: string[];
}): { prompter: WizardPrompter; notes: Array<{ title?: string; message: string }> } {
  const notes: Array<{ title?: string; message: string }> = [];

  const confirmAnswers: boolean[] = [];
  confirmAnswers.push(params.configure ?? true);

  const prompter: WizardPrompter = {
    intro: vi.fn(async () => {}),
    outro: vi.fn(async () => {}),
    note: vi.fn(async (message: string, title?: string) => {
      notes.push({ title, message });
    }),
    select: vi.fn(async () => "npm") as unknown as WizardPrompter["select"],
    multiselect: vi.fn(
      async () => params.multiselect ?? ["__skip__"],
    ) as unknown as WizardPrompter["multiselect"],
    text: vi.fn(async () => ""),
    confirm: vi.fn(async ({ message }) => {
      if (message === "Show Homebrew install command?") {
        return params.showBrewInstall ?? false;
      }
      return confirmAnswers.shift() ?? false;
    }),
    progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
  };

  return { prompter, notes };
}

const runtime: RuntimeEnv = {
  log: vi.fn(),
  error: vi.fn(),
  exit: ((code: number) => {
    throw new Error(`unexpected exit ${code}`);
  }) as RuntimeEnv["exit"],
};

const supportsHomebrewPrompt = process.platform === "darwin" || process.platform === "linux";

async function withPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, "platform", originalPlatformDescriptor);
  }
}

describe("setupSkills", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isContainerEnvironment.mockReset();
    mocks.resolveBrewExecutable.mockReset();
    mocks.resolveInstallerKindReadiness.mockReset();
    mocks.resolveInstallerKindReadiness.mockResolvedValue({ ready: true });
  });

  it("hides brew-only installs in Linux containers when brew is missing", async () => {
    await withPlatform("linux", async () => {
      mockMissingBrewStatus([
        createBundledSkill({
          name: "video-frames",
          description: "ffmpeg",
          bins: ["ffmpeg"],
          installLabel: "Install ffmpeg (brew)",
        }),
      ]);
      mocks.isContainerEnvironment.mockReturnValue(true);

      const { prompter, notes } = createPrompter({});
      await setupSkills({} as OpenClawConfig, "/tmp/ws", runtime, prompter);

      expect(prompter.multiselect).not.toHaveBeenCalled();
      expect(mocks.installSkill).not.toHaveBeenCalled();
      expect(notes.find((n) => n.title === "Container skill installs")).toBeDefined();
      expect(notes.find((n) => n.title === "Homebrew recommended")).toBeUndefined();
      expect(
        notes.find((n) => n.message.includes("No missing skill dependencies to install")),
      ).toBeUndefined();
    });
  });

  it("keeps brew-only installs visible when Linuxbrew is resolved off PATH", async () => {
    await withPlatform("linux", async () => {
      mockMissingBrewStatus([
        createBundledSkill({
          name: "video-frames",
          description: "ffmpeg",
          bins: ["ffmpeg"],
          installLabel: "Install ffmpeg (brew)",
        }),
      ]);
      mocks.isContainerEnvironment.mockReturnValue(true);
      mocks.resolveBrewExecutable.mockReturnValue("/home/linuxbrew/.linuxbrew/bin/brew");

      const { prompter, notes } = createPrompter({ multiselect: ["video-frames"] });
      await setupSkills({} as OpenClawConfig, "/tmp/ws", runtime, prompter);

      expect(prompter.multiselect).not.toHaveBeenCalled();
      expect(mocks.installSkill).toHaveBeenCalledWith(
        expect.objectContaining({ skillName: "video-frames", installId: "brew" }),
      );
      expect(notes.find((n) => n.title === "Container skill installs")).toBeUndefined();
      expect(notes.find((n) => n.title === "Homebrew recommended")).toBeUndefined();
    });
  });

  it("auto-installs ready bundled skill dependencies without running workspace skill recipes", async () => {
    mockMissingBrewStatus([
      createWorkspaceSkill({
        name: "repo-helper",
        description: "Workspace helper",
        bins: ["repo-helper"],
        installLabel: "Install repo-helper",
      }),
      createBundledSkill({
        name: "node-helper",
        description: "Node helper",
        bins: ["node-helper"],
        installLabel: "Install node-helper",
        installKind: "node",
      }),
    ]);

    const { prompter, notes } = createPrompter({});
    await setupSkills({} as OpenClawConfig, "/tmp/ws", runtime, prompter);

    expect(prompter.multiselect).not.toHaveBeenCalled();
    expect(mocks.installSkill).toHaveBeenCalledTimes(1);
    expect(mocks.installSkill).toHaveBeenCalledWith(
      expect.objectContaining({ skillName: "node-helper", installId: "node" }),
    );
    const installNote = notes.find((n) => n.message.includes("node-helper"));
    expect(installNote?.message).toContain("node-helper");
    expect(installNote?.message).not.toContain("repo-helper");
  });

  it("uses the requested node manager for node-backed auto installs", async () => {
    mockMissingBrewStatus([
      createBundledSkill({
        name: "node-helper",
        description: "Node helper",
        bins: ["node-helper"],
        installLabel: "Install node-helper",
        installKind: "node",
      }),
    ]);

    const { prompter } = createPrompter({});
    const next = await setupSkills({} as OpenClawConfig, "/tmp/ws", runtime, prompter, {
      nodeManager: "pnpm",
    });

    expect(next.skills?.install?.nodeManager).toBe("pnpm");
    expect(mocks.installSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        skillName: "node-helper",
        installId: "node",
        config: expect.objectContaining({
          skills: expect.objectContaining({
            install: expect.objectContaining({ nodeManager: "pnpm" }),
          }),
        }),
      }),
    );
  });

  it("recommends Homebrew and skips brew-backed deps when brew is missing", async () => {
    if (!supportsHomebrewPrompt) {
      return;
    }

    mockMissingBrewStatus([
      createBundledSkill({
        name: "apple-reminders",
        description: "macOS-only",
        bins: ["remindctl"],
        os: ["darwin"],
        installLabel: "Install remindctl (brew)",
      }),
      createBundledSkill({
        name: "video-frames",
        description: "ffmpeg",
        bins: ["ffmpeg"],
        installLabel: "Install ffmpeg (brew)",
      }),
    ]);
    mocks.resolveInstallerKindReadiness.mockResolvedValue({ ready: false, reason: "brew" });

    const { prompter, notes } = createPrompter({ multiselect: ["__skip__"] });
    await setupSkills({} as OpenClawConfig, "/tmp/ws", runtime, prompter);

    // OS-mismatched skill should be counted as unsupported, not installable/missing.
    expect(notes.find((n) => n.title === "Skills status")).toStrictEqual({
      title: "Skills status",
      message: [
        "Eligible: 0",
        "Missing requirements: 1",
        "Unsupported on this OS: 1",
        "Blocked by allowlist: 0",
      ].join("\n"),
    });

    const brewNote = notes.find((n) => n.title === "Homebrew recommended");
    expect(brewNote).toBeDefined();
    expect(prompter.multiselect).not.toHaveBeenCalled();
    expect(mocks.installSkill).not.toHaveBeenCalled();
    const manualNote = notes.find((n) => n.title === "Manual skill prerequisites");
    expect(manualNote?.message).toContain("Homebrew: video-frames");
  });

  it("does not run brew-backed installs when brew is missing", async () => {
    if (!supportsHomebrewPrompt) {
      return;
    }

    mockMissingBrewStatus([
      createBundledSkill({
        name: "video-frames",
        description: "ffmpeg",
        bins: ["ffmpeg"],
        installLabel: "Install ffmpeg (brew)",
      }),
    ]);
    mocks.resolveInstallerKindReadiness.mockResolvedValue({ ready: false, reason: "brew" });

    const { prompter, notes } = createPrompter({ multiselect: ["video-frames"] });
    await setupSkills({} as OpenClawConfig, "/tmp/ws", runtime, prompter);

    const brewNote = notes.find((n) => n.title === "Homebrew recommended");
    expect(brewNote?.title).toBe("Homebrew recommended");
    expect(mocks.installSkill).not.toHaveBeenCalled();
    const manualNote = notes.find((n) => n.title === "Manual skill prerequisites");
    expect(manualNote?.message).toContain("Homebrew: video-frames");
  });

  it("skips go and uv installs when local tool prerequisites are not ready", async () => {
    await withPlatform("linux", async () => {
      mockMissingBrewStatus([
        createBundledSkill({
          name: "blogwatcher",
          description: "RSS helper",
          bins: ["blogwatcher"],
          installLabel: "Install blogwatcher (go)",
          installKind: "go",
        }),
        createBundledSkill({
          name: "nano-pdf",
          description: "PDF helper",
          bins: ["nano-pdf"],
          installLabel: "Install nano-pdf (uv)",
          installKind: "uv",
        }),
        createBundledSkill({
          name: "mcporter",
          description: "MCP helper",
          bins: ["mcporter"],
          installLabel: "Install mcporter (node)",
          installKind: "node",
        }),
      ]);
      mocks.resolveInstallerKindReadiness.mockImplementation(async (kind: string) =>
        kind === "go" || kind === "uv" ? { ready: false, reason: kind } : { ready: true },
      );

      const { prompter, notes } = createPrompter({});
      await setupSkills({} as OpenClawConfig, "/tmp/ws", runtime, prompter);

      expect(mocks.installSkill).toHaveBeenCalledTimes(1);
      expect(mocks.installSkill).toHaveBeenCalledWith(
        expect.objectContaining({ skillName: "mcporter", installId: "node" }),
      );
      const manualNote = notes.find((n) => n.title === "Manual skill prerequisites");
      expect(manualNote?.message).toContain("Go toolchain (1.21+): blogwatcher");
      expect(manualNote?.message).toContain("uv: nano-pdf");
    });
  });

  it("groups Go prerequisite skips discovered after policy approval", async () => {
    await withPlatform("linux", async () => {
      mockMissingBrewStatus([
        createBundledSkill({
          name: "blogwatcher",
          description: "RSS helper",
          bins: ["blogwatcher"],
          installLabel: "Install blogwatcher (go)",
          installKind: "go",
        }),
      ]);
      mocks.installSkill.mockResolvedValueOnce({
        ok: false,
        message:
          "Install failed (exit 1): go: blogwatcher requires go >= 1.24 (running go 1.22; GOTOOLCHAIN=local)",
        stdout: "",
        stderr: "",
        code: null,
        skipReason: "go",
      });

      const { prompter, notes } = createPrompter({});
      await setupSkills({} as OpenClawConfig, "/tmp/ws", runtime, prompter);

      expect(mocks.installSkill).toHaveBeenCalledTimes(1);
      const manualNote = notes.find((n) => n.title === "Manual skill prerequisites");
      expect(manualNote?.message).toContain("Go toolchain (1.21+): blogwatcher");
      expect(manualNote?.message).toContain(
        "blogwatcher: go: blogwatcher requires go >= 1.24 (running go 1.22; GOTOOLCHAIN=local)",
      );
      expect(runtime.log).not.toHaveBeenCalledWith(expect.stringContaining("Docs:"));
    });
  });

  it("displays a clear empty state note when all skill dependencies are ready", async () => {
    mockMissingBrewStatus([]);

    const { prompter, notes } = createPrompter({});
    await setupSkills({} as OpenClawConfig, "/tmp/ws", runtime, prompter);

    expect(prompter.multiselect).not.toHaveBeenCalled();
    const emptyStateNote = notes.find((n) => n.title === "All skills ready");
    expect(emptyStateNote?.message).toContain("No missing skill dependencies to install");
    expect(emptyStateNote?.message).toContain("openclaw skills list --verbose");
    expect(emptyStateNote?.message).toContain("openclaw skills check");
  });

  it("does not recommend Homebrew on FreeBSD", async () => {
    await withPlatform("freebsd", async () => {
      mockMissingBrewStatus([
        createBundledSkill({
          name: "video-frames",
          description: "ffmpeg",
          bins: ["ffmpeg"],
          installLabel: "Install ffmpeg (brew)",
        }),
      ]);

      const { prompter, notes } = createPrompter({ multiselect: ["video-frames"] });
      await setupSkills({} as OpenClawConfig, "/tmp/ws", runtime, prompter);

      const brewNote = notes.find((n) => n.title === "Homebrew recommended");
      expect(brewNote).toBeUndefined();
      expect(prompter.multiselect).not.toHaveBeenCalled();
      expect(mocks.detectBinary).not.toHaveBeenCalledWith("brew");
    });
  });

  it("does not ask for API keys when skills are missing env vars", async () => {
    mockMissingBrewStatus([
      createBundledSkill({
        name: "goplaces",
        description: "Places lookup",
        bins: [],
        env: ["GOOGLE_PLACES_API_KEY"],
        installLabel: "",
      }),
    ]);

    const { prompter } = createPrompter({});
    const next = await setupSkills({} as OpenClawConfig, "/tmp/ws", runtime, prompter);

    expect(next).toEqual({});
    expect(prompter.confirm).not.toHaveBeenCalled();
    expect(prompter.text).not.toHaveBeenCalled();
    expect(prompter.multiselect).not.toHaveBeenCalled();
  });
});
