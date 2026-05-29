import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import {
  COPILOT_SDK_FALLBACK_DIR,
  COPILOT_SDK_INSTALL_MANIFEST_DIR,
  COPILOT_SDK_SPEC,
  ensureCopilotSdkForModelSelection,
  installCopilotSdk,
  isCopilotSdkInstalled,
  resolveCopilotSdkFallbackDir,
  selectedModelShouldEnsureCopilotSdk,
  verifyCopilotSdkInstall,
} from "./copilot-sdk-install.js";

function fakeRuntime(): RuntimeEnv {
  return {
    log: () => undefined,
    error: () => undefined,
    exit: () => undefined,
  };
}

function fakePrompter(overrides: Partial<WizardPrompter> = {}): WizardPrompter {
  const noop = async () => undefined as never;
  return {
    intro: async () => undefined,
    outro: async () => undefined,
    note: async () => undefined,
    plain: async () => undefined,
    select: noop,
    multiselect: noop,
    text: async () => "",
    confirm: async () => true,
    progress: () => ({ update: () => undefined, stop: () => undefined }),
    ...overrides,
  } as WizardPrompter;
}

const emptyCfg = {} as OpenClawConfig;

function cfgWithCopilotRuntime(): OpenClawConfig {
  return {
    models: {
      providers: {
        "github-copilot": { agentRuntime: { id: "copilot" } },
      },
    },
  } as unknown as OpenClawConfig;
}

describe("selectedModelShouldEnsureCopilotSdk", () => {
  it("returns false for github-copilot/* without explicit agentRuntime opt-in", () => {
    // Built-in GitHub Copilot provider already supports github-copilot/*;
    // we must not nag users with the SDK install prompt by default.
    expect(
      selectedModelShouldEnsureCopilotSdk({
        cfg: emptyCfg,
        model: "github-copilot/gpt-4o",
      }),
    ).toBe(false);
  });

  it("returns true for github-copilot/* when agentRuntime.id = copilot is set", () => {
    expect(
      selectedModelShouldEnsureCopilotSdk({
        cfg: cfgWithCopilotRuntime(),
        model: "github-copilot/gpt-4o",
      }),
    ).toBe(true);
  });

  it("returns false for other providers", () => {
    expect(
      selectedModelShouldEnsureCopilotSdk({ cfg: emptyCfg, model: "anthropic/claude-3" }),
    ).toBe(false);
    expect(selectedModelShouldEnsureCopilotSdk({ cfg: emptyCfg, model: "openai/gpt-4o" })).toBe(
      false,
    );
  });

  it("returns false when model is undefined", () => {
    expect(selectedModelShouldEnsureCopilotSdk({ cfg: emptyCfg })).toBe(false);
  });
});

