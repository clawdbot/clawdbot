import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectClawHubPublishablePluginPackages,
  collectClawHubVersionGateErrors,
  collectPluginClawHubReleasePathsFromGitRange,
  collectPluginClawHubReleasePlan,
  resolveChangedClawHubPublishablePluginPackages,
  resolveSelectedClawHubPublishablePluginPackages,
  type PublishablePluginPackage,
} from "../scripts/lib/plugin-clawhub-release.ts";
import {
  collectPublishablePluginPackages,
  OPENCLAW_PLUGIN_NPM_REPOSITORY_URL,
} from "../scripts/lib/plugin-npm-release.ts";
import { cleanupTempDirs, makeTempRepoRoot } from "./helpers/temp-repo.js";

const tempDirs: string[] = [];

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

describe("resolveChangedClawHubPublishablePluginPackages", () => {
  const publishablePlugins: PublishablePluginPackage[] = [
    {
      extensionId: "feishu",
      packageDir: "extensions/feishu",
      packageName: "@openclaw/feishu",
      version: "2026.4.1",
      channel: "stable",
      publishTag: "latest",
    },
    {
      extensionId: "zalo",
      packageDir: "extensions/zalo",
      packageName: "@openclaw/zalo",
      version: "2026.4.1-beta.1",
      channel: "beta",
      publishTag: "beta",
    },
  ];

  it("ignores shared release-tooling changes", () => {
    expect(
      resolveChangedClawHubPublishablePluginPackages({
        plugins: publishablePlugins,
        changedPaths: ["pnpm-lock.yaml"],
      }),
    ).toEqual([]);
  });
});

describe("collectClawHubPublishablePluginPackages", () => {
  it("requires the ClawHub external plugin contract", () => {
    const repoDir = createTempPluginRepo({
      includeClawHubContract: false,
    });

    expect(() => collectClawHubPublishablePluginPackages(repoDir)).toThrow(
      "openclaw.compat.pluginApi is required for external code plugins published to ClawHub.",
    );
  });

  it("rejects unsafe extension directory names", () => {
    const repoDir = createTempPluginRepo({
      extensionId: "Demo Plugin",
    });

    expect(() => collectClawHubPublishablePluginPackages(repoDir)).toThrow(
      "Demo Plugin: extension directory name must match",
    );
  });

  it("validates only selected package names when filters are provided", () => {
    const repoDir = createTempPluginRepo({
      extraExtensionIds: ["broken-plugin"],
    });
    writeFileSync(
      join(repoDir, "extensions", "broken-plugin", "package.json"),
      JSON.stringify(
        {
          name: "@openclaw/broken-plugin",
          version: "2026.4.1",
          openclaw: {
            extensions: ["./index.ts"],
            release: {
              publishToClawHub: true,
            },
          },
        },
        null,
        2,
      ),
    );

    expect(
      collectClawHubPublishablePluginPackages(repoDir, {
        packageNames: ["@openclaw/demo-plugin"],
      }).map((plugin) => plugin.packageName),
    ).toEqual(["@openclaw/demo-plugin"]);
  });
});

describe("OpenClaw dual-published plugin metadata", () => {
  const dualPublishedPlugins = [
    {
      extensionId: "diagnostics-otel",
      packageName: "@openclaw/diagnostics-otel",
    },
    {
      extensionId: "diagnostics-prometheus",
      packageName: "@openclaw/diagnostics-prometheus",
    },
  ] as const;

  it("keeps diagnostics plugins selectable through both ClawHub and npm release paths", () => {
    const packageNames = dualPublishedPlugins.map((plugin) => plugin.packageName);
    const clawHubPublishable = collectClawHubPublishablePluginPackages(undefined, {
      packageNames,
    });
    const npmPublishable = collectPublishablePluginPackages(undefined, {
      packageNames,
    });

    expect(clawHubPublishable.map((plugin) => plugin.packageName)).toEqual(packageNames);
    expect(npmPublishable.map((plugin) => plugin.packageName)).toEqual(packageNames);

    for (const plugin of dualPublishedPlugins) {
      const packageJson = JSON.parse(
        readFileSync(`extensions/${plugin.extensionId}/package.json`, "utf8"),
      ) as {
        openclaw?: {
          install?: {
            clawhubSpec?: string;
            defaultChoice?: string;
            npmSpec?: string;
          };
          release?: {
            publishToClawHub?: boolean;
            publishToNpm?: boolean;
          };
        };
      };

      expect(packageJson.openclaw?.install).toMatchObject({
        clawhubSpec: `clawhub:${plugin.packageName}`,
        defaultChoice: "npm",
        npmSpec: plugin.packageName,
      });
      expect(packageJson.openclaw?.release).toMatchObject({
        publishToClawHub: true,
        publishToNpm: true,
      });
    }
  });
});

