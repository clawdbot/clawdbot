import { spawnSync } from "node:child_process";
import { isIP } from "node:net";
import { consumeRootOptionToken, FLAG_TERMINATOR } from "../infra/cli-root-options.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { resolveCliArgvInvocation } from "./argv-invocation.js";
import { scanCliRootOptions } from "./root-option-scan.js";
import { takeCliRootOptionValue } from "./root-option-value.js";

type CliContainerParseResult =
  | { ok: true; container: string | null; argv: string[] }
  | { ok: false; error: string };

export type CliContainerTargetResult =
  | { handled: true; exitCode: number }
  | { handled: false; argv: string[] };

type ContainerTargetDeps = {
  env: NodeJS.ProcessEnv;
  spawnSync: typeof spawnSync;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
};

type ContainerRuntimeExec = {
  runtime: "podman" | "docker";
  command: string;
  argsPrefix: string[];
};

const CONTAINER_ALLOW_LOOPBACK_PROXY_URL_ENV = "OPENCLAW_CONTAINER_ALLOW_LOOPBACK_PROXY_URL";

export function parseCliContainerArgs(argv: string[]): CliContainerParseResult {
  let container: string | null = null;

  const scanned = scanCliRootOptions(argv, ({ arg, args, index }) => {
    if (arg === "--container" || arg.startsWith("--container=")) {
      const next = args[index + 1];
      const { value, consumedNext } = takeCliRootOptionValue(arg, next);
      if (!value) {
        return { kind: "error", error: "--container requires a value" };
      }
      container = value;
      return { kind: "handled", consumedNext };
    }
    return { kind: "pass" };
  });

  if (!scanned.ok) {
    return scanned;
  }

  return { ok: true, container, argv: scanned.argv };
}

export function resolveCliContainerTarget(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const parsed = parseCliContainerArgs(argv);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  return parsed.container ?? normalizeOptionalString(env.OPENCLAW_CONTAINER) ?? null;
}

function isContainerRunning(params: {
  exec: ContainerRuntimeExec;
  containerName: string;
  deps: Pick<ContainerTargetDeps, "spawnSync">;
}): boolean {
  const result = params.deps.spawnSync(
    params.exec.command,
    [...params.exec.argsPrefix, "inspect", "--format", "{{.State.Running}}", params.containerName],
    params.exec.command === "sudo"
      ? { encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] }
      : { encoding: "utf8" },
  );
  return result.status === 0 && result.stdout.trim() === "true";
}

function candidateContainerRuntimes(): ContainerRuntimeExec[] {
  return [
    {
      runtime: "podman",
      command: "podman",
      argsPrefix: [],
    },
    {
      runtime: "docker",
      command: "docker",
      argsPrefix: [],
    },
  ];
}

function resolveRunningContainer(params: {
  containerName: string;
  env: NodeJS.ProcessEnv;
  deps: Pick<ContainerTargetDeps, "spawnSync">;
}): (ContainerRuntimeExec & { containerName: string }) | null {
  const matches: Array<ContainerRuntimeExec & { containerName: string }> = [];
  const candidates = candidateContainerRuntimes();
  for (const exec of candidates) {
    if (
      isContainerRunning({
        exec,
        containerName: params.containerName,
        deps: params.deps,
      })
    ) {
      matches.push({ ...exec, containerName: params.containerName });
      if (exec.runtime === "docker") {
        break;
      }
    }
  }
  if (matches.length === 0) {
    return null;
  }
  if (matches.length > 1) {
    const runtimes = matches.map((match) => match.runtime).join(", ");
    throw new Error(
      `Container "${params.containerName}" is running under multiple runtimes (${runtimes}); use a unique container name.`,
    );
  }
  return matches[0];
}

function buildContainerExecArgs(params: {
  exec: ContainerRuntimeExec;
  containerName: string;
  argv: string[];
  env: NodeJS.ProcessEnv;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
}): string[] {
  const envFlag = params.exec.runtime === "docker" ? "-e" : "--env";
  const proxyUrl = normalizeOptionalString(params.env.OPENCLAW_PROXY_URL);
  if (proxyUrl) {
    assertContainerProxyUrlIsReachable(proxyUrl, params.env);
  }
  const proxyEnvArgs = proxyUrl ? [envFlag, `OPENCLAW_PROXY_URL=${proxyUrl}`] : [];
  const interactiveFlags = ["-i", ...(params.stdinIsTTY && params.stdoutIsTTY ? ["-t"] : [])];
  return [
    ...params.exec.argsPrefix,
    "exec",
    ...interactiveFlags,
    envFlag,
    `OPENCLAW_CONTAINER_HINT=${params.containerName}`,
    envFlag,
    "OPENCLAW_CLI_CONTAINER_BYPASS=1",
    ...proxyEnvArgs,
    params.containerName,
    "openclaw",
    ...params.argv,
  ];
}