describe("ensureCopilotSdkForModelSelection", () => {
  it("returns required=false and no-ops when model is not github-copilot", async () => {
    const confirm = vi.fn();
    const result = await ensureCopilotSdkForModelSelection({
      cfg: emptyCfg,
      model: "anthropic/claude-3",
      prompter: fakePrompter({ confirm }),
      runtime: fakeRuntime(),
      isInstalled: () => false,
    });
    expect(result.required).toBe(false);
    expect(result.installed).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("returns required=false for github-copilot when config does not opt into the SDK runtime", async () => {
    // Same model, same env, but no agentRuntime.id=copilot anywhere in the
    // config -> the built-in GitHub Copilot provider stays in charge and the
    // SDK installer is not invoked. This is the entire point of P1 gating.
    const confirm = vi.fn();
    const install = vi.fn();
    const result = await ensureCopilotSdkForModelSelection({
      cfg: emptyCfg,
      model: "github-copilot/gpt-4o",
      prompter: fakePrompter({ confirm }),
      runtime: fakeRuntime(),
      isInstalled: () => false,
      install,
    });
    expect(result.required).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
  });

  it("returns already-installed without prompting when SDK is present", async () => {
    const confirm = vi.fn();
    const install = vi.fn();
    const result = await ensureCopilotSdkForModelSelection({
      cfg: cfgWithCopilotRuntime(),
      model: "github-copilot/gpt-4o",
      prompter: fakePrompter({ confirm }),
      runtime: fakeRuntime(),
      isInstalled: () => true,
      install,
    });
    expect(result.required).toBe(true);
    expect(result.installed).toBe(false);
    expect(result.status).toBe("already-installed");
    expect(confirm).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
  });

  it("does not prompt or auto-install in Nix mode", async () => {
    const previousNixMode = process.env.OPENCLAW_NIX_MODE;
    process.env.OPENCLAW_NIX_MODE = "1";
    try {
      const confirm = vi.fn();
      const install = vi.fn();
      const note = vi.fn();
      const result = await ensureCopilotSdkForModelSelection({
        cfg: cfgWithCopilotRuntime(),
        model: "github-copilot/gpt-4o",
        prompter: fakePrompter({ confirm, note }),
        runtime: fakeRuntime(),
        isInstalled: () => false,
        install,
      });
      expect(result).toMatchObject({
        required: true,
        installed: false,
        status: "nix-mode",
      });
      expect(confirm).not.toHaveBeenCalled();
      expect(install).not.toHaveBeenCalled();
      expect(note).toHaveBeenCalledOnce();
      expect(String(note.mock.calls[0]?.[0])).toContain("OPENCLAW_NIX_MODE=1");
    } finally {
      if (previousNixMode === undefined) {
        delete process.env.OPENCLAW_NIX_MODE;
      } else {
        process.env.OPENCLAW_NIX_MODE = previousNixMode;
      }
    }
  });

  it("prompts and installs when SDK is missing and user confirms", async () => {
    const confirm = vi.fn(async () => true);
    const install = vi.fn(async () => ({
      installed: true,
      fallbackDir: COPILOT_SDK_FALLBACK_DIR,
      spec: COPILOT_SDK_SPEC,
    }));
    const result = await ensureCopilotSdkForModelSelection({
      cfg: cfgWithCopilotRuntime(),
      model: "github-copilot/gpt-4o",
      prompter: fakePrompter({ confirm }),
      runtime: fakeRuntime(),
      isInstalled: () => false,
      install,
    });
    expect(confirm).toHaveBeenCalledOnce();
    expect(install).toHaveBeenCalledOnce();
    expect(result.required).toBe(true);
    expect(result.installed).toBe(true);
    expect(result.status).toBe("installed");
  });

  it("respects user decline and reports status=declined", async () => {
    const confirm = vi.fn(async () => false);
    const install = vi.fn();
    const note = vi.fn();
    const result = await ensureCopilotSdkForModelSelection({
      cfg: cfgWithCopilotRuntime(),
      model: "github-copilot/gpt-4o",
      prompter: fakePrompter({ confirm, note }),
      runtime: fakeRuntime(),
      isInstalled: () => false,
      install,
    });
    expect(confirm).toHaveBeenCalledOnce();
    expect(install).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledOnce();
    expect(result.required).toBe(true);
    expect(result.installed).toBe(false);
    expect(result.status).toBe("declined");
  });

  it("reports status=failed and surfaces error via note when install throws", async () => {
    const confirm = vi.fn(async () => true);
    const install = vi.fn(async () => {
      throw new Error("network down");
    });
    const note = vi.fn();
    const result = await ensureCopilotSdkForModelSelection({
      cfg: cfgWithCopilotRuntime(),
      model: "github-copilot/gpt-4o",
      prompter: fakePrompter({ confirm, note }),
      runtime: fakeRuntime(),
      isInstalled: () => false,
      install,
    });
    expect(result.required).toBe(true);
    expect(result.installed).toBe(false);
    expect(result.status).toBe("failed");
    expect(note).toHaveBeenCalledOnce();
    const noteMessage = (note as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
    expect(noteMessage).toContain("network down");
    expect(noteMessage).toContain("copilot-sdk-install-manifest");
  });
});

function writeFakePinnedManifest(manifestDir: string): void {
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  fs.writeFileSync(
    path.join(manifestDir, "package.json"),
    JSON.stringify({ dependencies: { "@github/copilot-sdk": "1.0.0-beta.4" } }),
  );
  fs.writeFileSync(
    path.join(manifestDir, "package-lock.json"),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "node_modules/@github/copilot-sdk": { version: "1.0.0-beta.4" },
        "node_modules/@github/copilot": { version: "1.0.48" },
      },
    }),
  );
}

