/** Linux systemd unit paths and environment-file parsing. */
import fs from "node:fs/promises";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { isUnresolvedShellReference } from "../config/state-dir-dotenv.js";
import { hasErrnoCode } from "../infra/errno.js";
import { splitArgsPreservingQuotes } from "./arg-split.js";
import { resolveGatewaySystemdServiceName } from "./constants.js";
import { normalizeWindowsPathSeparators } from "./output.js";
import { resolveDaemonHomeDir } from "./paths.js";
import type {
  GatewayServiceCommandConfig,
  GatewayServiceCommandSnapshot,
  GatewayServiceEnv,
  GatewayServiceEnvironmentValueSource,
  GatewayServiceManagedOverrides,
  GatewayServiceReadOptions,
} from "./service-types.js";
import { execBusctlUser } from "./systemd-exec.js";
import {
  parseSystemdEnvAssignments,
  parseSystemdExecStart,
  splitSystemdLogicalLines,
} from "./systemd-unit.js";

const SYSTEMD_GATEWAY_DOTENV_FILENAME = "gateway.systemd.env";
const SYSTEMD_NODE_DOTENV_FILENAME = "node.systemd.env";
const SYSTEMD_MANAGER_QUERY_TIMEOUT_MS = 5_000;

export function resolveSystemdUnitPathForName(env: GatewayServiceEnv, name: string): string {
  const home = normalizeWindowsPathSeparators(resolveDaemonHomeDir(env));
  return path.posix.join(home, ".config", "systemd", "user", `${name}.service`);
}

export function resolveSystemdServiceName(env: GatewayServiceEnv): string {
  const override = env.OPENCLAW_SYSTEMD_UNIT?.trim();
  if (override) {
    return override.endsWith(".service") ? override.slice(0, -".service".length) : override;
  }
  return resolveGatewaySystemdServiceName(env.OPENCLAW_PROFILE);
}

export function resolveSystemdUnitPath(env: GatewayServiceEnv): string {
  return resolveSystemdUnitPathForName(env, resolveSystemdServiceName(env));
}

// Unit file parsing/rendering: see systemd-unit.ts

type SystemdEnvironmentFileSpec = string | [string, boolean];

const UNKNOWN_SYSTEMD_OVERRIDES = {
  launcher: "command",
  environment: true,
} satisfies GatewayServiceManagedOverrides;

async function buildSystemdCommandSnapshot(params: {
  programArguments: string[];
  workingDirectory: string;
  inlineEnvironment: Record<string, string>;
  environmentFileSpecs: SystemdEnvironmentFileSpec[];
  unsetEnvironment: string[];
  env: GatewayServiceEnv;
  unitPath: string;
  failOnUnavailable?: boolean;
}): Promise<GatewayServiceCommandSnapshot> {
  const fileEnvironment = await resolveSystemdEnvironmentFiles(params);
  const environment = { ...params.inlineEnvironment, ...fileEnvironment };
  const environmentValueSources: Record<string, GatewayServiceEnvironmentValueSource> =
    Object.fromEntries(Object.keys(params.inlineEnvironment).map((key) => [key, "inline"]));
  for (const key of Object.keys(fileEnvironment)) {
    environmentValueSources[key] = Object.hasOwn(params.inlineEnvironment, key)
      ? "inline-and-file"
      : "file";
  }
  for (const assignment of params.unsetEnvironment) {
    const separator = assignment.indexOf("=");
    const key = separator < 0 ? assignment : assignment.slice(0, separator);
    if (separator < 0 || environment[key] === assignment.slice(separator + 1)) {
      delete environment[key];
      delete environmentValueSources[key];
    }
  }
  return {
    programArguments: params.programArguments,
    ...(params.workingDirectory ? { workingDirectory: params.workingDirectory } : {}),
    ...(Object.keys(environment).length > 0 ? { environment, environmentValueSources } : {}),
  };
}

