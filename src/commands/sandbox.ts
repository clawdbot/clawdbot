/**
 * Sandbox runtime management commands.
 *
 * Supports listing active sandbox containers/browsers and recreating them by
 * session, agent, or all scopes.
 */
import { confirm as clackConfirm } from "@clack/prompts";
import {
  listSandboxBrowsers,
  listSandboxContainers,
  removeSandboxBrowserContainer,
  removeSandboxContainer,
  type SandboxBrowserInfo,
  type SandboxContainerInfo,
} from "../agents/sandbox.js";
import { formatCliCommand } from "../cli/command-format.js";
import { formatErrorMessage } from "../infra/errors.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import {
  displayBrowsers,
  displayContainers,
  displayRecreatePreview,
  displayRecreateResult,
  displaySummary,
} from "./sandbox-display.js";

// --- Types ---

type SandboxListOptions = {
  browser: boolean;
  json: boolean;
};

type SandboxRecreateOptions = {
  all: boolean;
  session?: string;
  agent?: string;
  browser: boolean;
  force: boolean;
};

type ContainerItem = SandboxContainerInfo | SandboxBrowserInfo;

type FilteredContainers = {
  containers: SandboxContainerInfo[];
  browsers: SandboxBrowserInfo[];
};

/** Lists active sandbox containers or browser containers. */
export async function sandboxListCommand(
  opts: SandboxListOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const containers = opts.browser ? [] : await listSandboxContainers().catch(() => []);
  const browsers = opts.browser ? await listSandboxBrowsers().catch(() => []) : [];

  if (opts.json) {
    writeRuntimeJson(runtime, { containers, browsers });
    return;
  }

  if (opts.browser) {
    displayBrowsers(browsers, runtime);
  } else {
    displayContainers(containers, runtime);
  }

  displaySummary(containers, browsers, runtime);
}

/** Stops and removes sandbox runtimes matching the requested scope. */
export async function sandboxRecreateCommand(
  opts: SandboxRecreateOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  if (!validateRecreateOptions(opts, runtime)) {
    return;
  }

  const filtered = await fetchAndFilterContainers(opts);

  if (filtered.containers.length + filtered.browsers.length === 0) {
    runtime.log(
      `No sandbox runtimes found matching the criteria. Run ${formatCliCommand("openclaw sandbox list")} to inspect active runtimes.`,
    );
    return;
  }

  displayRecreatePreview(filtered.containers, filtered.browsers, runtime);

  if (!opts.force && !(await confirmRecreate())) {
    runtime.log("Cancelled.");
    return;
  }

  const result = await removeContainers(filtered, runtime);
  displayRecreateResult(result, runtime);

  if (result.failCount > 0) {
    runtime.exit(1);
  }
}

function validateRecreateOptions(opts: SandboxRecreateOptions, runtime: RuntimeEnv): boolean {
  if (!opts.all && !opts.session && !opts.agent) {
    runtime.error(
      `Choose the sandbox scope: --all, --session <key>, or --agent <id>. Run ${formatCliCommand("openclaw sandbox list")} to inspect active runtimes first.`,
    );
    runtime.exit(1);
    return false;
  }

  const exclusiveCount = [opts.all, opts.session, opts.agent].filter(Boolean).length;
  if (exclusiveCount > 1) {
    runtime.error("Choose only one sandbox scope: --all, --session, or --agent.");
    runtime.exit(1);
    return false;
  }

  return true;
}

async function fetchAndFilterContainers(opts: SandboxRecreateOptions): Promise<FilteredContainers> {
  const allContainers = await listSandboxContainers().catch(() => []);
  const allBrowsers = await listSandboxBrowsers().catch(() => []);

  let containers = opts.browser ? [] : allContainers;
  let browsers = opts.browser ? allBrowsers : [];

  if (opts.session) {
    containers = containers.filter((c) => c.sessionKey === opts.session);
    browsers = browsers.filter((b) => b.sessionKey === opts.session);
  } else if (opts.agent) {
    // Agent-scoped cleanup removes both the agent root session and its child
    // session keys while leaving unrelated agent containers untouched.
    const matchesAgent = createAgentMatcher(opts.agent);
    containers = containers.filter(matchesAgent);
    browsers = browsers.filter(matchesAgent);
  }

  return { containers, browsers };
}

function createAgentMatcher(agentId: string) {
  const agentPrefix = `agent:${agentId}`;
  return (item: ContainerItem) =>
    item.sessionKey === agentPrefix || item.sessionKey.startsWith(`${agentPrefix}:`);
}

async function confirmRecreate(): Promise<boolean> {
  const result = await clackConfirm({
    message: "This will stop and remove these containers. Continue?",
    initialValue: false,
  });

  return result === true;
}

async function removeContainers(
  filtered: FilteredContainers,
  runtime: RuntimeEnv,
): Promise<{ successCount: number; failCount: number }> {
  runtime.log("\nRemoving sandbox runtimes...\n");

  let successCount = 0;
  let failCount = 0;

  // Remove normal sandboxes first, then browser containers; reporting keeps one
  // aggregate fail count so callers can exit non-zero on partial cleanup.
  for (const container of filtered.containers) {
    const result = await removeContainer(container.containerName, removeSandboxContainer, runtime);
    if (result.success) {
      successCount++;
    } else {
      failCount++;
    }
  }

  for (const browser of filtered.browsers) {
    const result = await removeContainer(
      browser.containerName,
      removeSandboxBrowserContainer,
      runtime,
    );
    if (result.success) {
      successCount++;
    } else {
      failCount++;
    }
  }

  return { successCount, failCount };
}

async function removeContainer(
  containerName: string,
  removeFn: (name: string) => Promise<void>,
  runtime: RuntimeEnv,
): Promise<{ success: boolean }> {
  try {
    await removeFn(containerName);
    runtime.log(`✓ Removed ${containerName}`);
    return { success: true };
  } catch (err) {
    runtime.error(
      `Failed to remove ${containerName}: ${formatErrorMessage(err)}. Run ${formatCliCommand("openclaw sandbox list")} to inspect what remains.`,
    );
    return { success: false };
  }
}