function installFakeFallbackGraph(dir: string, sdkVersion: string, cliVersion: string): void {
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const sdkDir = path.join(dir, "node_modules", "@github", "copilot-sdk");
  const cliDir = path.join(dir, "node_modules", "@github", "copilot");
  fs.mkdirSync(sdkDir, { recursive: true });
  fs.mkdirSync(cliDir, { recursive: true });
  fs.writeFileSync(
    path.join(sdkDir, "package.json"),
    JSON.stringify({ name: "@github/copilot-sdk", version: sdkVersion }),
  );
  fs.writeFileSync(
    path.join(cliDir, "package.json"),
    JSON.stringify({ name: "@github/copilot", version: cliVersion }),
  );
}

describe("installCopilotSdk", () => {
  it("stages the pinned manifest and runs the install command when SDK is missing", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-copilot-sdk-install-"));
    const manifestDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-copilot-sdk-manifest-"));
    fs.writeFileSync(
      path.join(manifestDir, "package.json"),
      JSON.stringify({ dependencies: { "@github/copilot-sdk": "1.0.0-beta.4" } }),
    );
    fs.writeFileSync(
      path.join(manifestDir, "package-lock.json"),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "node_modules/@github/copilot-sdk": { version: "1.0.0-beta.4" },
          "node_modules/@github/copilot": { version: "1.0.48" },
        },
      }),
    );
    try {
      const runInstall = vi.fn(
        async ({ dir }: { dir: string; spec: string; manifestDir: string }) => {
          const sdkDir = path.join(dir, "node_modules", "@github", "copilot-sdk");
          const cliDir = path.join(dir, "node_modules", "@github", "copilot");
          fs.mkdirSync(sdkDir, { recursive: true });
          fs.mkdirSync(cliDir, { recursive: true });
          fs.writeFileSync(
            path.join(sdkDir, "package.json"),
            JSON.stringify({ name: "@github/copilot-sdk", version: "1.0.0-beta.4" }),
          );
          fs.writeFileSync(
            path.join(cliDir, "package.json"),
            JSON.stringify({ name: "@github/copilot", version: "1.0.48" }),
          );
        },
      );
      const result = await installCopilotSdk({
        fallbackDir: tmp,
        manifestDir,
        runInstall,
      });
      expect(runInstall).toHaveBeenCalledOnce();
      // Staged manifest must land in fallbackDir for `npm ci` to use.
      expect(fs.existsSync(path.join(tmp, "package.json"))).toBe(true);
      expect(fs.existsSync(path.join(tmp, "package-lock.json"))).toBe(true);
      // And the staged manifest must be byte-identical to the pinned source.
      expect(fs.readFileSync(path.join(tmp, "package-lock.json"), "utf8")).toBe(
        fs.readFileSync(path.join(manifestDir, "package-lock.json"), "utf8"),
      );
      // runInstall receives the manifestDir argument so it can rely on it.
      const call = runInstall.mock.calls[0][0];
      expect(call.manifestDir).toBe(manifestDir);
      expect(call.dir).toBe(tmp);
      expect(result.installed).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(manifestDir, { recursive: true, force: true });
    }
  });

  it("returns installed=false when fallback graph matches the pinned manifest (skip install)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-copilot-sdk-install-"));
    const manifestDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-copilot-sdk-manifest-"));
    try {
      writeFakePinnedManifest(manifestDir);
      installFakeFallbackGraph(tmp, "1.0.0-beta.4", "1.0.48");
      // Copy the manifest lock into the fallback dir to simulate a prior
      // successful install having staged it (npm ci does this).
      fs.copyFileSync(
        path.join(manifestDir, "package-lock.json"),
        path.join(tmp, "package-lock.json"),
      );
      const runInstall = vi.fn();
      const result = await installCopilotSdk({ fallbackDir: tmp, manifestDir, runInstall });
      expect(runInstall).not.toHaveBeenCalled();
      expect(result.installed).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(manifestDir, { recursive: true, force: true });
    }
  });

  it("reinstalls when the fallback dir has the SDK but no pinned lock (stale tree)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-copilot-sdk-install-"));
    const manifestDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-copilot-sdk-manifest-"));
    try {
      writeFakePinnedManifest(manifestDir);
      // Stale install: SDK dir exists but no package-lock.json at the
      // fallback root, so the verifier must reject.
      installFakeFallbackGraph(tmp, "1.0.0-beta.4", "1.0.48");
      const runInstall = vi.fn(async ({ dir }: { dir: string }) => {
        installFakeFallbackGraph(dir, "1.0.0-beta.4", "1.0.48");
      });
      const result = await installCopilotSdk({ fallbackDir: tmp, manifestDir, runInstall });
      expect(runInstall).toHaveBeenCalledOnce();
      expect(result.installed).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(manifestDir, { recursive: true, force: true });
    }
  });

  it("reinstalls when the installed SDK version differs from the pinned manifest", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-copilot-sdk-install-"));
    const manifestDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-copilot-sdk-manifest-"));
    try {
      writeFakePinnedManifest(manifestDir);
      // Stage a fallback graph whose @github/copilot-sdk version drifts.
      installFakeFallbackGraph(tmp, "1.0.0-beta.3", "1.0.48");
      fs.copyFileSync(
        path.join(manifestDir, "package-lock.json"),
        path.join(tmp, "package-lock.json"),
      );
      const runInstall = vi.fn(async ({ dir }: { dir: string }) => {
        installFakeFallbackGraph(dir, "1.0.0-beta.4", "1.0.48");
      });
      const result = await installCopilotSdk({ fallbackDir: tmp, manifestDir, runInstall });
      expect(runInstall).toHaveBeenCalledOnce();
      expect(result.installed).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(manifestDir, { recursive: true, force: true });
    }
  });

  it("reinstalls when the installed Copilot CLI version drifts from the pinned manifest", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-copilot-sdk-install-"));
    const manifestDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-copilot-sdk-manifest-"));
    try {
      writeFakePinnedManifest(manifestDir);
      // CLI version drift only; SDK matches.
      installFakeFallbackGraph(tmp, "1.0.0-beta.4", "1.0.54");
      fs.copyFileSync(
        path.join(manifestDir, "package-lock.json"),
        path.join(tmp, "package-lock.json"),
      );
      const runInstall = vi.fn(async ({ dir }: { dir: string }) => {
        installFakeFallbackGraph(dir, "1.0.0-beta.4", "1.0.48");
      });
      const result = await installCopilotSdk({ fallbackDir: tmp, manifestDir, runInstall });
      expect(runInstall).toHaveBeenCalledOnce();
      expect(result.installed).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(manifestDir, { recursive: true, force: true });
    }
  });

  it("throws when runInstall succeeds but SDK still missing", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-copilot-sdk-install-"));
    const manifestDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-copilot-sdk-manifest-"));
    writeFakePinnedManifest(manifestDir);
    try {
      const runInstall = vi.fn(async () => undefined);
      await expect(
        installCopilotSdk({ fallbackDir: tmp, manifestDir, runInstall }),
      ).rejects.toThrow(/does not match the pinned manifest/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(manifestDir, { recursive: true, force: true });
    }
  });

  it("throws a useful error when the manifest dir is missing the pinned files", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-copilot-sdk-install-"));
    const manifestDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-copilot-sdk-manifest-"));
    try {
      const runInstall = vi.fn();
      await expect(
        installCopilotSdk({ fallbackDir: tmp, manifestDir, runInstall }),
      ).rejects.toThrow(/cannot read pinned SDK manifest/);
      expect(runInstall).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(manifestDir, { recursive: true, force: true });
    }
  });
});

