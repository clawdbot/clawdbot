/**
 * Display utilities for sandbox CLI
 */

import type { SandboxBrowserInfo, SandboxContainerInfo } from "../agents/sandbox.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  formatAge,
  formatImageMatch,
  formatSimpleStatus,
  formatStatus,
} from "./sandbox-formatters.js";

type DisplayConfig<T> = {
  emptyMessage: string;
  title: string;
  renderItem: (item: T, runtime: RuntimeEnv) => void;
};

function displayItems<T>(items: T[], config: DisplayConfig<T>, runtime: RuntimeEnv): void {
  if (items.length === 0) {
    runtime.log(config.emptyMessage);
    return;
  }

  runtime.log(`\n${config.title}\n`);
  for (const item of items) {
    config.renderItem(item, runtime);
  }
}

export function displayContainers(containers: SandboxContainerInfo[], runtime: RuntimeEnv): void {
  displayItems(
    containers,
    {
      emptyMessage: "No sandbox containers found.",
      title: "📦 Sandbox Containers:",
      renderItem: (container, rt) => {
        rt.log(`  ${container.containerName}`);
        rt.log(`    Status:  ${formatStatus(container.running)}`);
        rt.log(`    Image:   ${container.image} ${formatImageMatch(container.imageMatch)}`);
        rt.log(`    Age:     ${formatAge(Date.now() - container.createdAtMs)}`);
        rt.log(`    Idle:    ${formatAge(Date.now() - container.lastUsedAtMs)}`);
        rt.log(`    Session: ${container.sessionKey}`);
        rt.log("");
      },
    },
    runtime,
  );
}

export function displayBrowsers(browsers: SandboxBrowserInfo[], runtime: RuntimeEnv): void {
  displayItems(
    browsers,
    {
      emptyMessage: "No sandbox browser containers found.",
      title: "🌐 Sandbox Browser Containers:",
      renderItem: (browser, rt) => {
        rt.log(`  ${browser.containerName}`);
        rt.log(`    Status:  ${formatStatus(browser.running)}`);
        rt.log(`    Image:   ${browser.image} ${formatImageMatch(browser.imageMatch)}`);
        rt.log(`    CDP:     ${browser.cdpPort}`);
        if (browser.noVncPort) {
          rt.log(`    noVNC:   ${browser.noVncPort}`);
        }
        rt.log(`    Age:     ${formatAge(Date.now() - browser.createdAtMs)}`);
        rt.log(`    Idle:    ${formatAge(Date.now() - browser.lastUsedAtMs)}`);
        rt.log(`    Session: ${browser.sessionKey}`);
        rt.log("");
      },
    },
    runtime,
  );
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
    runtime.log(`\n⚠️  ${mismatchCount} container(s) with image mismatch detected.`);
    runtime.log(
      `   Run '${formatCliCommand("moltbot sandbox recreate --all")}' to update all containers.`,
    );
  }
}

export function displayRecreatePreview(
  containers: SandboxContainerInfo[],
  browsers: SandboxBrowserInfo[],
  runtime: RuntimeEnv,
): void {
  runtime.log("\nContainers to be recreated:\n");

  if (containers.length > 0) {
    runtime.log("📦 Sandbox Containers:");
    for (const container of containers) {
      runtime.log(`  - ${container.containerName} (${formatSimpleStatus(container.running)})`);
    }
  }

  if (browsers.length > 0) {
    runtime.log("\n🌐 Browser Containers:");
    for (const browser of browsers) {
      runtime.log(`  - ${browser.containerName} (${formatSimpleStatus(browser.running)})`);
    }
  }

  const total = containers.length + browsers.length;
  runtime.log(`\nTotal: ${total} container(s)`);
}

export function displayRecreateResult(
  result: { successCount: number; failCount: number },
  runtime: RuntimeEnv,
): void {
  runtime.log(`\nDone: ${result.successCount} removed, ${result.failCount} failed`);

  if (result.successCount > 0) {
    runtime.log("\nContainers will be automatically recreated when the agent is next used.");
  }
}
