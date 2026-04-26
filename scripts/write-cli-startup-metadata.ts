import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { RootHelpRenderOptions } from "../src/cli/program/root-help.js";
import type { OpenClawConfig } from "../src/config/config.js";

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    out.push(value);
  }
  return out;
}

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);
const rootDir = path.resolve(scriptDir, "..");
const distDir = path.join(rootDir, "dist");
const outputPath = path.join(distDir, "cli-startup-metadata.json");
const extensionsDir = path.join(rootDir, "extensions");
const ROOT_HELP_RENDER_TIMEOUT_MS = 120_000;
const BROWSER_HELP_RENDER_TIMEOUT_MS = 120_000;
const CORE_CHANNEL_ORDER = [
  "telegram",
  "whatsapp",
  "discord",
  "irc",
  "googlechat",
  "slack",
  "signal",
  "imessage",
] as const;

type ExtensionChannelEntry = {
  id: string;
  order: number;
  label: string;
};

type BundledChannelCatalog = {
  ids: string[];
  signature: string;
};

type RootHelpRenderContext = Pick<RootHelpRenderOptions, "config" | "env">;

function resolveRootHelpBundleIdentity(
  distDirOverride: string = distDir,
): { bundleName: string; signature: string } | null {
  const bundleName = readdirSync(distDirOverride).find(
    (entry) =>
      entry.startsWith("root-help-") &&
      !entry.startsWith("root-help-metadata-") &&
      entry.endsWith(".js"),
  );
  if (!bundleName) {
    return null;
  }
  const bundlePath = path.join(distDirOverride, bundleName);
  const raw = readFileSync(bundlePath, "utf8");
  return {
    bundleName,
    signature: createHash("sha1").update(raw).digest("hex"),
  };
}

function updateHashFromFiles(hash: ReturnType<typeof createHash>, files: string[]) {
  for (const file of files.toSorted()) {
    hash.update(`${path.relative(rootDir, file)}\0`);
    hash.update(readFileSync(file));
    hash.update("\0");
  }
}

function resolveBrowserHelpSourceSignature(): string {
  const hash = createHash("sha1");
  const browserCliDir = path.join(rootDir, "extensions/browser/src/cli");
  const browserCliFiles = readdirSync(browserCliDir)
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => path.join(browserCliDir, entry));
  updateHashFromFiles(hash, browserCliFiles);
  updateHashFromFiles(hash, [
    path.join(rootDir, "src/cli/program/help.ts"),
    path.join(rootDir, "src/cli/program/context.ts"),
    path.join(rootDir, "src/cli/banner.ts"),
  ]);
  return hash.digest("hex");
}

export function readBundledChannelCatalog(
  extensionsDirOverride: string = extensionsDir,
): BundledChannelCatalog {
  const entries: ExtensionChannelEntry[] = [];
  const signature = createHash("sha1");
  for (const dirEntry of readdirSync(extensionsDirOverride, { withFileTypes: true })) {
    if (!dirEntry.isDirectory()) {
      continue;
    }
    const packageJsonPath = path.join(extensionsDirOverride, dirEntry.name, "package.json");
    try {
      const raw = readFileSync(packageJsonPath, "utf8");
      signature.update(`${dirEntry.name}\0${raw}\0`);
      const parsed = JSON.parse(raw) as {
        openclaw?: {
          channel?: {
            id?: unknown;
            order?: unknown;
            label?: unknown;
          };
        };
      };
      const id = parsed.openclaw?.channel?.id;
      if (typeof id !== "string" || !id.trim()) {
        continue;
      }
      const orderRaw = parsed.openclaw?.channel?.order;
      const labelRaw = parsed.openclaw?.channel?.label;
      entries.push({
        id: id.trim(),
        order: typeof orderRaw === "number" ? orderRaw : 999,
        label: typeof labelRaw === "string" ? labelRaw : id.trim(),
      });
    } catch {
      // Ignore malformed or missing extension package manifests.
    }
  }
  return {
    ids: entries
      .toSorted((a, b) =>
        a.order === b.order ? a.label.localeCompare(b.label) : a.order - b.order,
      )
      .map((entry) => entry.id),
    signature: signature.digest("hex"),
  };
}

export function readBundledChannelCatalogIds(
  extensionsDirOverride: string = extensionsDir,
): string[] {
  return readBundledChannelCatalog(extensionsDirOverride).ids;
}