async function readSystemdManagerCommand(
  env: GatewayServiceEnv,
  localDefinition: GatewayServiceCommandSnapshot | null,
  managedUnsetEnvironment: string[],
  opts?: GatewayServiceReadOptions,
): Promise<GatewayServiceCommandConfig | null> {
  const manager = "org.freedesktop.systemd1";
  const unitName = `${resolveSystemdServiceName(env)}.service`;
  const unavailable = () => new Error("Effective systemd service command could not be inspected.");
  const timeoutMs =
    opts?.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : SYSTEMD_MANAGER_QUERY_TIMEOUT_MS;
  const deadlineAt = Date.now() + timeoutMs;
  let remainingCalls = 3;
  // All manager D-Bus calls share one deadline so wedged reads reach local fallback promptly.
  const query = async (args: string[], signatures: string[]): Promise<unknown[] | null> => {
    const result = await execBusctlUser(
      env,
      ["--json=short", ...args],
      Math.max(1, Math.floor((deadlineAt - Date.now()) / remainingCalls--)),
    );
    if (result.code !== 0) {
      if (
        args.includes("LoadUnit") &&
        result.stderr.trim() === `Call failed: Unit ${unitName} not found.`
      ) {
        return null;
      }
      throw unavailable();
    }
    const properties = result.stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => asOptionalRecord(JSON.parse(line)));
    if (
      properties.length !== signatures.length ||
      !properties.every((property, index) => property?.type === signatures[index])
    ) {
      throw unavailable();
    }
    return properties.map((property) => property?.data);
  };
  const loaded = await query(
    ["call", manager, "/org/freedesktop/systemd1", `${manager}.Manager`, "LoadUnit", "s", unitName],
    ["o"],
  );
  if (!loaded) {
    return null;
  }
  const loadedUnit = loaded[0];
  const unitPath = Array.isArray(loadedUnit) && loadedUnit.length === 1 ? loadedUnit[0] : null;
  if (typeof unitPath !== "string" || !unitPath) {
    throw unavailable();
  }
  const readProperties = (scope: "Unit" | "Service", names: string[], signatures: string[]) =>
    query(["get-property", manager, unitPath, `${manager}.${scope}`, ...names], signatures);
  const isStringArray = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((entry) => typeof entry === "string");
  const unitProperties = await readProperties(
    "Unit",
    ["FragmentPath", "DropInPaths", "NeedDaemonReload", "LoadState"],
    ["s", "as", "b", "s"],
  );
  const [sourcePath, dropInPaths, reloadPending, loadState] = unitProperties ?? [];
  // LoadUnit also returns objects for missing units; only LoadState proves absence.
  if (loadState === "not-found") {
    return null;
  }
  if (
    loadState !== "loaded" ||
    typeof sourcePath !== "string" ||
    !sourcePath ||
    !isStringArray(dropInPaths) ||
    dropInPaths.some((pathname) => !pathname) ||
    typeof reloadPending !== "boolean"
  ) {
    throw unavailable();
  }
  const properties = await readProperties(
    "Service",
    ["ExecStart", "WorkingDirectory", "Environment", "EnvironmentFiles", "UnsetEnvironment"],
    ["a(sasbttttuii)", "s", "as", "a(sb)", "as"],
  );
  const [executions, workingDirectory, assignments, environmentFileSpecs, unsetEnvironment] =
    properties ?? [];
  const execution = Array.isArray(executions) && executions.length === 1 ? executions[0] : null;
  const programArguments = Array.isArray(execution) ? execution[1] : null;
  if (
    !Array.isArray(execution) ||
    execution.length !== 10 ||
    typeof execution[0] !== "string" ||
    execution[0].length === 0 ||
    typeof execution[2] !== "boolean" ||
    !execution.slice(3).every(Number.isInteger) ||
    !isStringArray(programArguments) ||
    programArguments.length === 0 ||
    typeof workingDirectory !== "string" ||
    !isStringArray(assignments) ||
    !Array.isArray(environmentFileSpecs) ||
    !environmentFileSpecs.every(
      (spec): spec is [string, boolean] =>
        Array.isArray(spec) &&
        spec.length === 2 &&
        typeof spec[0] === "string" &&
        spec[0].length > 0 &&
        typeof spec[1] === "boolean",
    ) ||
    !isStringArray(unsetEnvironment) ||
    unsetEnvironment.some((assignment) => !assignment || assignment.startsWith("="))
  ) {
    throw unavailable();
  }
  const inlineEnvironment: Record<string, string> = {};
  for (const assignment of assignments) {
    const separator = assignment.indexOf("=");
    if (separator <= 0) {
      throw unavailable();
    }
    inlineEnvironment[assignment.slice(0, separator)] = assignment.slice(separator + 1);
  }

  const managedDefinition = sourcePath === resolveSystemdUnitPath(env) ? localDefinition : null;
  const managedOverrides =
    !reloadPending && managedDefinition
      ? await readSystemdDropInOverrides(
          dropInPaths,
          managedUnsetEnvironment,
          env,
          sourcePath,
        ).catch(() => UNKNOWN_SYSTEMD_OVERRIDES)
      : UNKNOWN_SYSTEMD_OVERRIDES;
  return {
    ...(await buildSystemdCommandSnapshot({
      programArguments,
      workingDirectory: workingDirectory.replace(/^!/, ""),
      inlineEnvironment,
      environmentFileSpecs,
      unsetEnvironment,
      env,
      unitPath: sourcePath,
      failOnUnavailable: opts?.requireEffective,
    })),
    ...(managedDefinition && managedOverrides ? { managedDefinition, managedOverrides } : {}),
    sourcePath,
    definitionPaths: [sourcePath, ...dropInPaths],
    ...(reloadPending ? { reloadPending: true } : {}),
  };
}