describe("collectClawHubVersionGateErrors", () => {
  it("requires a version bump when a publishable plugin changes", () => {
    const repoDir = createTempPluginRepo();
    const baseRef = git(repoDir, ["rev-parse", "HEAD"]);

    writeFileSync(
      join(repoDir, "extensions", "demo-plugin", "index.ts"),
      "export const demo = 2;\n",
    );
    git(repoDir, ["add", "."]);
    git(repoDir, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "change plugin",
    ]);
    const headRef = git(repoDir, ["rev-parse", "HEAD"]);

    const errors = collectClawHubVersionGateErrors({
      rootDir: repoDir,
      plugins: collectClawHubPublishablePluginPackages(repoDir),
      gitRange: { baseRef, headRef },
    });

    expect(errors).toEqual([
      "@openclaw/demo-plugin@2026.4.1: changed publishable plugin still has the same version in package.json.",
    ]);
  });

  it("does not require a version bump for the first ClawHub opt-in", () => {
    const repoDir = createTempPluginRepo({
      publishToClawHub: false,
    });
    const baseRef = git(repoDir, ["rev-parse", "HEAD"]);

    writeFileSync(
      join(repoDir, "extensions", "demo-plugin", "package.json"),
      JSON.stringify(
        {
          name: "@openclaw/demo-plugin",
          version: "2026.4.1",
          repository: {
            type: "git",
            url: OPENCLAW_PLUGIN_NPM_REPOSITORY_URL,
          },
          openclaw: {
            extensions: ["./index.ts"],
            compat: {
              pluginApi: ">=2026.4.1",
            },
            install: {
              npmSpec: "@openclaw/demo-plugin",
            },
            build: {
              openclawVersion: "2026.4.1",
            },
            release: {
              publishToClawHub: true,
            },
          },
        },
        null,
        2,
      ),
    );
    git(repoDir, ["add", "."]);
    git(repoDir, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "opt in",
    ]);
    const headRef = git(repoDir, ["rev-parse", "HEAD"]);

    const errors = collectClawHubVersionGateErrors({
      rootDir: repoDir,
      plugins: collectClawHubPublishablePluginPackages(repoDir),
      gitRange: { baseRef, headRef },
    });

    expect(errors).toEqual([]);
  });

  it("does not require a version bump for shared release-tooling changes", () => {
    const repoDir = createTempPluginRepo();
    const { baseRef, headRef } = commitSharedReleaseToolingChange(repoDir);

    const errors = collectClawHubVersionGateErrors({
      rootDir: repoDir,
      plugins: collectClawHubPublishablePluginPackages(repoDir),
      gitRange: { baseRef, headRef },
    });

    expect(errors).toEqual([]);
  });
});

describe("resolveSelectedClawHubPublishablePluginPackages", () => {
  it("selects all publishable plugins when shared release tooling changes", () => {
    const repoDir = createTempPluginRepo({
      extraExtensionIds: ["demo-two"],
    });
    const { baseRef, headRef } = commitSharedReleaseToolingChange(repoDir);

    const selected = resolveSelectedClawHubPublishablePluginPackages({
      rootDir: repoDir,
      plugins: collectClawHubPublishablePluginPackages(repoDir),
      gitRange: { baseRef, headRef },
    });

    expect(selected.map((plugin) => plugin.extensionId)).toEqual(["demo-plugin", "demo-two"]);
  });

  it("selects all publishable plugins when the shared setup action changes", () => {
    const repoDir = createTempPluginRepo({
      extraExtensionIds: ["demo-two"],
    });
    const baseRef = git(repoDir, ["rev-parse", "HEAD"]);

    mkdirSync(join(repoDir, ".github", "actions", "setup-node-env"), { recursive: true });
    writeFileSync(
      join(repoDir, ".github", "actions", "setup-node-env", "action.yml"),
      "name: setup-node-env\n",
    );
    git(repoDir, ["add", "."]);
    git(repoDir, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "shared helpers",
    ]);
    const headRef = git(repoDir, ["rev-parse", "HEAD"]);

    const selected = resolveSelectedClawHubPublishablePluginPackages({
      rootDir: repoDir,
      plugins: collectClawHubPublishablePluginPackages(repoDir),
      gitRange: { baseRef, headRef },
    });

    expect(selected.map((plugin) => plugin.extensionId)).toEqual(["demo-plugin", "demo-two"]);
  });
});