function createIsolatedRootHelpRenderContext(
  bundledPluginsDir: string = extensionsDir,
): RootHelpRenderContext {
  const stateDir = path.join(rootDir, ".openclaw-build-root-help");
  const workspaceDir = path.join(stateDir, "workspace");
  const homeDir = path.join(stateDir, "home");
  const env: NodeJS.ProcessEnv = {
    HOME: homeDir,
    LOGNAME: process.env.LOGNAME ?? process.env.USER ?? "openclaw-build",
    USER: process.env.USER ?? process.env.LOGNAME ?? "openclaw-build",
    PATH: process.env.PATH ?? "",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
    TERM: process.env.TERM ?? "dumb",
    NO_COLOR: "1",
    OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "",
    OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE: "1",
    OPENCLAW_DISABLE_PLUGIN_MANIFEST_CACHE: "1",
    OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS: "0",
    OPENCLAW_PLUGIN_MANIFEST_CACHE_MS: "0",
    OPENCLAW_STATE_DIR: stateDir,
  };
  const config: OpenClawConfig = {
    agents: {
      defaults: {
        workspace: workspaceDir,
      },
    },
    plugins: {
      loadPaths: [],
    },
  };
  return { config, env };
}

export async function renderBundledRootHelpText(
  _distDirOverride: string = distDir,
  renderContext: RootHelpRenderContext = createIsolatedRootHelpRenderContext(
    existsSync(path.join(_distDirOverride, "extensions"))
      ? path.join(_distDirOverride, "extensions")
      : extensionsDir,
  ),
): Promise<string> {
  const bundleIdentity = resolveRootHelpBundleIdentity(_distDirOverride);
  if (!bundleIdentity) {
    throw new Error("No root-help bundle found in dist; cannot write CLI startup metadata.");
  }
  const moduleUrl = pathToFileURL(path.join(_distDirOverride, bundleIdentity.bundleName)).href;
  const renderOptions = {
    config: renderContext.config,
    env: renderContext.env,
  } satisfies RootHelpRenderOptions;
  const inlineModule = [
    `const mod = await import(${JSON.stringify(moduleUrl)});`,
    "if (typeof mod.outputRootHelp !== 'function') {",
    `  throw new Error(${JSON.stringify(`Bundle ${bundleIdentity.bundleName} does not export outputRootHelp.`)});`,
    "}",
    `await mod.outputRootHelp(${JSON.stringify(renderOptions)});`,
    "process.exit(0);",
  ].join("\n");
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", inlineModule], {
    cwd: _distDirOverride,
    encoding: "utf8",
    env: renderContext.env,
    timeout: ROOT_HELP_RENDER_TIMEOUT_MS,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    throw new Error(
      `Failed to render bundled root help from ${bundleIdentity.bundleName}` +
        (stderr ? `: ${stderr}` : result.signal ? `: terminated by ${result.signal}` : ""),
    );
  }
  return result.stdout ?? "";
}

function renderSourceRootHelpText(
  renderContext: RootHelpRenderContext = createIsolatedRootHelpRenderContext(),
): string {
  const moduleUrl = pathToFileURL(path.join(rootDir, "src/cli/program/root-help.ts")).href;
  const renderOptions = {
    pluginSdkResolution: "src",
    config: renderContext.config,
    env: renderContext.env,
  } satisfies RootHelpRenderOptions;
  const inlineModule = [
    `const mod = await import(${JSON.stringify(moduleUrl)});`,
    "if (typeof mod.renderRootHelpText !== 'function') {",
    `  throw new Error(${JSON.stringify("Source root-help module does not export renderRootHelpText.")});`,
    "}",
    `const output = await mod.renderRootHelpText(${JSON.stringify(renderOptions)});`,
    "process.stdout.write(output);",
    "process.exit(0);",
  ].join("\n");
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", inlineModule],
    {
      cwd: rootDir,
      encoding: "utf8",
      env: renderContext.env,
      timeout: ROOT_HELP_RENDER_TIMEOUT_MS,
    },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    throw new Error(
      "Failed to render source root help" +
        (stderr ? `: ${stderr}` : result.signal ? `: terminated by ${result.signal}` : ""),
    );
  }
  return result.stdout ?? "";
}