async function readSystemdDropInOverrides(
  dropInPaths: string[],
  managedUnsetEnvironment: string[],
  env: GatewayServiceEnv,
  unitPath: string,
): Promise<GatewayServiceManagedOverrides | undefined> {
  const inlineEnvironmentKeys = new Set<string>();
  const fileEnvironmentKeys = new Set<string>();
  const unsetEnvironmentKeys = new Set<string>();
  const overrides: GatewayServiceManagedOverrides = {};
  let resetInline = false;
  let resetFiles = false;
  for (const pathname of dropInPaths) {
    const content = await fs.readFile(pathname, "utf8");
    let inService = false;
    // Loaded drop-ins own directives even when their current values equal the managed base.
    for (const rawLine of splitSystemdLogicalLines(content)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#") || line.startsWith(";")) {
        continue;
      }
      if (line.startsWith("[")) {
        if (!line.endsWith("]")) {
          throw new Error("Invalid systemd drop-in section");
        }
        inService = line === "[Service]";
        continue;
      }
      if (!inService) {
        continue;
      }
      const separator = line.indexOf("=");
      if (separator < 0) {
        throw new Error("Invalid systemd drop-in directive");
      }
      const directive = line.slice(0, separator).trim();
      if (directive === "ExecStart" || directive === "WorkingDirectory") {
        overrides.launcher =
          directive === "ExecStart" ? "command" : (overrides.launcher ?? "working-directory");
      } else if (["Environment", "EnvironmentFile", "UnsetEnvironment"].includes(directive)) {
        const value = line.slice(separator + 1).trim();
        if (!value) {
          if (directive === "Environment") {
            inlineEnvironmentKeys.clear();
            resetInline = true;
          } else if (directive === "EnvironmentFile") {
            fileEnvironmentKeys.clear();
            resetFiles = true;
          } else {
            unsetEnvironmentKeys.clear();
            for (const assignment of managedUnsetEnvironment) {
              unsetEnvironmentKeys.add(assignment.split("=", 1)[0] ?? assignment);
            }
          }
        } else if (directive === "Environment") {
          const assignments = parseSystemdEnvAssignments(value);
          if (assignments.length !== splitSystemdEnvironmentWords(value).length) {
            throw new Error("Invalid systemd drop-in environment");
          }
          for (const { key } of assignments) {
            inlineEnvironmentKeys.add(key);
          }
        } else if (directive === "UnsetEnvironment") {
          for (const assignment of splitSystemdEnvironmentWords(value)) {
            const key = assignment.split("=", 1)[0];
            if (!key) {
              throw new Error("Invalid systemd drop-in environment removal");
            }
            unsetEnvironmentKeys.add(key);
          }
        } else if (
          parseEnvironmentFileSpecs(value).some((filename) =>
            filename.replace(/%%|%h/gu, "").includes("%"),
          )
        ) {
          overrides.environment = true;
        } else {
          try {
            const fileEnvironment = await resolveSystemdEnvironmentFiles({
              environmentFileSpecs: [value],
              env,
              unitPath,
              failOnUnavailable: true,
            });
            for (const key of Object.keys(fileEnvironment)) {
              fileEnvironmentKeys.add(key);
            }
          } catch {
            overrides.environment = true;
          }
        }
      }
    }
  }
  if (overrides.environment !== true) {
    const ownedKeys = [
      ...new Set([...inlineEnvironmentKeys, ...fileEnvironmentKeys, ...unsetEnvironmentKeys]),
    ];
    if (ownedKeys.length > 0 || resetInline || resetFiles) {
      overrides.environment = {
        ...(ownedKeys.length > 0 ? { keys: ownedKeys } : {}),
        ...(resetInline ? { resetInline: true } : {}),
        ...(resetFiles ? { resetFiles: true } : {}),
      };
    }
  }
  return Object.keys(overrides).length ? overrides : undefined;
}

