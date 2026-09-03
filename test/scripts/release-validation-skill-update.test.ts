import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { digestClawHubSkillTree } from "../../src/skills/lifecycle/skill-tree-digest.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const execFileAsync = promisify(execFile);
const checkerSource = path.resolve(
  process.env.OPENCLAW_TEST_RELEASE_VALIDATION_CHECKER ??
    ".agents/skills/openclaw-release-validation/scripts/check-update.mjs",
);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function runChecker(
  scriptPath: string,
  workspace: string,
  envOverrides: NodeJS.ProcessEnv = { OPENCLAW_STATE_DIR: workspace },
) {
  const preloadPath = path.join(path.dirname(workspace), "mock-fetch.mjs");
  await writeFile(
    preloadPath,
    `globalThis.fetch = async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.searchParams.get("ownerHandle") !== "openclaw") {
        throw new Error("missing owner-qualified ClawHub detail lookup");
      }
      return new Response(JSON.stringify({
        latestVersion: { version: "0.1.7" },
        owner: { handle: "openclaw" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };\n`,
  );
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", pathToFileURL(preloadPath).href, scriptPath],
    {
      env: { ...process.env, ...envOverrides },
      maxBuffer: 1024 * 1024,
    },
  );
  return JSON.parse(stdout) as {
    localModifications: boolean;
    status: string;
    update?: { command: string[] };
  };
}

