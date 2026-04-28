import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const COMPAT_CONFIG_API_FILES = new Set([
  "src/config/config.ts",
  "src/config/io.ts",
  "src/config/mutate.ts",
  "src/memory-host-sdk/runtime-core.ts",
  "src/plugin-sdk/config-runtime.ts",
  "src/plugin-sdk/memory-core-host-runtime-core.ts",
  "src/plugins/compat/registry.ts",
  "src/plugins/contracts/config-boundary-guard.test.ts",
  "src/plugins/contracts/deprecated-internal-config-api.test.ts",
  "src/plugins/runtime/runtime-config.test.ts",
  "src/plugins/runtime/runtime-config.ts",
  "src/plugins/runtime/types-core.ts",
]);

const AMBIENT_RUNTIME_LOAD_CONFIG_COMPAT_FILES = new Set([
  "src/plugins/runtime/load-context.ts",
  "src/plugins/runtime/runtime-config.ts",
  "src/plugins/runtime/runtime-plugin-boundary.ts",
]);

const PROCESS_BOUNDARY_DIRECT_CONFIG_LOAD_FILES = new Set([
  "src/cli/banner-config-lite.ts",
  "src/cli/daemon-cli/status.gather.ts",
]);

const BROAD_CONFIG_RUNTIME_COMPAT_FILES = new Set([
  "scripts/check-no-monolithic-plugin-sdk-entry-imports.ts",
  "src/plugins/bundled-capability-runtime.test.ts",
  "src/plugins/contracts/config-boundary-guard.test.ts",
]);

function collectTypeScriptFiles(dir) {
  if (!existsSync(dir)) {
    return [];
  }
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "dist" || entry.name === "node_modules") {
        continue;
      }
      files.push(...collectTypeScriptFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

function repoRelative(repoRoot, filePath) {
  return relative(repoRoot, filePath).split(sep).join("/");
}

function isProductionExtensionFile(relPath) {
  if (
    relPath.includes("/test-support/") ||
    relPath.includes(".test.") ||
    relPath.includes(".live.test.") ||
    relPath.includes(".test-d.") ||
    relPath.includes(".test-harness.") ||
    relPath.includes(".test-shared.") ||
    relPath.endsWith(".test-support.ts") ||
    relPath.endsWith("-test-helpers.ts") ||
    relPath.endsWith("-test-support.ts")
  ) {
    return false;
  }
  return true;
}

function isTestOrHarnessFile(relPath) {
  return (
    relPath.includes("test-support") ||
    relPath.includes("/test-support/") ||
    relPath.includes("/test-helpers/") ||
    relPath.includes(".test.") ||
    relPath.includes(".live.test.") ||
    relPath.includes(".test-d.") ||
    relPath.includes(".test-harness.") ||
    relPath.includes(".test-shared.") ||
    relPath.endsWith(".test-helpers.ts") ||
    relPath.endsWith(".test-support.ts") ||
    relPath.endsWith("-test-helpers.ts") ||
    relPath.endsWith("-test-support.ts")
  );
}

function isCompatConfigApiFile(relPath) {
  return COMPAT_CONFIG_API_FILES.has(relPath);
}

function isAmbientRuntimeConfigCompatFile(relPath) {
  return AMBIENT_RUNTIME_LOAD_CONFIG_COMPAT_FILES.has(relPath);
}

function findLineNumbers(source, pattern) {
  const lines = source.split(/\r?\n/);
  return lines.flatMap((line, index) => (pattern.test(line) ? [index + 1] : []));
}

function findMatchLineNumbers(source, pattern) {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const regex = new RegExp(pattern.source, flags);
  const lines = [];
  for (let match = regex.exec(source); match; match = regex.exec(source)) {
    lines.push(source.slice(0, match.index).split(/\r?\n/).length);
  }
  return lines;
}

function findNonCommentLineNumbers(source, pattern) {
  return source.split(/\r?\n/).flatMap((line, index) => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) {
      return [];
    }
    return pattern.test(line) ? [index + 1] : [];
  });
}

function repoCodeRoots(repoRoot) {
  return ["src", "extensions", "packages", "test", "scripts"].map((entry) =>
    resolve(repoRoot, entry),
  );
}

