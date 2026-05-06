import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { readPackageManagerSpec, readPackageName, readPackageVersion } from "./package-json.js";

async function expectPackageMeta(params: {
  root: string;
  expectedVersion: string | null;
  expectedName: string | null;
}): Promise<void> {
  await expect(readPackageVersion(params.root)).resolves.toBe(params.expectedVersion);
  await expect(readPackageName(params.root)).resolves.toBe(params.expectedName);
}

describe("package-json helpers", () => {
  it("reads package version and trims package name", async () => {
    await withTempDir({ prefix: "openclaw-package-json-" }, async (root) => {
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({
          version: " 1.2.3 ",
          name: "  @openclaw/demo  ",
          packageManager: " pnpm@10.8.1 ",
        }),
        "utf8",
      );

      await expectPackageMeta({
        root,
        expectedVersion: "1.2.3",
        expectedName: "@openclaw/demo",
      });
      await expect(readPackageManagerSpec(root)).resolves.toBe("pnpm@10.8.1");
    });
  });

  it.each([
    {
      name: "missing package.json",
      writePackageJson: async (_root: string) => {},
      expectedVersion: null,
      expectedName: null,
    },
    {
      name: "invalid JSON",
      writePackageJson: async (root: string) => {
        await fs.writeFile(path.join(root, "package.json"), "{", "utf8");
      },
      expectedVersion: null,
      expectedName: null,
    },
    {
      name: "invalid typed fields",
      writePackageJson: async (root: string) => {
        await fs.writeFile(
          path.join(root, "package.json"),
          JSON.stringify({ version: 123, name: "   " }),
          "utf8",
        );
      },
      expectedVersion: null,
      expectedName: null,
    },
    {
      name: "blank version strings",
      writePackageJson: async (root: string) => {
        await fs.writeFile(
          path.join(root, "package.json"),
          JSON.stringify({ version: "   ", name: "@openclaw/demo" }),
          "utf8",
        );
      },
      expectedVersion: null,
      expectedName: "@openclaw/demo",
    },
  ])(
    "returns normalized nulls for $name",
    async ({ writePackageJson, expectedVersion, expectedName }) => {
      await withTempDir({ prefix: "openclaw-package-json-" }, async (root) => {
        await writePackageJson(root);
        await expectPackageMeta({
          root,
          expectedVersion,
          expectedName,
        });
      });
    },
  );
});