function splitSystemdEnvironmentWords(value: string): string[] {
  return splitArgsPreservingQuotes(value, {
    escapeMode: "backslash",
    quoteChars: ['"', "'"],
    quoteStart: "item-start",
  });
}

export async function readSystemdServiceExecStart(
  env: GatewayServiceEnv,
  opts?: GatewayServiceReadOptions,
): Promise<GatewayServiceCommandConfig | null> {
  const unitPath = resolveSystemdUnitPath(env);
  try {
    const content = await fs.readFile(unitPath, "utf8").catch((error: unknown) => {
      if (!hasErrnoCode(error, "ENOENT")) {
        throw error;
      }
      return null;
    });
    if (content === null && !opts?.requireEffective) {
      return null;
    }
    let execStart = "";
    let workingDirectory = "";
    let inlineEnvironment: Record<string, string> = {};
    const environmentFileSpecs: string[] = [];
    const unsetEnvironment: string[] = [];
    for (const rawLine of splitSystemdLogicalLines(content ?? "")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) {
        continue;
      }
      const separator = line.indexOf("=");
      if (separator < 0) {
        continue;
      }
      const directive = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim();
      if (directive === "ExecStart") {
        execStart = value;
      } else if (directive === "WorkingDirectory") {
        const parsed = parseSystemdExecStart(value)[0] ?? "";
        workingDirectory = expandSystemdSpecifier(parsed.replace(/^-/, ""), env);
      } else if (directive === "Environment") {
        if (!value) {
          inlineEnvironment = {};
        }
        for (const parsed of parseSystemdEnvAssignments(value)) {
          inlineEnvironment[parsed.key] = expandSystemdSpecifier(parsed.value, env);
        }
      } else if (directive === "EnvironmentFile" || directive === "UnsetEnvironment") {
        const file = directive === "EnvironmentFile";
        const entries = file ? environmentFileSpecs : unsetEnvironment;
        if (!value) {
          entries.length = 0;
        } else {
          entries.push(...(file ? [value] : splitSystemdEnvironmentWords(value)));
        }
      }
    }
    // Only manager-effective EnvironmentFile entries are required; drop-ins can reset the base.
    const managedDefinition = await buildSystemdCommandSnapshot({
      programArguments: parseSystemdExecStart(execStart).map((argument) =>
        expandSystemdSpecifier(argument, env),
      ),
      workingDirectory,
      inlineEnvironment,
      environmentFileSpecs,
      unsetEnvironment,
      env,
      unitPath,
    });
    const localDefinition = content === null ? null : managedDefinition;
    const managerRead = readSystemdManagerCommand(env, localDefinition, unsetEnvironment, opts);
    const manager = opts?.requireEffective
      ? await managerRead
      : await managerRead.catch(() => null);
    if (manager || opts?.requireEffective) {
      return manager;
    }
    return managedDefinition.programArguments.length
      ? {
          ...managedDefinition,
          managedDefinition,
          managedOverrides: UNKNOWN_SYSTEMD_OVERRIDES,
          sourcePath: unitPath,
        }
      : null;
  } catch (error) {
    if (opts?.requireEffective) {
      throw error;
    }
    return null;
  }
}