function assertContainerProxyUrlIsReachable(proxyUrl: string, env: NodeJS.ProcessEnv): void {
  if (env[CONTAINER_ALLOW_LOOPBACK_PROXY_URL_ENV] === "1") {
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(proxyUrl);
  } catch {
    return;
  }
  if (!isLoopbackProxyHostname(parsed.hostname)) {
    return;
  }
  throw new Error(
    `OPENCLAW_PROXY_URL=${redactProxyUrlForMessage(proxyUrl)} is loopback; 127.0.0.1 inside a container points at the container, not the host. ` +
      `Use a container-reachable proxy address, or set ${CONTAINER_ALLOW_LOOPBACK_PROXY_URL_ENV}=1 if this is intentional.`,
  );
}

function isLoopbackProxyHostname(hostname: string): boolean {
  const normalizedHostname = hostname.toLowerCase().replace(/\.+$/, "");
  if (normalizedHostname === "localhost") {
    return true;
  }
  if (isIP(normalizedHostname) === 4) {
    return normalizedHostname.split(".", 1)[0] === "127";
  }
  const ipv6Hostname = normalizedHostname.replace(/^\[|\]$/g, "");
  if (isIP(ipv6Hostname) !== 6) {
    return false;
  }
  if (ipv6Hostname === "::1" || ipv6Hostname === "0:0:0:0:0:0:0:1") {
    return true;
  }
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ipv6Hostname);
  if (!mapped) {
    return false;
  }
  const high = Number.parseInt(mapped[1], 16);
  return Number.isInteger(high) && high >= 0x7f00 && high <= 0x7fff;
}

function redactProxyUrlForMessage(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.username || url.password) {
      url.username = "redacted";
      url.password = url.password ? "redacted" : "";
    }
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "<invalid URL>";
  }
}

function buildContainerExecEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  // Container-targeted CLI invocations should use the container's own profile
  // and gateway auth/runtime state rather than inheriting host overrides.
  delete next.OPENCLAW_PROFILE;
  delete next.OPENCLAW_GATEWAY_PORT;
  delete next.OPENCLAW_GATEWAY_URL;
  delete next.OPENCLAW_GATEWAY_TOKEN;
  delete next.OPENCLAW_GATEWAY_PASSWORD;
  // The child CLI should render container-aware follow-up commands via
  // OPENCLAW_CONTAINER_HINT, but it should not treat itself as still
  // container-targeted for validation/routing.
  next.OPENCLAW_CONTAINER = "";
  return next;
}

function isBlockedContainerCommand(argv: string[]): boolean {
  if (resolveCliArgvInvocation(["node", "openclaw", ...argv]).primary === "update") {
    return true;
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg || arg === FLAG_TERMINATOR) {
      return false;
    }
    if (arg === "--update") {
      return true;
    }
    const consumedRootOption = consumeRootOptionToken(argv, i);
    if (consumedRootOption > 0) {
      i += consumedRootOption - 1;
      continue;
    }
    if (!arg.startsWith("-")) {
      return false;
    }
  }
  return false;
}

export function maybeRunCliInContainer(
  argv: string[],
  deps?: Partial<ContainerTargetDeps>,
): CliContainerTargetResult {
  const resolvedDeps: ContainerTargetDeps = {
    env: deps?.env ?? process.env,
    spawnSync: deps?.spawnSync ?? spawnSync,
    stdinIsTTY: deps?.stdinIsTTY ?? process.stdin.isTTY,
    stdoutIsTTY: deps?.stdoutIsTTY ?? process.stdout.isTTY,
  };

  if (resolvedDeps.env.OPENCLAW_CLI_CONTAINER_BYPASS === "1") {
    return { handled: false, argv };
  }

  const parsed = parseCliContainerArgs(argv);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  const containerName = resolveCliContainerTarget(argv, resolvedDeps.env);
  if (!containerName) {
    return { handled: false, argv: parsed.argv };
  }
  if (isBlockedContainerCommand(parsed.argv.slice(2))) {
    throw new Error(
      "openclaw update is not supported with --container; rebuild or restart the container image instead.",
    );
  }

  const runningContainer = resolveRunningContainer({
    containerName,
    env: resolvedDeps.env,
    deps: resolvedDeps,
  });
  if (!runningContainer) {
    throw new Error(`No running container matched "${containerName}" under podman or docker.`);
  }

  const result = resolvedDeps.spawnSync(
    runningContainer.command,
    buildContainerExecArgs({
      exec: runningContainer,
      containerName: runningContainer.containerName,
      argv: parsed.argv.slice(2),
      env: resolvedDeps.env,
      stdinIsTTY: resolvedDeps.stdinIsTTY,
      stdoutIsTTY: resolvedDeps.stdoutIsTTY,
    }),
    {
      stdio: "inherit",
      env: buildContainerExecEnv(resolvedDeps.env),
    },
  );
  return {
    handled: true,
    exitCode: typeof result.status === "number" ? result.status : 1,
  };
}
