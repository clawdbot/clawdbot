import { realpath } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { stableStringify } from "@openclaw/normalization-core";
import {
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
} from "../../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { readReturnCovenantJsonFile, writeReturnCovenantJsonFile } from "./control-file.js";
import { ProductReturnCovenantGatewayControl } from "./gateway.js";
import {
  authorizeReturnCovenantPhaseRequest,
  buildSignedReturnCovenantPhaseResponse,
  parseReturnCovenantDriverArgs,
  parseReturnCovenantDriverAttestation,
  parseReturnCovenantPhaseRequest,
  parseReturnCovenantPlan,
  RETURN_COVENANT_DRIVER_PROTOCOL,
  RETURN_COVENANT_DRIVER_READY_SCHEMA,
  RETURN_COVENANT_ROW_ID,
  ReturnCovenantProtocolError,
  sha256ReturnCovenant,
  type ReturnCovenantDriverAttestation,
  type ReturnCovenantPlan,
} from "./protocol.js";
import { ReturnCovenantFixtureRun } from "./run.js";
import { projectReturnCovenantRuntimeConfig } from "./runtime-config.js";

const FORBIDDEN_AMBIENT_ENV = [
  "NODE_PATH",
  "NPM_CONFIG_USERCONFIG",
  "PNPM_HOME",
  "COREPACK_HOME",
  "npm_config_store_dir",
] as const;

type IsolatedRuntime = {
  config: OpenClawConfig;
  configPath: string;
  homePath: string;
  statePath: string;
};

export type ReturnCovenantLaunchEnvironment = {
  attestationPath?: string;
  candidateSha?: string;
  docsHarnessSha?: string;
  launchNonce?: string;
  phaseKeyFingerprint?: string;
  phaseSigningKey?: string;
  productTreeSha?: string;
  runtimeArtifactManifestSha256?: string;
};

function fixtureRuntimeConfig(config: OpenClawConfig): OpenClawConfig {
  return {
    ...config,
    agents: {
      ...config.agents,
      defaults: {
        ...config.agents?.defaults,
        continuation: {
          ...config.agents?.defaults?.continuation,
          enabled: true,
          crossSessionTargeting: "disabled",
        },
      },
    },
  };
}

async function validateIsolatedRuntime(params: {
  launchEnvironment: ReturnCovenantLaunchEnvironment;
  plan: ReturnCovenantPlan;
}): Promise<IsolatedRuntime> {
  for (const name of FORBIDDEN_AMBIENT_ENV) {
    if (process.env[name]) {
      throw new Error(`return-covenant fixture refuses ambient environment ${name}`);
    }
  }
  const homePath = process.env.HOME;
  const statePath = process.env.OPENCLAW_STATE_DIR;
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  if (!homePath || !statePath || !configPath) {
    throw new Error("return-covenant fixture requires isolated home, state, and config paths");
  }
  const [homeRoot, stateRoot, configFile] = await Promise.all([
    realpath(homePath),
    realpath(statePath),
    realpath(configPath),
  ]);
  const runRoot = path.dirname(homeRoot);
  if (
    homeRoot !== path.join(runRoot, "home") ||
    stateRoot !== path.join(runRoot, "state") ||
    configFile !== path.join(runRoot, "config", "openclaw.json") ||
    !path.relative(process.cwd(), runRoot).startsWith("..")
  ) {
    throw new Error("return-covenant fixture paths do not match the isolated run layout");
  }
  const rawConfig = await readReturnCovenantJsonFile(configFile);
  if (sha256ReturnCovenant(stableStringify(rawConfig)) !== params.plan.target.runtimeConfigSha256) {
    throw new Error("return-covenant runtime config differs from the frozen plan");
  }
  const config = projectReturnCovenantRuntimeConfig(rawConfig);
  const identities = params.launchEnvironment;
  if (
    identities.candidateSha !== params.plan.target.candidateSha ||
    identities.productTreeSha !== params.plan.target.productTreeSha ||
    identities.docsHarnessSha !== params.plan.target.docsHarnessSha ||
    identities.runtimeArtifactManifestSha256 !== params.plan.target.runtimeArtifactManifestSha256
  ) {
    throw new Error("return-covenant runtime environment identity mismatch");
  }
  return {
    config,
    configPath: configFile,
    homePath: homeRoot,
    statePath: stateRoot,
  };
}

function readRequestBody(request: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      raw += chunk;
      if (Buffer.byteLength(raw, "utf8") > 1024 * 1024) {
        reject(
          new ReturnCovenantProtocolError(
            "request-too-large",
            "return-covenant request exceeded its byte limit",
            413,
          ),
        );
        request.destroy();
      }
    });
    request.once("error", reject);
    request.once("end", () => {
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(
          new ReturnCovenantProtocolError(
            "invalid-json",
            "return-covenant request body is not JSON",
            400,
          ),
        );
      }
    });
  });
}