export function resolveSystemdEnvironmentFilePath(params: {
  stateDir: string;
  environment?: GatewayServiceEnv;
}): string {
  const serviceKind = params.environment?.OPENCLAW_SERVICE_KIND?.trim();
  const filename =
    serviceKind === "node" ? SYSTEMD_NODE_DOTENV_FILENAME : SYSTEMD_GATEWAY_DOTENV_FILENAME;
  return path.join(params.stateDir, filename);
}

export function resolveLegacyNodeSystemdEnvironmentFilePath(params: {
  stateDir: string;
  environment?: GatewayServiceEnv;
}): string | null {
  if (params.environment?.OPENCLAW_SERVICE_KIND?.trim() !== "node") {
    return null;
  }
  return path.join(params.stateDir, SYSTEMD_GATEWAY_DOTENV_FILENAME);
}

export function isNodeSystemdEnvironment(env: GatewayServiceEnv): boolean {
  return env.OPENCLAW_SERVICE_KIND?.trim() === "node";
}

function expandSystemdSpecifier(input: string, env: GatewayServiceEnv): string {
  return input.replace(/%%|%h/gu, (specifier) =>
    specifier === "%%" ? "%" : normalizeWindowsPathSeparators(resolveDaemonHomeDir(env)),
  );
}

function parseEnvironmentFileSpecs(raw: string): string[] {
  return normalizeStringEntries(splitArgsPreservingQuotes(raw, { escapeMode: "backslash" }));
}

function decodeSystemdEnvironmentFileValue(rawValue: string): {
  value: string;
  literalDollar: boolean;
} {
  type ParseState =
    | "pre"
    | "unquoted"
    | "unquoted-escape"
    | "single-quoted"
    | "double-quoted"
    | "double-quoted-escape";

  // Mirror systemd's parse_env_file_internal state transitions. In particular,
  // a closing quoted segment returns to `pre`, so `"foo"bar` decodes to `foobar`.
  let state: ParseState = "pre";
  let decoded = "";
  let literalDollar = false;
  let trailingWhitespaceStart: number | undefined;
  for (const char of rawValue) {
    const whitespace = char === " " || char === "\t" || char === "\r";
    if (state === "pre") {
      if (whitespace) {
        continue;
      }
      if (char === "'") {
        state = "single-quoted";
        continue;
      }
      if (char === '"') {
        state = "double-quoted";
        continue;
      }
      if (char === "\\") {
        state = "unquoted-escape";
        continue;
      }
      state = "unquoted";
      decoded += char;
      continue;
    }
    if (state === "unquoted") {
      if (char === "\\") {
        state = "unquoted-escape";
        trailingWhitespaceStart = undefined;
        continue;
      }
      if (whitespace) {
        trailingWhitespaceStart ??= decoded.length;
      } else {
        trailingWhitespaceStart = undefined;
      }
      decoded += char;
      continue;
    }
    if (state === "unquoted-escape") {
      state = "unquoted";
      literalDollar ||= char === "$";
      decoded += char;
      continue;
    }
    if (state === "single-quoted") {
      if (char === "'") {
        state = "pre";
      } else {
        literalDollar ||= char === "$";
        decoded += char;
      }
      continue;
    }
    if (state === "double-quoted") {
      if (char === '"') {
        state = "pre";
      } else if (char === "\\") {
        state = "double-quoted-escape";
      } else {
        literalDollar ||= char === "$";
        decoded += char;
      }
      continue;
    }
    state = "double-quoted";
    if (['"', "\\", "`", "$"].includes(char)) {
      literalDollar ||= char === "$";
      decoded += char;
    } else {
      decoded += `\\${char}`;
    }
  }
  if (state === "unquoted" && trailingWhitespaceStart !== undefined) {
    decoded = decoded.slice(0, trailingWhitespaceStart);
  }
  return { value: decoded, literalDollar };
}