describe("constants", () => {
  it("exports fallback dir under ~/.openclaw/npm-runtime/copilot", () => {
    expect(COPILOT_SDK_FALLBACK_DIR).toMatch(/\.openclaw[\\/]+npm-runtime[\\/]+copilot$/);
  });

  it("resolves fallback dir from OPENCLAW_STATE_DIR when the profile is relocated", () => {
    expect(
      resolveCopilotSdkFallbackDir({
        ...process.env,
        OPENCLAW_STATE_DIR: "/tmp/openclaw-state",
      }),
    ).toBe(path.join("/tmp/openclaw-state", "npm-runtime", "copilot"));
  });

  it("pins SDK spec to @github/copilot-sdk@1.0.0-beta.4", () => {
    expect(COPILOT_SDK_SPEC).toBe("@github/copilot-sdk@1.0.0-beta.4");
  });

  it("isCopilotSdkInstalled returns false for nonexistent dirs", () => {
    expect(isCopilotSdkInstalled("/tmp/definitely-does-not-exist-openclaw")).toBe(false);
  });
});

describe("verifyCopilotSdkInstall", () => {
  it("returns ok when fallback lock and installed package.json match the pinned manifest", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-copilot-sdk-verify-"));
    const manifestDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-copilot-sdk-manifest-"));
    try {
      writeFakePinnedManifest(manifestDir);
      installFakeFallbackGraph(tmp, "1.0.0-beta.4", "1.0.48");
      fs.copyFileSync(
        path.join(manifestDir, "package-lock.json"),
        path.join(tmp, "package-lock.json"),
      );
      expect(verifyCopilotSdkInstall(tmp, manifestDir)).toEqual({ ok: true });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(manifestDir, { recursive: true, force: true });
    }
  });

  it("reports the missing fallback lock with the full path so logs are actionable", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-copilot-sdk-verify-"));
    const manifestDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-copilot-sdk-manifest-"));
    try {
      writeFakePinnedManifest(manifestDir);
      installFakeFallbackGraph(tmp, "1.0.0-beta.4", "1.0.48");
      const result = verifyCopilotSdkInstall(tmp, manifestDir);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain(path.join(tmp, "package-lock.json"));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(manifestDir, { recursive: true, force: true });
    }
  });

  it("reports drift when the installed package.json version differs from the manifest", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-copilot-sdk-verify-"));
    const manifestDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-copilot-sdk-manifest-"));
    try {
      writeFakePinnedManifest(manifestDir);
      // Lock looks correct; on-disk @github/copilot/package.json drifts.
      installFakeFallbackGraph(tmp, "1.0.0-beta.4", "1.0.48");
      fs.copyFileSync(
        path.join(manifestDir, "package-lock.json"),
        path.join(tmp, "package-lock.json"),
      );
      fs.writeFileSync(
        path.join(tmp, "node_modules", "@github", "copilot", "package.json"),
        JSON.stringify({ name: "@github/copilot", version: "1.0.54" }),
      );
      const result = verifyCopilotSdkInstall(tmp, manifestDir);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("version drift");
      expect(result.reason).toContain("1.0.54");
      expect(result.reason).toContain("1.0.48");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(manifestDir, { recursive: true, force: true });
    }
  });

  it("reports drift when the fallback lock differs outside the entry package versions", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-copilot-sdk-verify-"));
    const manifestDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-copilot-sdk-manifest-"));
    try {
      writeFakePinnedManifest(manifestDir);
      installFakeFallbackGraph(tmp, "1.0.0-beta.4", "1.0.48");
      const fallbackLockPath = path.join(tmp, "package-lock.json");
      fs.copyFileSync(path.join(manifestDir, "package-lock.json"), fallbackLockPath);
      const fallbackLock = JSON.parse(fs.readFileSync(fallbackLockPath, "utf8")) as {
        packages?: Record<string, { version?: string }>;
      };
      fallbackLock.packages = {
        ...fallbackLock.packages,
        "node_modules/drifted-transitive": { version: "9.9.9" },
      };
      fs.writeFileSync(fallbackLockPath, JSON.stringify(fallbackLock));

      const result = verifyCopilotSdkInstall(tmp, manifestDir);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("package-lock drift");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(manifestDir, { recursive: true, force: true });
    }
  });

  it("reports missing installed package dir even when the lock is present", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-copilot-sdk-verify-"));
    const manifestDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-copilot-sdk-manifest-"));
    try {
      writeFakePinnedManifest(manifestDir);
      fs.copyFileSync(
        path.join(manifestDir, "package-lock.json"),
        path.join(tmp, "package-lock.json"),
      );
      // node_modules/@github/copilot-sdk was never created.
      const result = verifyCopilotSdkInstall(tmp, manifestDir);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("missing installed package");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(manifestDir, { recursive: true, force: true });
    }
  });

  it("throws when the shipped manifest is missing a pinned version (build broke contract)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-copilot-sdk-verify-"));
    const manifestDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-copilot-sdk-manifest-"));
    try {
      // Manifest lock declares no packages at all -> fatal misconfiguration.
      fs.writeFileSync(
        path.join(manifestDir, "package-lock.json"),
        JSON.stringify({ lockfileVersion: 3, packages: {} }),
      );
      expect(() => verifyCopilotSdkInstall(tmp, manifestDir)).toThrow(
        /missing a version for node_modules\/@github\/copilot-sdk/,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(manifestDir, { recursive: true, force: true });
    }
  });

  it("throws when the shipped manifest package-lock.json cannot be read", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-copilot-sdk-verify-"));
    const manifestDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-copilot-sdk-manifest-"));
    try {
      // No package-lock.json in manifestDir -> readFileSync throws -> fatal.
      expect(() => verifyCopilotSdkInstall(tmp, manifestDir)).toThrow(
        /cannot read pinned SDK manifest/,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(manifestDir, { recursive: true, force: true });
    }
  });

  it("contract: the shipped manifest at COPILOT_SDK_INSTALL_MANIFEST_DIR pins both packages", () => {
    // Reading from the real shipped manifest dir must not throw, which means
    // the build pipeline keeps the pinned versions for both keys present.
    // The verifier returns ok=false here because the fallback dir is empty,
    // but it must not throw.
    const fs = require("node:fs") as typeof import("node:fs");
    const os = require("node:os") as typeof import("node:os");
    const path = require("node:path") as typeof import("node:path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-copilot-sdk-verify-real-"));
    try {
      const result = verifyCopilotSdkInstall(tmp, COPILOT_SDK_INSTALL_MANIFEST_DIR);
      expect(result.ok).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("copilot-sdk install manifest (contract)", () => {
  it("pins the manifest package.json to the exact spec advertised by COPILOT_SDK_SPEC", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const raw = fs.readFileSync(
      path.join(COPILOT_SDK_INSTALL_MANIFEST_DIR, "package.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
    };
    const expectedVersion = COPILOT_SDK_SPEC.split("@").pop()!;
    expect(parsed.dependencies?.["@github/copilot-sdk"]).toBe(expectedVersion);
  });

  it("ships a lockfile that includes the SDK and a Copilot CLI binary", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const raw = fs.readFileSync(
      path.join(COPILOT_SDK_INSTALL_MANIFEST_DIR, "package-lock.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as {
      lockfileVersion?: number;
      packages?: Record<string, { version?: string; integrity?: string }>;
    };
    // Reject older lockfile formats so the install graph stays npm v7+ compatible.
    expect(parsed.lockfileVersion).toBeGreaterThanOrEqual(2);
    const sdkEntry = parsed.packages?.["node_modules/@github/copilot-sdk"];
    expect(sdkEntry).toBeDefined();
    expect(sdkEntry?.version).toBe(COPILOT_SDK_SPEC.split("@").pop()!);
    expect(sdkEntry?.integrity).toMatch(/^sha512-/);
    // The Copilot CLI is what gives the runtime its native shell/write tools;
    // its presence here proves the lockfile resolves the transitive graph.
    const cliEntry = parsed.packages?.["node_modules/@github/copilot"];
    expect(cliEntry).toBeDefined();
    // Pin to the exact @github/copilot version that the repository pnpm-lock
    // also resolves (and that CI tests exercise). Drift here means users would
    // install a different Copilot CLI graph than the one reviewed/tested.
    expect(cliEntry?.version).toBe("1.0.48");
    // Every platform-specific @github/copilot-* optional dependency must
    // resolve to the same version as the parent CLI package.
    for (const [key, entry] of Object.entries(parsed.packages ?? {})) {
      if (/^node_modules\/@github\/copilot-(?:darwin|linux|linuxmusl|win32)-/.test(key)) {
        expect(entry?.version).toBe("1.0.48");
      }
    }
  });
});