function sendJson(response: http.ServerResponse, statusCode: number, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

function phaseFromUrl(url: string | undefined): string | undefined {
  return url?.match(
    /^\/v1\/return-covenant\/(prepare|dispatch|transition|release|observe|cleanup|cleanup-run)$/u,
  )?.[1];
}

function readyReceipt(params: {
  driverEndpoint: string;
  gateway: ReturnType<ProductReturnCovenantGatewayControl["current"]>;
  launchNonce: string;
  phaseKeyFingerprint: string;
  plan: ReturnCovenantPlan;
}) {
  const { driverEndpoint, gateway, launchNonce, phaseKeyFingerprint, plan } = params;
  return {
    schema: RETURN_COVENANT_DRIVER_READY_SCHEMA,
    protocol: RETURN_COVENANT_DRIVER_PROTOCOL,
    runId: plan.runId,
    rowId: plan.rowId,
    candidateSha: plan.target.candidateSha,
    productTreeSha: plan.target.productTreeSha,
    runtimeBuildSha: plan.target.runtimeBuildSha,
    docsHarnessSha: plan.target.docsHarnessSha,
    commandRelativePath: plan.driver.fixtureCommand.relativePath,
    commandSha256: plan.driver.fixtureCommand.sha256,
    gatewayCommandRelativePath: plan.driver.gatewayCommand.relativePath,
    gatewayCommandSha256: plan.driver.gatewayCommand.sha256,
    runtimeConfigSha256: plan.target.runtimeConfigSha256,
    runtimeArtifactManifestSha256: plan.target.runtimeArtifactManifestSha256,
    launchNonce,
    phaseKeyFingerprint,
    pid: process.pid,
    gatewayPid: gateway.pid,
    gatewayEndpoint: gateway.endpoint,
    namespacePid: process.pid,
    namespaceGatewayPid: gateway.pid,
    revocationCapability: {
      schema: "openclaw.k6.return-covenant-capability-inventory.v1",
      source: "product-owned",
      productSha: plan.target.candidateSha,
      runtimeBuildSha: plan.target.runtimeBuildSha,
      runtimeConfigSha256: plan.target.runtimeConfigSha256,
      inventoryComplete: true,
      revocationApiExposed: true,
      surface: "test-runtime/return-covenant/recipient-authority-revocation",
      receiptId: `capability-${sha256ReturnCovenant(plan.runId).slice(0, 24)}`,
    },
    endpoint: driverEndpoint,
  };
}

export async function runReturnCovenantFixtureDriver(
  argv: readonly string[],
  options: { launchEnvironment: ReturnCovenantLaunchEnvironment },
): Promise<void> {
  const args = parseReturnCovenantDriverArgs(argv);
  const plan = parseReturnCovenantPlan(await readReturnCovenantJsonFile(args.planPath));
  const runtime = await validateIsolatedRuntime({
    launchEnvironment: options.launchEnvironment,
    plan,
  });
  const { attestationPath, launchNonce, phaseKeyFingerprint, phaseSigningKey } =
    options.launchEnvironment;
  if (
    !launchNonce ||
    launchNonce.length < 24 ||
    !phaseSigningKey ||
    phaseSigningKey.length < 32 ||
    phaseKeyFingerprint !== sha256ReturnCovenant(phaseSigningKey) ||
    !attestationPath
  ) {
    throw new Error("return-covenant launcher challenge environment is incomplete");
  }

  const config = fixtureRuntimeConfig(runtime.config);
  setRuntimeConfigSnapshot(config, runtime.config);
  const gateway = new ProductReturnCovenantGatewayControl({
    cwd: process.cwd(),
    plan,
    runtimeConfig: runtime.config,
  });
  let fixtureRun: ReturnCovenantFixtureRun | undefined;
  let server: http.Server | undefined;
  let attestation: ReturnCovenantDriverAttestation | undefined;
  let finalizing = false;
  const seenRequestNonces = new Set<string>();
  let resolveDone: (() => void) | undefined;
  let rejectDone: ((error: unknown) => void) | undefined;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const readAttestation = async () => {
    attestation ??= parseReturnCovenantDriverAttestation(
      await readReturnCovenantJsonFile(attestationPath),
    );
    return attestation;
  };

  const finalize = async () => {
    if (finalizing) {
      return;
    }
    finalizing = true;
    const failures: unknown[] = [];
    try {
      await gateway.stopAll();
    } catch (error) {
      failures.push(error);
    }
    let claims: Record<string, unknown> | undefined;
    if (failures.length === 0 && fixtureRun) {
      try {
        claims = await fixtureRun.buildCleanupClaims();
      } catch (error) {
        failures.push(error);
      }
    }
    if (fixtureRun) {
      try {
        await fixtureRun.close();
      } catch (error) {
        failures.push(error);
      }
    }
    resetConfigRuntimeState();
    if (claims) {
      try {
        await writeReturnCovenantJsonFile(args.cleanupDraftPath, claims);
      } catch (error) {
        failures.push(error);
      }
    }
    if (server) {
      const activeServer = server;
      activeServer.closeAllConnections();
      await new Promise<void>((resolve) => {
        activeServer.close(() => resolve());
      });
    }
    if (failures.length > 0) {
      const error = new AggregateError(failures, "return-covenant fixture cleanup failed");
      rejectDone?.(error);
      return;
    }
    resolveDone?.();
  };

  try {
    fixtureRun = await ReturnCovenantFixtureRun.create({
      config,
      env: process.env,
      gateway,
      plan,
    });
    const gatewayBinding = await gateway.start();
    server = http.createServer((request, response) => {
      void (async () => {
        try {
          const pathPhase = phaseFromUrl(request.url);
          if (
            request.method !== "POST" ||
            !pathPhase ||
            request.headers["content-type"]?.split(";", 1)[0] !== "application/json"
          ) {
            throw new ReturnCovenantProtocolError(
              "invalid-endpoint",
              "return-covenant driver accepts JSON POST phase requests only",
              404,
            );
          }
          const phaseRequest = parseReturnCovenantPhaseRequest(await readRequestBody(request));
          if (phaseRequest.phase !== pathPhase) {
            throw new ReturnCovenantProtocolError(
              "phase-mismatch",
              "request path and body phase differ",
            );
          }
          const trustedAttestation = await readAttestation();
          authorizeReturnCovenantPhaseRequest({
            attestation: trustedAttestation,
            launchNonce,
            phaseSigningKey,
            plan,
            request: phaseRequest,
            seenRequestNonces,
          });
          const payload = await fixtureRun!.handle(phaseRequest, trustedAttestation);
          sendJson(
            response,
            200,
            buildSignedReturnCovenantPhaseResponse({
              attestation: trustedAttestation,
              payload,
              phaseSigningKey,
              request: phaseRequest,
            }),
          );
          if (fixtureRun!.finalizeRequested) {
            setImmediate(() => void finalize());
          }
        } catch (error) {
          const statusCode = error instanceof ReturnCovenantProtocolError ? error.statusCode : 500;
          const code = error instanceof ReturnCovenantProtocolError ? error.code : "driver-failure";
          const message = error instanceof Error ? error.message : "unknown driver failure";
          sendJson(response, statusCode, {
            schema: RETURN_COVENANT_DRIVER_PROTOCOL,
            ok: false,
            code,
            message,
          });
          if (!(error instanceof ReturnCovenantProtocolError)) {
            process.stderr.write(`return-covenant phase failed: ${message}\n`);
          }
        }
      })();
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("return-covenant driver did not acquire a loopback listener");
    }
    const endpoint = `http://127.0.0.1:${address.port}`;
    await writeReturnCovenantJsonFile(
      args.readyPath,
      readyReceipt({
        driverEndpoint: endpoint,
        gateway: gatewayBinding,
        launchNonce,
        phaseKeyFingerprint,
        plan,
      }),
    );
    const handleSignal = () => {
      void finalize();
    };
    process.once("SIGINT", handleSignal);
    process.once("SIGTERM", handleSignal);
    try {
      await done;
    } finally {
      process.removeListener("SIGINT", handleSignal);
      process.removeListener("SIGTERM", handleSignal);
    }
  } catch (error) {
    const failures = [error];
    try {
      await gateway.stopAll();
    } catch (cleanupError) {
      failures.push(cleanupError);
    }
    if (fixtureRun) {
      try {
        await fixtureRun.close();
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
    }
    resetConfigRuntimeState();
    if (failures.length === 1) {
      throw error;
    }
    throw new AggregateError(failures, "return-covenant startup failed and cleanup also failed", {
      cause: error,
    });
  }
}

export function returnCovenantDriverIdentity() {
  return {
    protocol: RETURN_COVENANT_DRIVER_PROTOCOL,
    readySchema: RETURN_COVENANT_DRIVER_READY_SCHEMA,
    rowId: RETURN_COVENANT_ROW_ID,
  };
}
