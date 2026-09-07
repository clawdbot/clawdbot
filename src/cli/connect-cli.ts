// One-paste node onboarding from setup codes or single-use Gateway join URLs.
import fs from "node:fs/promises";
import type { Command } from "commander";
import {
  buildCloudflareAccessHeaders,
  CF_ACCESS_CLIENT_ID_HEADER,
  CF_ACCESS_CLIENT_SECRET_HEADER,
  type CloudflareAccessCredentials,
} from "../../packages/gateway-client/src/cloudflare-access.js";
import { formatDocsLink } from "../../packages/terminal-core/src/links.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { getRuntimeConfig, mutateConfigFileWithRetry } from "../config/config.js";
import { isLoopbackHost } from "../gateway/net.js";
import { cancelUnreadResponseBody, readResponseWithLimit } from "../infra/http-body.js";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import { normalizeHostname } from "../infra/net/hostname.js";
import { readRegularFile } from "../infra/regular-file.js";
import { loadNodeHostConfig, type NodeHostGatewayConfig } from "../node-host/config.js";
import {
  nodeHostCloudflareAccessConfigFromEnv,
  nodeHostGatewayMatchesUrl,
  nodeHostGatewaysShareOrigin,
  resolveNodeHostCloudflareAccess,
  type NodeHostCloudflareAccessConfig,
} from "../node-host/gateway-cloudflare-access.js";
import { runNodeHost } from "../node-host/runner.js";
import { isDevicePairingJoinCode } from "../pairing/join-code.js";
import { decodePairingSetupCode, encodePairingSetupCode } from "../pairing/setup-code.js";
import { defaultRuntime } from "../runtime.js";
import { formatHelpExamples } from "./help-format.js";
import { runNodeDaemonInstall } from "./node-cli/daemon.js";
import { resolveNodePairGatewayPayload } from "./node-cli/gateway-options.js";

type ConnectCommandOptions = {
  service?: boolean;
  ephemeral?: boolean;
  sessionHost?: boolean;
  targetFile?: string;
  displayName?: string;
};

type PairingSetupPayload = ReturnType<typeof decodePairingSetupCode>;

const MAX_JOIN_PAYLOAD_BYTES = 24 * 1024;
const MAX_TARGET_FILE_BYTES = 64 * 1024;
const JOIN_FETCH_TIMEOUT_MS = 15_000;

function parseJoinTarget(target: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return null;
  }
  const match = /(?:^|\/)j\/([^/]+)$/u.exec(parsed.pathname);
  const shortcode = match?.[1] ?? "";
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !isDevicePairingJoinCode(shortcode)
  ) {
    throw new Error("Join URL must end with the exact /j/<shortcode> form.");
  }
  if (parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname)) {
    throw new Error("Plain HTTP join URLs are allowed only for loopback gateways.");
  }
  return parsed;
}

async function fetchJoinPayload(
  target: URL,
  cloudflareAccess?: CloudflareAccessCredentials,
): Promise<PairingSetupPayload> {
  const expectedHost = normalizeHostname(target.hostname);
  let release: () => Promise<void> = async () => {};
  try {
    const guarded = await fetchWithSsrFGuard({
      url: target.toString(),
      auditContext: "openclaw-connect-join",
      maxRedirects: 0,
      requireHttps: target.protocol === "https:",
      timeoutMs: JOIN_FETCH_TIMEOUT_MS,
      ...(cloudflareAccess
        ? {
            init: { headers: buildCloudflareAccessHeaders(cloudflareAccess) },
            capture: {
              sensitiveRequestHeaderNames: [
                CF_ACCESS_CLIENT_ID_HEADER,
                CF_ACCESS_CLIENT_SECRET_HEADER,
              ],
            },
          }
        : {}),
      policy: {
        allowPrivateNetwork: true,
        allowedHostnames: [expectedHost],
        hostnameAllowlist: [expectedHost],
      },
    });
    release = guarded.release;
    const response = guarded.response;
    if (!response.ok || !response.headers.get("content-type")?.startsWith("application/json")) {
      await cancelUnreadResponseBody(response);
      throw new Error("Gateway join code was not found or has expired.");
    }
    const body = await readResponseWithLimit(response, MAX_JOIN_PAYLOAD_BYTES);
    let decoded: unknown;
    try {
      decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
    } catch {
      throw new Error("Gateway returned an invalid pairing payload.");
    }
    return decodePairingSetupCode(encodePairingSetupCode(decoded as PairingSetupPayload));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Gateway ")) {
      throw error;
    }
    throw new Error("Could not fetch the Gateway join payload securely.", { cause: error });
  } finally {
    await release();
  }
}

function selectCloudflareAccessConfig(params: {
  savedGateway?: NodeHostGatewayConfig;
  target: URL;
  env: NodeJS.ProcessEnv;
}): NodeHostCloudflareAccessConfig | undefined {
  const saved = params.savedGateway;
  return (
    (saved && nodeHostGatewayMatchesUrl(saved, params.target)
      ? saved.cloudflareAccess
      : undefined) ?? nodeHostCloudflareAccessConfigFromEnv(params.env)
  );
}

