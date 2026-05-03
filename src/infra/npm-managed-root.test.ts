import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  removeManagedNpmRootDependency,
  resolveManagedNpmRootDependencySpec,
  upsertManagedNpmRootDependency,
} from "./npm-managed-root.js";

const tempDirs: string[] = [];

async function makeTempRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-npm-managed-root-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("managed npm root", () => {
  it("keeps existing plugin dependencies when adding another managed plugin", async () => {
    const npmRoot = await makeTempRoot();
    await fs.writeFile(
      path.join(npmRoot, "package.json"),
      `${JSON.stringify(
        {
          private: true,
          dependencies: {
            "@openclaw/discord": "2026.5.2",
          },
          devDependencies: {
            fixture: "1.0.0",
          },
        },
        null,
        2,
      )}\n`,
    );

    await upsertManagedNpmRootDependency({
      npmRoot,
      packageName: "@openclaw/feishu",
      dependencySpec: "2026.5.2",
    });

    await expect(
      fs.readFile(path.join(npmRoot, "package.json"), "utf8").then((raw) => JSON.parse(raw)),
    ).resolves.toEqual({
      private: true,
      dependencies: {
        "@openclaw/discord": "2026.5.2",
        "@openclaw/feishu": "2026.5.2",
      },
      devDependencies: {
        fixture: "1.0.0",
      },
    });
  });

  it("uses the requested selector before falling back to resolved version", () => {
    expect(
      resolveManagedNpmRootDependencySpec({
        parsedSpec: {
          name: "@openclaw/discord",
          raw: "@openclaw/discord@stable",
          selector: "stable",
          selectorKind: "tag",
          selectorIsPrerelease: false,
        },
        resolution: {
          name: "@openclaw/discord",
          version: "2026.5.2",
          resolvedSpec: "@openclaw/discord@2026.5.2",
          resolvedAt: "2026-05-03T00:00:00.000Z",
        },
      }),
    ).toBe("stable");

    expect(
      resolveManagedNpmRootDependencySpec({
        parsedSpec: {
          name: "@openclaw/discord",
          raw: "@openclaw/discord",
          selectorKind: "none",
          selectorIsPrerelease: false,
        },
        resolution: {
          name: "@openclaw/discord",
          version: "2026.5.2",
          resolvedSpec: "@openclaw/discord@2026.5.2",
          resolvedAt: "2026-05-03T00:00:00.000Z",
        },
      }),
    ).toBe("2026.5.2");
  });

  it("removes one managed dependency without dropping unrelated metadata", async () => {
    const npmRoot = await makeTempRoot();
    await fs.writeFile(
      path.join(npmRoot, "package.json"),
      `${JSON.stringify(
        {
          private: true,
          dependencies: {
            "@openclaw/discord": "2026.5.2",
            "@openclaw/voice-call": "2026.5.2",
          },
          devDependencies: {
            fixture: "1.0.0",
          },
        },
        null,
        2,
      )}\n`,
    );

    await removeManagedNpmRootDependency({
      npmRoot,
      packageName: "@openclaw/voice-call",
    });

    await expect(
      fs.readFile(path.join(npmRoot, "package.json"), "utf8").then((raw) => JSON.parse(raw)),
    ).resolves.toEqual({
      private: true,
      dependencies: {
        "@openclaw/discord": "2026.5.2",
      },
      devDependencies: {
        fixture: "1.0.0",
      },
    });
  });
});
