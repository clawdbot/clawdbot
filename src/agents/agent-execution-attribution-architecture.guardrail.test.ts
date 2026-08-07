/** Guardrails keeping execution attribution private to host-owned runtime wiring. */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCE_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".mjs", ".mts", ".ts", ".tsx"]);
const SKIPPED_DIRECTORIES = new Set([".git", "dist", "node_modules", "vendor"]);

const ALLOWED_PRODUCTION_IMPORTERS = [
  "src/agents/agent-command-execution-identity.ts",
  "src/agents/agent-tools.before-tool-call.attribution.ts",
  "src/agents/agent-tools.ts",
  "src/agents/btw.ts",
  "src/agents/cli-runner/types.ts",
  "src/agents/command/acp-execution.ts",
  "src/agents/command/attempt-execution.ts",
  "src/agents/command/run-embedded-attempt.ts",
  "src/agents/command/types.ts",
  "src/agents/embedded-agent-runner/run/attempt-execution-attribution.ts",
  "src/agents/embedded-agent-runner/run/internal-params.ts",
  "src/agents/embedded-agent-runner/run/lane-controller.ts",
  "src/agents/harness/side-question-execution-attribution.ts",
  "src/auto-reply/reply/agent-runner-cli-candidate.ts",
  "src/auto-reply/reply/agent-runner-execution-identity.ts",
  "src/auto-reply/reply/agent-runner-execution.types.ts",
  "src/gateway/server-methods/agent-run-admission-phase.ts",
  "src/infra/agent-run-registry.ts",
] as const;

const FORBIDDEN_PUBLIC_ROOTS = [
  "apps",
  "extensions",
  "packages/gateway-protocol",
  "src/plugin-sdk",
  "ui",
] as const;

function listSourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (SKIPPED_DIRECTORIES.has(entry.name)) {
      return [];
    }
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) {
      return listSourceFiles(path);
    }
    return SOURCE_EXTENSIONS.has(extname(entry.name)) ? [path] : [];
  });
}

function repoPath(path: string): string {
  return relative(REPO_ROOT, path).replaceAll("\\", "/");
}

function isProductionSource(path: string): boolean {
  return !/\.test(?:-support)?\.[cm]?[jt]sx?$|\.spec\.[cm]?[jt]sx?$/.test(path);
}

describe("agent execution attribution architecture guardrails", () => {
  it("limits the private primitive to the reviewed host-owned wiring", () => {
    const actualImporters = listSourceFiles(resolve(REPO_ROOT, "src"))
      .filter(isProductionSource)
      .filter((path) => readFileSync(path, "utf8").includes("agent-execution-attribution.js"))
      .map(repoPath)
      .toSorted();

    expect(actualImporters).toEqual(ALLOWED_PRODUCTION_IMPORTERS.toSorted());
  });

  it("keeps the private primitive out of public SDK, protocol, plugin, app, and UI roots", () => {
    const leaks = FORBIDDEN_PUBLIC_ROOTS.flatMap((root) =>
      listSourceFiles(resolve(REPO_ROOT, root))
        .filter((path) => {
          const text = readFileSync(path, "utf8");
          return (
            text.includes("AgentExecutionAttribution") ||
            text.includes("agent-execution-attribution")
          );
        })
        .map(repoPath),
    );

    expect(leaks).toEqual([]);
  });

  it("keeps undecided identity fields out of the node protocol and public tool options", () => {
    const nodeSchema = readFileSync(
      resolve(REPO_ROOT, "packages/gateway-protocol/src/schema/nodes.ts"),
      "utf8",
    );
    for (const field of ["attribution", "passportId", "principalId", "instanceId"]) {
      expect(nodeSchema).not.toMatch(new RegExp(`\\b${field}\\s*:`));
    }

    const agentTools = readFileSync(resolve(REPO_ROOT, "src/agents/agent-tools.ts"), "utf8");
    const publicOptions = agentTools.slice(
      agentTools.indexOf("type OpenClawCodingToolsOptions ="),
      agentTools.indexOf("type OpenClawCodingToolsInternalOptions ="),
    );
    expect(publicOptions).not.toMatch(/\battribution\s*\??:/);
  });
});