function parseEnvironmentFileLine(
  rawLine: string,
): { key: string; value: string; literalShellReference: boolean } | null {
  const trimmedStart = rawLine.trimStart();
  if (!trimmedStart || trimmedStart.startsWith("#") || trimmedStart.startsWith(";")) {
    return null;
  }
  const eq = trimmedStart.indexOf("=");
  if (eq <= 0) {
    return null;
  }
  const key = trimmedStart.slice(0, eq).trim();
  if (!key) {
    return null;
  }
  const decoded = decodeSystemdEnvironmentFileValue(trimmedStart.slice(eq + 1));
  return {
    key,
    value: decoded.value,
    literalShellReference: decoded.literalDollar && isUnresolvedShellReference(decoded.value),
  };
}

function serializeSystemdEnvironmentFileValue(value: string): string {
  // EnvironmentFile double quotes only unescape \", \\, \`, and \$. Escape
  // exactly that set so credentials survive systemd parsing byte-for-byte.
  if (!/[\s\\'"`$]/u.test(value)) {
    return value;
  }
  const escaped = value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("`", "\\`")
    .replaceAll("$", "\\$");
  return `"${escaped}"`;
}

export function serializeSystemdEnvironmentFile(environment: Record<string, string>): string {
  return Object.entries(environment)
    .map(([key, value]) => `${key}=${serializeSystemdEnvironmentFileValue(value)}`)
    .join("\n");
}

export async function readSystemdEnvironmentFile(pathname: string): Promise<{
  environment: Record<string, string>;
  literalShellReferenceKeys: Set<string>;
}> {
  const environment: Record<string, string> = {};
  const literalShellReferenceKeys = new Set<string>();
  const content = await fs.readFile(pathname, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const parsed = parseEnvironmentFileLine(rawLine);
    if (!parsed) {
      continue;
    }
    environment[parsed.key] = parsed.value;
    if (parsed.literalShellReference) {
      literalShellReferenceKeys.add(parsed.key);
    } else {
      literalShellReferenceKeys.delete(parsed.key);
    }
  }
  return { environment, literalShellReferenceKeys };
}

async function resolveSystemdEnvironmentFiles(params: {
  environmentFileSpecs: SystemdEnvironmentFileSpec[];
  env: GatewayServiceEnv;
  unitPath: string;
  failOnUnavailable?: boolean;
}): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};
  const unitDir = path.posix.dirname(params.unitPath);
  const failIfUnavailable = (error: unknown, optional: boolean) => {
    if (params.failOnUnavailable && !optional) {
      throw error;
    }
  };
  for (const specRaw of params.environmentFileSpecs) {
    const managerExpandedPath = typeof specRaw !== "string";
    const tokens = managerExpandedPath ? [specRaw[0]] : parseEnvironmentFileSpecs(specRaw);
    for (const token of tokens) {
      const optional = token.startsWith("-") || (typeof specRaw !== "string" && specRaw[1]);
      const pathnameRaw = token.startsWith("-") ? token.slice(1).trim() : token;
      if (!pathnameRaw) {
        continue;
      }
      const expanded = managerExpandedPath
        ? pathnameRaw
        : expandSystemdSpecifier(pathnameRaw, params.env);
      const pathname = path.posix.isAbsolute(expanded)
        ? expanded
        : path.posix.resolve(unitDir, expanded);
      const pathnames = [pathname];
      if (/[*?[]/u.test(pathname)) {
        pathnames.length = 0;
        try {
          for await (const match of fs.glob(pathname)) {
            pathnames.push(match);
          }
        } catch (error) {
          failIfUnavailable(error, optional);
          continue;
        }
        pathnames.sort();
        if (params.failOnUnavailable && !optional && pathnames.length === 0) {
          throw new Error("Missing systemd environment file");
        }
      }
      for (const filePath of pathnames) {
        try {
          Object.assign(resolved, (await readSystemdEnvironmentFile(filePath)).environment);
        } catch (error) {
          failIfUnavailable(error, optional);
          // Diagnostics skip unavailable files, including non-optional ones.
          continue;
        }
      }
    }
  }
  return resolved;
}