describe("collectPluginClawHubReleasePlan", () => {
  it("skips versions that already exist on ClawHub", async () => {
    const repoDir = createTempPluginRepo();

    const plan = await collectPluginClawHubReleasePlan({
      rootDir: repoDir,
      selection: ["@openclaw/demo-plugin"],
      fetchImpl: async () => new Response("{}", { status: 200 }),
      registryBaseUrl: "https://clawhub.ai",
    });

    expect(plan.candidates).toEqual([]);
    expect(plan.skippedPublished).toHaveLength(1);
    expect(plan.skippedPublished[0]).toMatchObject({
      packageName: "@openclaw/demo-plugin",
      version: "2026.4.1",
    });
  });

  it("plans selected packages without validating unrelated publishable packages", async () => {
    const repoDir = createTempPluginRepo({
      extraExtensionIds: ["broken-plugin"],
    });
    writeFileSync(
      join(repoDir, "extensions", "broken-plugin", "package.json"),
      JSON.stringify(
        {
          name: "@openclaw/broken-plugin",
          version: "2026.4.1",
          openclaw: {
            extensions: ["./index.ts"],
            release: {
              publishToClawHub: true,
            },
          },
        },
        null,
        2,
      ),
    );

    const plan = await collectPluginClawHubReleasePlan({
      rootDir: repoDir,
      selection: ["@openclaw/demo-plugin"],
      fetchImpl: async () => new Response("{}", { status: 404 }),
      registryBaseUrl: "https://clawhub.ai",
    });

    expect(plan.candidates.map((plugin) => plugin.packageName)).toEqual(["@openclaw/demo-plugin"]);
  });
});

describe("plugin-clawhub-publish.sh", () => {
  it("previews the publish command through the ClawHub CLI dry-run preflight", () => {
    const repoDir = createTempPluginRepo();
    const binDir = join(repoDir, "bin");
    const markerPath = join(repoDir, "clawhub-invoked");
    mkdirSync(binDir, { recursive: true });
    const clawhubPath = join(binDir, "clawhub");
    writeFileSync(
      clawhubPath,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > ${JSON.stringify(markerPath)}\nexit 0\n`,
    );
    chmodSync(clawhubPath, 0o755);

    const output = execFileSync(
      "bash",
      [
        join(process.cwd(), "scripts/plugin-clawhub-publish.sh"),
        "--dry-run",
        "extensions/demo-plugin",
      ],
      {
        cwd: repoDir,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
        },
      },
    );

    expect(output).toContain("Publish command: CLAWHUB_WORKDIR=");
    expect(readFileSync(markerPath, "utf8")).toContain("--dry-run");
  });
});

describe("collectPluginClawHubReleasePathsFromGitRange", () => {
  it("rejects unsafe git refs", () => {
    const repoDir = createTempPluginRepo();
    const headRef = git(repoDir, ["rev-parse", "HEAD"]);

    expect(() =>
      collectPluginClawHubReleasePathsFromGitRange({
        rootDir: repoDir,
        gitRange: {
          baseRef: "--not-a-ref",
          headRef,
        },
      }),
    ).toThrow("baseRef must be a normal git ref or commit SHA.");
  });
});

function createTempPluginRepo(
  options: {
    extensionId?: string;
    extraExtensionIds?: string[];
    publishToClawHub?: boolean;
    includeClawHubContract?: boolean;
  } = {},
) {
  const repoDir = makeTempRepoRoot(tempDirs, "openclaw-clawhub-release-");
  const extensionId = options.extensionId ?? "demo-plugin";
  const extensionIds = [extensionId, ...(options.extraExtensionIds ?? [])];

  writeFileSync(
    join(repoDir, "package.json"),
    JSON.stringify({ name: "openclaw-test-root" }, null, 2),
  );
  writeFileSync(join(repoDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  for (const currentExtensionId of extensionIds) {
    mkdirSync(join(repoDir, "extensions", currentExtensionId), { recursive: true });
    writeFileSync(
      join(repoDir, "extensions", currentExtensionId, "package.json"),
      JSON.stringify(
        {
          name: `@openclaw/${currentExtensionId}`,
          version: "2026.4.1",
          repository: {
            type: "git",
            url: OPENCLAW_PLUGIN_NPM_REPOSITORY_URL,
          },
          openclaw: {
            extensions: ["./index.ts"],
            ...(options.includeClawHubContract === false
              ? {}
              : {
                  compat: {
                    pluginApi: ">=2026.4.1",
                  },
                  build: {
                    openclawVersion: "2026.4.1",
                  },
                }),
            install: {
              npmSpec: `@openclaw/${currentExtensionId}`,
            },
            release: {
              publishToClawHub: options.publishToClawHub ?? true,
            },
          },
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(repoDir, "extensions", currentExtensionId, "index.ts"),
      `export const ${currentExtensionId.replaceAll(/[-.]/g, "_")} = 1;\n`,
    );
  }

  git(repoDir, ["init", "-b", "main"]);
  git(repoDir, ["add", "."]);
  git(repoDir, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    "init",
  ]);

  return repoDir;
}

function commitSharedReleaseToolingChange(repoDir: string) {
  const baseRef = git(repoDir, ["rev-parse", "HEAD"]);

  mkdirSync(join(repoDir, "scripts"), { recursive: true });
  writeFileSync(join(repoDir, "scripts", "plugin-clawhub-publish.sh"), "#!/usr/bin/env bash\n");
  git(repoDir, ["add", "."]);
  git(repoDir, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    "shared tooling",
  ]);
  const headRef = git(repoDir, ["rev-parse", "HEAD"]);

  return { baseRef, headRef };
}

function git(cwd: string, args: string[]) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
