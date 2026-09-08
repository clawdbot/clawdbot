import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const installedPackageTreePolicySource = `
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  if (request.sourcePathKind === "directory") {
    process.stdout.write(JSON.stringify({
      protocolVersion: 1,
      decision: "block",
      reason: "blocked installed package tree",
    }));
    return;
  }
  process.stdout.write(JSON.stringify({ protocolVersion: 1, decision: "allow" }));
});
`;

export async function createInstalledPackageTreePolicyExec(rootDir: string) {
  if (process.platform === "win32") {
    return { command: process.execPath, args: ["-e", installedPackageTreePolicySource] };
  }
  const command = path.join(rootDir, "install-policy.cjs");
  await fs.writeFile(command, `#!${process.execPath}\n${installedPackageTreePolicySource}`, "utf8");
  await fs.chmod(command, 0o700);
  return { command, args: [] };
}

export function configWithInstalledPackageTreeBlockPolicy(exec: {
  command: string;
  args: string[];
}): OpenClawConfig {
  return {
    security: {
      installPolicy: {
        enabled: true,
        exec: {
          source: "exec",
          command: exec.command,
          args: exec.args,
          timeoutMs: 5000,
          maxOutputBytes: 16 * 1024,
        },
      },
    },
  };
}

export async function installProjectDependencies(
  projectRoot: string,
  dependencies: Record<string, string>,
): Promise<void> {
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.writeFile(
    path.join(projectRoot, "package.json"),
    `${JSON.stringify({ private: true, dependencies }, null, 2)}\n`,
    "utf8",
  );
  await promisify(execFile)(
    "npm",
    [
      "install",
      "--omit=dev",
      "--omit=peer",
      "--legacy-peer-deps",
      "--loglevel=error",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ],
    { cwd: projectRoot },
  );
}