function renderSourceBrowserHelpText(
  renderContext: RootHelpRenderContext = createIsolatedRootHelpRenderContext(),
): string {
  const browserCliUrl = pathToFileURL(
    path.join(rootDir, "extensions/browser/src/cli/browser-cli.ts"),
  ).href;
  const helpUrl = pathToFileURL(path.join(rootDir, "src/cli/program/help.ts")).href;
  const contextUrl = pathToFileURL(path.join(rootDir, "src/cli/program/context.ts")).href;
  const inlineModule = [
    `const { Command } = await import("commander");`,
    `const { registerBrowserCli } = await import(${JSON.stringify(browserCliUrl)});`,
    `const { configureProgramHelp } = await import(${JSON.stringify(helpUrl)});`,
    `const { createProgramContext } = await import(${JSON.stringify(contextUrl)});`,
    `const program = new Command();`,
    `configureProgramHelp(program, createProgramContext());`,
    `registerBrowserCli(program, ["node", "openclaw", "browser", "--help"]);`,
    `const browser = program.commands.find((cmd) => cmd.name() === "browser");`,
    `if (!browser) throw new Error("Browser command was not registered.");`,
    `browser.outputHelp();`,
    "process.exit(0);",
  ].join("\n");
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", inlineModule],
    {
      cwd: rootDir,
      encoding: "utf8",
      env: {
        ...renderContext.env,
        OPENCLAW_DISABLE_CLI_STARTUP_HELP_FAST_PATH: "1",
      },
      timeout: BROWSER_HELP_RENDER_TIMEOUT_MS,
    },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    throw new Error(
      "Failed to render source browser help" +
        (stderr ? `: ${stderr}` : result.signal ? `: terminated by ${result.signal}` : ""),
    );
  }
  return result.stdout ?? "";
}

export async function writeCliStartupMetadata(options?: {
  distDir?: string;
  outputPath?: string;
  extensionsDir?: string;
}): Promise<void> {
  const resolvedDistDir = options?.distDir ?? distDir;
  const resolvedOutputPath = options?.outputPath ?? outputPath;
  const resolvedExtensionsDir = options?.extensionsDir ?? extensionsDir;
  const channelCatalog = readBundledChannelCatalog(resolvedExtensionsDir);
  const bundleIdentity = resolveRootHelpBundleIdentity(resolvedDistDir);
  const browserHelpSourceSignature = resolveBrowserHelpSourceSignature();
  const bundledPluginsDir = path.join(resolvedDistDir, "extensions");
  const renderContext = createIsolatedRootHelpRenderContext(
    existsSync(bundledPluginsDir) ? bundledPluginsDir : resolvedExtensionsDir,
  );
  const channelOptions = dedupe([...CORE_CHANNEL_ORDER, ...channelCatalog.ids]);

  try {
    const existing = JSON.parse(readFileSync(resolvedOutputPath, "utf8")) as {
      rootHelpBundleSignature?: unknown;
      browserHelpSourceSignature?: unknown;
      channelCatalogSignature?: unknown;
      browserHelpText?: unknown;
    };
    if (
      bundleIdentity &&
      existing.rootHelpBundleSignature === bundleIdentity.signature &&
      existing.browserHelpSourceSignature === browserHelpSourceSignature &&
      existing.channelCatalogSignature === channelCatalog.signature &&
      typeof existing.browserHelpText === "string" &&
      existing.browserHelpText.length > 0
    ) {
      return;
    }
  } catch {
    // Missing or malformed existing metadata means we should regenerate it.
  }

  let rootHelpText: string;
  try {
    rootHelpText = await renderBundledRootHelpText(resolvedDistDir, renderContext);
  } catch {
    rootHelpText = renderSourceRootHelpText(renderContext);
  }
  const browserHelpText = renderSourceBrowserHelpText(renderContext);

  mkdirSync(resolvedDistDir, { recursive: true });
  writeFileSync(
    resolvedOutputPath,
    `${JSON.stringify(
      {
        generatedBy: "scripts/write-cli-startup-metadata.ts",
        channelOptions,
        channelCatalogSignature: channelCatalog.signature,
        rootHelpBundleSignature: bundleIdentity?.signature ?? null,
        browserHelpSourceSignature,
        browserHelpText,
        rootHelpText,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  await writeCliStartupMetadata();
  process.exit(0);
}