test.each([".clawhub", ".clawdhub"])(
  "%s metadata: updates require a core-valid link and preserve the global target",
  async (metadataDirectory) => {
    const fixture = tempDirs.make("release-validation-update-check-");
    const workspace = path.join(fixture, "workspace");
    const skillDirectory = path.join(workspace, "skills", "release-validation");
    const scriptDirectory = path.join(skillDirectory, "scripts");
    await mkdir(path.join(skillDirectory, "assets"), { recursive: true });
    await mkdir(scriptDirectory);
    await writeFile(path.join(skillDirectory, "SKILL.md"), "# Release validation\n");
    await writeFile(path.join(skillDirectory, "assets", "worksheet.md"), "original\n");
    if (path.sep === "/") {
      await writeFile(path.join(skillDirectory, "literal\\name.txt"), "portable path\n");
    }
    const scriptPath = path.join(scriptDirectory, "check-update.mjs");
    await writeFile(scriptPath, await readFile(checkerSource));

    const fileTreeSha256 = await digestClawHubSkillTree(skillDirectory);
    const skillFile = {
      path: "SKILL.md",
      sha256: createHash("sha256").update("# Release validation\n").digest("hex"),
    };
    await mkdir(path.join(skillDirectory, metadataDirectory));
    const originPath = path.join(skillDirectory, metadataDirectory, "origin.json");
    const origin = {
      version: 1,
      registry: "https://clawhub.ai",
      slug: "release-validation",
      ownerHandle: "openclaw",
      installedVersion: "0.1.6",
      installedAt: 1,
      skillFile,
      fileTreeSha256,
    };
    await writeFile(originPath, JSON.stringify(origin));
    await mkdir(path.join(workspace, metadataDirectory));
    const lockPath = path.join(workspace, metadataDirectory, "lock.json");
    const lockEntry = {
      version: "0.1.6",
      installedAt: 1,
      ownerHandle: "openclaw",
      skillFile,
      fileTreeSha256,
    };
    await writeFile(
      lockPath,
      JSON.stringify({
        version: 1,
        skills: {
          "release-validation": lockEntry,
        },
      }),
    );

    const clean = await runChecker(scriptPath, workspace);
    expect(clean).toMatchObject({
      localModifications: false,
      status: "update-available",
      update: {
        command: ["openclaw", "skills", "update", "@openclaw/release-validation", "--global"],
      },
    });

    const stateLink = path.join(fixture, "state-link");
    await symlink(workspace, stateLink, process.platform === "win32" ? "junction" : "dir");
    const throughStateLink = await runChecker(scriptPath, workspace, {
      OPENCLAW_STATE_DIR: stateLink,
    });
    expect(throughStateLink.update?.command).toContain("--global");

    const throughConfigPath = await runChecker(scriptPath, workspace, {
      OPENCLAW_STATE_DIR: "",
      OPENCLAW_CONFIG_PATH: path.join(workspace, "custom-openclaw.json"),
    });
    expect(throughConfigPath.update?.command).toContain("--global");

    const throughTildeState = await runChecker(scriptPath, workspace, {
      OPENCLAW_HOME: fixture,
      OPENCLAW_STATE_DIR: "~/workspace",
    });
    expect(throughTildeState.update?.command).toContain("--global");

    await writeFile(path.join(skillDirectory, "assets", "worksheet.md"), "locally edited\n");
    const modified = await runChecker(scriptPath, workspace);
    expect(modified).toMatchObject({
      localModifications: true,
      status: "update-available",
      update: {
        command: [
          "openclaw",
          "skills",
          "update",
          "@openclaw/release-validation",
          "--global",
          "--force",
        ],
      },
    });

    await writeFile(
      originPath,
      JSON.stringify({
        ...origin,
        registry: " https://clawhub.ai/ ",
        ownerHandle: " OpenClaw ",
      }),
    );
    const normalized = await runChecker(scriptPath, workspace);
    expect(normalized.status).toBe("update-available");
    expect(normalized.update).toBeDefined();

    const { ownerHandle: _ownerHandle, ...ownerlessOrigin } = origin;
    await writeFile(originPath, JSON.stringify(ownerlessOrigin));
    const ownerless = await runChecker(scriptPath, workspace);
    expect(ownerless.status).toBe("different-source");
    expect(ownerless.update).toBeUndefined();

    await writeFile(originPath, JSON.stringify(origin));
    await writeFile(
      lockPath,
      JSON.stringify({
        version: 1,
        skills: { "release-validation": { ...lockEntry, ownerHandle: "other-owner" } },
      }),
    );
    const mismatched = await runChecker(scriptPath, workspace);
    expect(mismatched.status).toBe("untracked");
    expect(mismatched.update).toBeUndefined();

    const { fileTreeSha256: _tree, skillFile: _skillFile, ...legacyLockEntry } = lockEntry;
    await writeFile(
      lockPath,
      JSON.stringify({ version: 1, skills: { "release-validation": legacyLockEntry } }),
    );
    const preDigest = await runChecker(scriptPath, workspace);
    expect(preDigest.status).toBe("untracked");
    expect(preDigest.update).toBeUndefined();

    await writeFile(originPath, JSON.stringify(origin));
    await writeFile(
      lockPath,
      JSON.stringify({ version: 1, skills: { "release-validation": lockEntry } }),
    );
    const primaryOriginPath = path.join(skillDirectory, ".clawhub", "origin.json");
    await mkdir(path.dirname(primaryOriginPath), { recursive: true });
    await writeFile(primaryOriginPath, "{not json");
    const malformedOrigin = await runChecker(scriptPath, workspace);
    expect(malformedOrigin.status).toBe("check-failed");
    expect(malformedOrigin.update).toBeUndefined();

    await writeFile(primaryOriginPath, JSON.stringify(origin));
    const primaryLockPath = path.join(workspace, ".clawhub", "lock.json");
    await mkdir(path.dirname(primaryLockPath), { recursive: true });
    await writeFile(primaryLockPath, JSON.stringify({ version: 2, skills: {} }));
    const malformedLock = await runChecker(scriptPath, workspace);
    expect(malformedLock.status).toBe("check-failed");
    expect(malformedLock.update).toBeUndefined();

    await writeFile(
      primaryLockPath,
      JSON.stringify({ version: 1, skills: { "release-validation": lockEntry } }),
    );
    await writeFile(path.join(skillDirectory, "assets", "worksheet.md"), "original\n");
    const linkedWorkspace = path.join(fixture, "linked-workspace");
    await mkdir(path.join(linkedWorkspace, "skills"), { recursive: true });
    await symlink(
      skillDirectory,
      path.join(linkedWorkspace, "skills", "release-validation"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await mkdir(path.join(linkedWorkspace, ".clawhub"));
    await writeFile(
      path.join(linkedWorkspace, ".clawhub", "lock.json"),
      JSON.stringify({ version: 1, skills: { "release-validation": lockEntry } }),
    );
    const symlinkedRoot = await runChecker(
      path.join(linkedWorkspace, "skills", "release-validation", "scripts", "check-update.mjs"),
      linkedWorkspace,
    );
    expect(symlinkedRoot.status).toBe("check-failed");
    expect(symlinkedRoot.update).toBeUndefined();
  },
);
