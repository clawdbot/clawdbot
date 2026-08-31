import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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

async function runChecker(scriptPath: string, workspace: string) {
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
      env: { ...process.env, OPENCLAW_STATE_DIR: workspace },
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
  "%s metadata: an auxiliary-file edit selects the forced update path",
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
    await mkdir(path.join(skillDirectory, metadataDirectory));
    const originPath = path.join(skillDirectory, metadataDirectory, "origin.json");
    const origin = {
      version: 1,
      registry: "https://clawhub.ai",
      slug: "release-validation",
      ownerHandle: "openclaw",
      installedVersion: "0.1.6",
      installedAt: 1,
      fileTreeSha256,
    };
    await writeFile(originPath, JSON.stringify(origin));
    await mkdir(path.join(workspace, metadataDirectory));
    await writeFile(
      path.join(workspace, metadataDirectory, "lock.json"),
      JSON.stringify({
        version: 1,
        skills: {
          "release-validation": {
            version: "0.1.6",
            installedAt: 1,
            fileTreeSha256,
          },
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
  },
);