async function resolveConnectTarget(
  target: string | undefined,
  targetFile: string | undefined,
): Promise<string> {
  if (target && targetFile) {
    throw new Error("Provide the connect target or --target-file, not both.");
  }
  if (target) {
    return target;
  }
  const filePath = targetFile?.trim();
  if (!filePath) {
    throw new Error("Connect target is required.");
  }
  let buffer: Buffer;
  try {
    // The original fs.readFile behavior followed symlinks in the target path.
    // Resolve intentional links before the regular-file safety check so
    // symlinked secret-mount or one-shot target files keep working.
    const resolvedFilePath = await fs.realpath(filePath);
    ({ buffer } = await readRegularFile({
      filePath: resolvedFilePath,
      maxBytes: MAX_TARGET_FILE_BYTES,
    }));
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not read --target-file ${filePath} (max ${MAX_TARGET_FILE_BYTES} bytes): ${cause}`,
      { cause: error },
    );
  }
  const value = buffer.toString("utf8").trim();
  if (!value) {
    throw new Error("Connect target file is empty.");
  }
  await fs.rm(filePath, { force: true });
  return value;
}

async function runConnectCommand(
  target: string | undefined,
  opts: ConnectCommandOptions,
): Promise<void> {
  if (opts.ephemeral && opts.sessionHost) {
    throw new Error("--ephemeral cannot be combined with --session-host.");
  }
  if (opts.ephemeral && opts.service) {
    throw new Error("--ephemeral cannot be combined with --service.");
  }
  const resolvedTarget = await resolveConnectTarget(target, opts.targetFile);
  const joinTarget = parseJoinTarget(resolvedTarget);
  const saved = await loadNodeHostConfig();
  const initialCloudflareAccess = joinTarget
    ? selectCloudflareAccessConfig({
        savedGateway: saved?.gateway,
        target: joinTarget,
        env: process.env,
      })
    : undefined;
  if (initialCloudflareAccess && joinTarget?.protocol !== "https:") {
    throw new Error("Cloudflare Access credentials require an HTTPS join URL.");
  }
  const joinCredentials = await resolveNodeHostCloudflareAccess({
    value: initialCloudflareAccess,
    config: getRuntimeConfig(),
    env: process.env,
  });
  const payload = joinTarget
    ? await fetchJoinPayload(joinTarget, joinCredentials)
    : decodePairingSetupCode(resolvedTarget);
  const pair = resolveNodePairGatewayPayload(payload);
  const cloudflareAccess =
    initialCloudflareAccess ??
    (saved?.gateway && nodeHostGatewaysShareOrigin(saved.gateway, pair.candidates[0]!)
      ? saved.gateway.cloudflareAccess
      : undefined) ??
    nodeHostCloudflareAccessConfigFromEnv(process.env);
  const gatewayCandidates = pair.candidates.map((candidate, index) => {
    const boundToAccessOrigin = joinTarget
      ? nodeHostGatewayMatchesUrl(candidate, joinTarget)
      : index === 0;
    return boundToAccessOrigin && cloudflareAccess ? { ...candidate, cloudflareAccess } : candidate;
  });
  const forceWorkerRuns = opts.ephemeral === true || (opts.sessionHost === true && !opts.service);
  const nodeRunOptions = {
    gatewayHost: pair.host,
    gatewayPort: pair.port,
    gatewayTls: pair.tls,
    gatewayTlsFingerprint: pair.tlsFingerprint,
    gatewayContextPath: pair.contextPath,
    ...(gatewayCandidates[0]?.cloudflareAccess
      ? { gatewayCloudflareAccess: gatewayCandidates[0].cloudflareAccess }
      : {}),
    gatewayCandidates,
    gatewayBootstrapToken: pair.bootstrapToken,
    // Environment-managed nodes reuse their persisted device token when a provider
    // replays setup after the one-shot bootstrap credential has been consumed.
    preferGatewayBootstrapToken: opts.ephemeral !== true,
    ...(forceWorkerRuns ? { forceWorkerRuns: true } : {}),
    ...(opts.ephemeral === true ? { ephemeral: true } : {}),
    displayName: opts.displayName,
  };

  if (!opts.service) {
    await runNodeHost(nodeRunOptions);
    return;
  }

  // The first hello stores durable device auth and the winning endpoint before
  // installation, so the service never persists the one-shot bootstrap bearer.
  await runNodeHost({ ...nodeRunOptions, stopAfterFirstConnect: true });
  if (opts.sessionHost) {
    await mutateConfigFileWithRetry({
      writeOptions: {
        auditOrigin: "cli",
        explicitSetPaths: [["nodeHost", "workerRuns", "enabled"]],
      },
      mutate: (draft) => {
        draft.nodeHost = {
          ...draft.nodeHost,
          workerRuns: { ...draft.nodeHost?.workerRuns, enabled: true },
        };
      },
    });
  }
  await runNodeDaemonInstall({ displayName: opts.displayName, force: true });
}

export function registerConnectCli(program: Command): void {
  program
    .command("connect")
    .description("Connect this machine to an OpenClaw Gateway as a node")
    .argument("[target]", "oc-pair URL, setup code, or HTTPS Gateway join URL")
    .option("--service", "Install and run the node host as an OS service", false)
    .option("--ephemeral", "Run as an environment-managed disposable session host", false)
    .option(
      "--session-host",
      "Host worker sessions (process-scoped unless installed as a service)",
      false,
    )
    .option("--target-file <path>", "Read the connect target from a private file and remove it")
    .option("--display-name <name>", "Override the node display name")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw connect oc-pair://<setup-code>", "Connect in the foreground."],
          [
            "openclaw connect https://gateway.example/j/<code> --service",
            "Install the node host service.",
          ],
          [
            "openclaw connect https://gateway.example/j/<code> --service --session-host",
            "Install a worker-session host service.",
          ],
        ])}\n\n${theme.muted("Docs:")} ${formatDocsLink("/cli/connect", "docs.openclaw.ai/cli/connect")}\n`,
    )
    .action(async (target: string | undefined, opts: ConnectCommandOptions) => {
      try {
        await runConnectCommand(target, opts);
      } catch (error) {
        defaultRuntime.error(error instanceof Error ? error.message : String(error));
        defaultRuntime.exit(1);
      }
    });
}