function pushDeprecatedRuntimeApiViolations(violations, files) {
  const guards = [
    {
      pattern:
        /(?:api\.runtime\.config|core\.config|runtime\.config|get[A-Za-z0-9]+Runtime\(\)\.config|rt\.config|configApi)\??\.loadConfig\b/,
      replacement: "use runtime.config.current() or pass the already loaded config",
    },
    {
      pattern:
        /(?:api\.runtime\.config|core\.config|runtime\.config|get[A-Za-z0-9]+Runtime\(\)\.config|rt\.config|configApi)\??\.writeConfigFile\b/,
      replacement:
        "use runtime.config.mutateConfigFile(...) or replaceConfigFile(...) with afterWrite",
    },
  ];

  for (const { filePath, relPath } of files) {
    const source = readFileSync(filePath, "utf8");
    for (const guard of guards) {
      for (const line of findMatchLineNumbers(source, guard.pattern)) {
        violations.push(`${relPath}:${line} ${guard.replacement}`);
      }
    }
  }
}

function pushBroadConfigRuntimeBarrelViolations(violations, files) {
  const staticImportPattern =
    /\b(?:import|export)\s+(?:type\s+)?\{[\s\S]*?\}\s+from\s+["']openclaw\/plugin-sdk\/config-runtime["']/g;
  const dynamicImportPattern =
    /\b(?:const|let|var)\s+\{[\s\S]*?\}\s*=\s*(?:await\s+)?import\(["']openclaw\/plugin-sdk\/config-runtime["']\)/g;
  const typeQueryPattern =
    /\b(?:typeof\s+)?import\(["']openclaw\/plugin-sdk\/config-runtime["']\)\.[A-Za-z_$][\w$]*/g;

  for (const { filePath, relPath } of files) {
    const source = readFileSync(filePath, "utf8");
    for (const pattern of [staticImportPattern, dynamicImportPattern, typeQueryPattern]) {
      for (const line of findMatchLineNumbers(source, pattern)) {
        violations.push(
          `${relPath}:${line} use narrow plugin-sdk config subpaths instead of openclaw/plugin-sdk/config-runtime`,
        );
      }
    }
  }
}

function pushBroadConfigRuntimeSpecifierViolations(violations, files) {
  const moduleSpecifierPattern = /["']openclaw\/plugin-sdk\/config-runtime["']/g;

  for (const { filePath, relPath } of files) {
    const source = readFileSync(filePath, "utf8");
    for (const line of findMatchLineNumbers(source, moduleSpecifierPattern)) {
      violations.push(
        `${relPath}:${line} use narrow plugin-sdk config subpaths instead of openclaw/plugin-sdk/config-runtime`,
      );
    }
  }
}

export function collectDeprecatedInternalConfigApiViolations({
  repoRoot = DEFAULT_REPO_ROOT,
} = {}) {
  const srcRoot = resolve(repoRoot, "src");
  const extensionsRoot = resolve(repoRoot, "extensions");
  const gatewayServerMethodsRoot = resolve(srcRoot, "gateway/server-methods");
  const ambientRuntimeConfigRoots = [
    "src/gateway",
    "src/auto-reply",
    "src/agents",
    "src/infra",
    "src/mcp",
    "src/plugins/runtime",
    "src/config/sessions",
  ].map((entry) => resolve(repoRoot, entry));

  const violations = [];

  const productionExtensionFiles = collectTypeScriptFiles(extensionsRoot)
    .map((filePath) => ({ filePath, relPath: repoRelative(repoRoot, filePath) }))
    .filter(({ relPath }) => isProductionExtensionFile(relPath));
  pushDeprecatedRuntimeApiViolations(violations, productionExtensionFiles);
  pushBroadConfigRuntimeBarrelViolations(violations, productionExtensionFiles);

  for (const { filePath, relPath } of productionExtensionFiles) {
    const source = readFileSync(filePath, "utf8");
    const guards = [
      {
        pattern:
          /\b(?:import|export)\s+(?:type\s+)?\{[^}]*\bloadConfig\b[^}]*\}\s+from\s+["']openclaw\/plugin-sdk\/(?:config-runtime|memory-core-host-runtime-core)["']/,
        replacement:
          "use getRuntimeConfig(), runtime.config.current(), or pass the already loaded config",
      },
      {
        pattern: /(?<!\.)\bloadConfig\s*\(/,
        replacement: "use getRuntimeConfig(), runtime.config.current(), or passed config",
      },
      {
        pattern: /\bcreateConfigIO\b|\.\s*loadConfig\s*\(/,
        replacement: "use runtime.config.current(), getRuntimeConfig(), or passed config",
      },
      {
        pattern: /\bwriteConfigFile\s*\(/,
        replacement: "use mutateConfigFile(...) or replaceConfigFile(...) with afterWrite",
      },
    ];
    for (const guard of guards) {
      for (const line of findLineNumbers(source, guard.pattern)) {
        violations.push(`${relPath}:${line} ${guard.replacement}`);
      }
    }
  }

  const repoFiles = repoCodeRoots(repoRoot)
    .flatMap(collectTypeScriptFiles)
    .map((filePath) => ({ filePath, relPath: repoRelative(repoRoot, filePath) }));

  pushDeprecatedRuntimeApiViolations(
    violations,
    repoFiles.filter(({ relPath }) => !isCompatConfigApiFile(relPath)),
  );
  pushBroadConfigRuntimeBarrelViolations(
    violations,
    repoFiles.filter(
      ({ relPath }) =>
        !isTestOrHarnessFile(relPath) &&
        !isCompatConfigApiFile(relPath) &&
        !relPath.startsWith("test/"),
    ),
  );
  pushBroadConfigRuntimeSpecifierViolations(
    violations,
    repoFiles.filter(
      ({ relPath }) =>
        !isCompatConfigApiFile(relPath) && !BROAD_CONFIG_RUNTIME_COMPAT_FILES.has(relPath),
    ),
  );

  for (const { filePath, relPath } of repoFiles.filter(
    ({ relPath }) => !isCompatConfigApiFile(relPath),
  )) {
    const source = readFileSync(filePath, "utf8");
    const guards = [
      {
        pattern:
          /\b(?:import|export)\s+(?:type\s+)?\{[\s\S]*?\b(?:loadConfig|writeConfigFile)\b[\s\S]*?\}\s+from\s+["']openclaw\/plugin-sdk\/(?:config-runtime|memory-core-host-runtime-core)["']/,
        replacement:
          "use getRuntimeConfig(), runtime.config.current(), or mutation helpers with afterWrite",
      },
      {
        pattern:
          /ReturnType<typeof import\(["']openclaw\/plugin-sdk\/(?:config-runtime|memory-core-host-runtime-core)["']\)\.(?:loadConfig|writeConfigFile)>/,
        replacement: "use OpenClawConfig or the explicit mutation helper type",
      },
    ];
    for (const guard of guards) {
      for (const line of findMatchLineNumbers(source, guard.pattern)) {
        violations.push(`${relPath}:${line} ${guard.replacement}`);
      }
    }
  }

  for (const { filePath, relPath } of repoFiles.filter(
    ({ relPath }) =>
      !isTestOrHarnessFile(relPath) &&
      !isCompatConfigApiFile(relPath) &&
      !relPath.startsWith("test/"),
  )) {
    const source = readFileSync(filePath, "utf8");
    const importPattern =
      /\bimport\s+\{[\s\S]*?\bwriteConfigFile\b[\s\S]*?\}\s+from\s+["'][^"']*(?:config\/config|config\/io)\.js["']/;
    const dynamicImportPattern =
      /\bconst\s+\{[\s\S]*?\bwriteConfigFile\b[\s\S]*?\}\s*=\s*await\s+import\(["'][^"']*(?:config\/config|config\/io)\.js["']\)/;
    const directMethodPattern = /\.\s*writeConfigFile\s*\(/;
    for (const pattern of [importPattern, dynamicImportPattern]) {
      for (const line of findMatchLineNumbers(source, pattern)) {
        violations.push(
          `${relPath}:${line} use replaceConfigFile(...) or mutateConfigFile(...) with afterWrite`,
        );
      }
    }
    for (const line of findNonCommentLineNumbers(source, directMethodPattern)) {
      violations.push(
        `${relPath}:${line} use replaceConfigFile(...) or mutateConfigFile(...) with afterWrite`,
      );
    }
  }

  for (const { filePath, relPath } of repoFiles.filter(
    ({ relPath }) =>
      !isTestOrHarnessFile(relPath) &&
      !isCompatConfigApiFile(relPath) &&
      !PROCESS_BOUNDARY_DIRECT_CONFIG_LOAD_FILES.has(relPath) &&
      !relPath.startsWith("test/"),
  )) {
    const source = readFileSync(filePath, "utf8");
    for (const line of findNonCommentLineNumbers(source, /(?<!\.)\bloadConfig\s*\(/)) {
      violations.push(
        `${relPath}:${line} use a passed cfg, context.getRuntimeConfig(), or getRuntimeConfig() at an explicit process boundary`,
      );
    }
    for (const line of findNonCommentLineNumbers(source, /\.\s*loadConfig\s*\(/)) {
      violations.push(
        `${relPath}:${line} use a passed cfg, context.getRuntimeConfig(), or getRuntimeConfig() at an explicit process boundary`,
      );
    }
  }

  for (const { filePath, relPath } of collectTypeScriptFiles(gatewayServerMethodsRoot)
    .map((filePath) => ({ filePath, relPath: repoRelative(repoRoot, filePath) }))
    .filter(({ relPath }) => !isTestOrHarnessFile(relPath))) {
    const source = readFileSync(filePath, "utf8");
    const importPattern =
      /\bimport\s+\{[\s\S]*?\bloadConfig\b[\s\S]*?\}\s+from\s+["'][^"']*(?:config\/config|config\/io)\.js["']/;
    for (const line of findMatchLineNumbers(source, importPattern)) {
      violations.push(
        `${relPath}:${line} use context.getRuntimeConfig() in gateway request handlers`,
      );
    }
    for (const line of findNonCommentLineNumbers(source, /(?<!\.)\bloadConfig\s*\(/)) {
      violations.push(
        `${relPath}:${line} use context.getRuntimeConfig() in gateway request handlers`,
      );
    }
  }

  for (const { filePath, relPath } of ambientRuntimeConfigRoots
    .flatMap(collectTypeScriptFiles)
    .map((filePath) => ({ filePath, relPath: repoRelative(repoRoot, filePath) }))
    .filter(
      ({ relPath }) =>
        !isTestOrHarnessFile(relPath) &&
        !isCompatConfigApiFile(relPath) &&
        !isAmbientRuntimeConfigCompatFile(relPath),
    )) {
    const source = readFileSync(filePath, "utf8");
    const loadConfigLines = findNonCommentLineNumbers(source, /(?<!\.)\bloadConfig\s*\(/);
    if (loadConfigLines.length === 0) {
      continue;
    }
    violations.push(
      `${relPath}:${loadConfigLines.join(",")} has ${loadConfigLines.length} ambient loadConfig() calls. Pass cfg through the call path, use context.getRuntimeConfig(), or use getRuntimeConfig() at a process boundary.`,
    );
  }

  return [...new Set(violations)];
}

const CHANNEL_EXTENSION_IDS = new Set([
  "discord",
  "imessage",
  "irc",
  "line",
  "matrix",
  "mattermost",
  "nextcloud-talk",
  "signal",
  "slack",
  "telegram",
  "whatsapp",
]);

const RUNTIME_HELPER_BASENAME_PATTERNS = [
  /^action-runtime\.ts$/,
  /^actions(?:\..*)?\.ts$/,
  /^active-listener\.ts$/,
  /^access-control\.ts$/,
  /^channel\.ts$/,
  /^client(?:[-.].*)?\.ts$/,
  /^recipient-resolution\.ts$/,
  /^rich-menu\.ts$/,
  /^send(?:[-.].*)?\.ts$/,
  /^sent-message-cache\.ts$/,
  /^thread-bindings\.ts$/,
];

const RUNTIME_ACTION_FORBIDDEN_CONFIG_LOAD_PATTERNS = [
  /\bloadConfig\s*\(/,
  /\.config\.loadConfig\s*\(/,
];

function isRuntimeActionLoadConfigCandidate(relPath) {
  const parts = relPath.split("/");
  if (parts[0] !== "extensions" || parts[2] !== "src") {
    return false;
  }
  if (!CHANNEL_EXTENSION_IDS.has(parts[1])) {
    return false;
  }
  if (
    relPath.endsWith(".test.ts") ||
    relPath.endsWith(".test-harness.ts") ||
    relPath.endsWith(".d.ts")
  ) {
    return false;
  }
  if (parts.includes("monitor") || parts.includes("cli")) {
    return false;
  }
  if (parts.includes("actions")) {
    return true;
  }
  const basename = parts.at(-1) ?? "";
  return RUNTIME_HELPER_BASENAME_PATTERNS.some((pattern) => pattern.test(basename));
}

export function collectRuntimeActionLoadConfigViolations({ repoRoot = DEFAULT_REPO_ROOT } = {}) {
  return collectTypeScriptFiles(resolve(repoRoot, "extensions"))
    .map((filePath) => ({ filePath, relPath: repoRelative(repoRoot, filePath) }))
    .filter(({ relPath }) => isRuntimeActionLoadConfigCandidate(relPath))
    .flatMap(({ filePath, relPath }) => {
      const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
      return lines.flatMap((line, index) =>
        RUNTIME_ACTION_FORBIDDEN_CONFIG_LOAD_PATTERNS.some((pattern) => pattern.test(line))
          ? [`${relPath}:${index + 1}: ${line.trim()}`]
          : [],
      );
    });
}
