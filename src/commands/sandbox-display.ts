/**
 * Display utilities for sandbox CLI
 */

import type { SandboxBrowserInfo, SandboxContainerInfo } from "../agents/sandbox.js";
import { formatCliCommand } from "../cli/command-format.js";
import { formatDurationCompact } from "../infra/format-time/format-duration.ts";
import type { RuntimeEnv } from "../runtime.js";

export function displayContainers(containers: SandboxContainerInfo[], runtime: RuntimeEnv): void {
  if (containers.length === 0) {
    runtime.log("No sandbox runtimes found.");
    return;
  }

  runtime.log("\n📦 Sandbox Runtimes:\n");
  for (const container of containers) {
    runtime.log(`  ${container.runtimeLabel ?? container.containerName}`);
    runtime.log(`    Status:  ${container.running ? "🟢 running" : "⚫ stopped"}`);
    runtime.log(
      `    ${container.configLabelKind ?? "Image"}:   ${container.image} ${container.imageMatch ? "✓" : "⚠️  mismatch"}`,
    );
    runtime.log(`    Backend: ${container.backendId ?? "docker"}`);
    runtime.log(
      `    Age:     ${formatDurationCompact(Date.now() - container.createdAtMs, { spaced: true }) ?? "0s"}`,
    );
    runtime.log(
      `    Idle:    ${formatDurationCompact(Date.now() - container.lastUsedAtMs, { spaced: true }) ?? "0s"}`,
    );
    runtime.log(`    Session: ${container.sessionKey}`);
    runtime.log("");
  }
}

export function displayBrowsers(browsers: SandboxBrowserInfo[], runtime: RuntimeEnv): void {
  if (browsers.length === 0) {
    runtime.log("No sandbox browser containers found.");
    return;
  }

  runtime.log("\n🌐 Sandbox Browser Containers:\n");
  for (const browser of browsers) {
    runtime.log(`  ${browser.containerName}`);
    runtime.log(`    Status:  ${browser.running ? "🟢 running" : "⚫ stopped"}`);
    runtime.log(`    Image:   ${browser.image} ${browser.imageMatch ? "✓" : "⚠️  mismatch"}`);
    runtime.log(`    CDP:     ${browser.cdpPort}`);
    if (browser.noVncPort) {
      runtime.log(`    noVNC:   ${browser.noVncPort}`);
    }
    runtime.log(
      `    Age:     ${formatDurationCompact(Date.now() - browser.createdAtMs, { spaced: true }) ?? "0s"}`,
    );
    runtime.log(
      `    Idle:    ${formatDurationCompact(Date.now() - browser.lastUsedAtMs, { spaced: true }) ?? "0s"}`,
    );
    runtime.log(`    Session: ${browser.sessionKey}`);
    runtime.log("");
  }
}

export function displaySummary(
  containers: SandboxContainerInfo[],
  browsers: SandboxBrowserInfo[],
  runtime: RuntimeEnv,
): void {
  const totalCount = containers.length + browsers.length;
  const runningCount =
    containers.filter((c) => c.running).length + browsers.filter((b) => b.running).length;
  const mismatchCount =
    containers.filter((c) => !c.imageMatch).length + browsers.filter((b) => !b.imageMatch).length;

  runtime.log(`Total: ${totalCount} (${runningCount} running)`);

  if (mismatchCount > 0) {
    runtime.log(`\n⚠️  ${mismatchCount} runtime(s) with config mismatch detected.`);
    runtime.log(
      `   Run '${formatCliCommand("openclaw sandbox recreate --all")}' to update all runtimes.`,
    );
  }
}

export function displayRecreatePreview(
  containers: SandboxContainerInfo[],
  browsers: SandboxBrowserInfo[],
  runtime: RuntimeEnv,
): void {
  runtime.log("\nSandbox runtimes to be recreated:\n");

  if (containers.length > 0) {
    runtime.log("📦 Sandbox Runtimes:");
    for (const container of containers) {
      runtime.log(
        `  - ${container.runtimeLabel ?? container.containerName} [${container.backendId ?? "docker"}] (${container.running ? "running" : "stopped"})`,
      );
    }
  }

  if (browsers.length > 0) {
    runtime.log("\n🌐 Browser Containers:");
    for (const browser of browsers) {
      runtime.log(`  - ${browser.containerName} (${browser.running ? "running" : "stopped"})`);
    }
  }

  const total = containers.length + browsers.length;
  runtime.log(`\nTotal: ${total} runtime(s)`);
}

export function displayRecreateResult(
  result: { successCount: number; failCount: number },
  runtime: RuntimeEnv,
): void {
  runtime.log(`\nDone: ${result.successCount} removed, ${result.failCount} failed`);

  if (result.successCount > 0) {
    runtime.log("\nRuntimes will be automatically recreated when the agent is next used.");
  }
}
