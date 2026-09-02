import fs from "node:fs/promises";
import path from "node:path";
import { writePackageDistInventory } from "../../scripts/lib/package-dist-inventory.ts";
import type { CommandRunner, ResolvedGlobalInstallTarget } from "./update-global.js";

export async function writePackageRoot(packageRoot: string, version: string): Promise<void> {
  await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
  await Promise.all([
    fs.writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version }),
      "utf8",
    ),
    fs.writeFile(path.join(packageRoot, "dist", "index.js"), "export {};\n", "utf8"),
  ]);
  await writePackageDistInventory(packageRoot);
}

export function createNpmTarget(globalRoot: string): ResolvedGlobalInstallTarget {
  return {
    manager: "npm",
    command: "npm",
    globalRoot,
    packageRoot: path.join(globalRoot, "openclaw"),
    npmOwner: {
      version: "12.0.0",
      lifecyclePolicy: "allow-scripts",
    },
  };
}

export function createRootRunner(globalRoot: string): CommandRunner {
  return async (argv) => {
    if (argv.join(" ") === "npm --version") {
      return { stdout: "12.0.0\n", stderr: "", code: 0 };
    }
    if (argv.join(" ") === "npm root -g") {
      return { stdout: `${globalRoot}\n`, stderr: "", code: 0 };
    }
    throw new Error(`unexpected command: ${argv.join(" ")}`);
  };
}
