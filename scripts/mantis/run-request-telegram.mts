#!/usr/bin/env node
// Trusted host controller; candidate gets no broker, TDLib, capture or host socket.
import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { z } from "zod";
import { acquireQaLease } from "../../.agents/skills/telegram-e2e-userbot/scripts/qa-credential-lease.mjs";
import { restoreTelegramTestCredential } from "../../.agents/skills/telegram-e2e-userbot/scripts/telegram-test-credential.mjs";
import { createTelegramFailureDiagnostic } from "./request-proof.ts";
import { normalizeTelegramCapture } from "./telegram-capture.ts";
import { startTelegramProofIngress } from "./telegram-proof-ingress.mts";
import { parseTelegramProofPlan, type TelegramProofPlan } from "./telegram-proof-plan.ts";
import {
  assertPodmanProofStorage,
  assertProofImage,
  proofImageTag,
} from "./telegram-proof-storage.mts";
import { telegramProofIdentitySchema } from "./telegram-request-proof.ts";
import {
  assertCurrentTelegramRequest,
  redeemTelegramReviewProof,
} from "./telegram-run-admission.ts";

class TelegramProofStageError extends Error {
  readonly stage: string;

  constructor(stage: string, cause?: unknown) {
    super(`Telegram proof failed at ${stage}`, { cause });
    this.stage = stage;
  }
}

const execute = promisify(execFile);
const podman = async (args: string[]) =>
  (await execute("podman", args, { maxBuffer: 2 * 1024 * 1024, timeout: 60_000 })).stdout;
const imageInfo = z
  .array(
    z.object({
      Id: z.string().regex(/^(?:sha256:)?[a-f0-9]{64}$/),
      Config: z.object({ Labels: z.record(z.string(), z.string()) }),
    }),
  )
  .length(1);
const skill = path.resolve(".agents/skills/telegram-e2e-userbot/scripts");
type QaLease = Awaited<ReturnType<typeof acquireQaLease>>;

function telegramCandidateConfig(alias: string, testerId: string, plan?: TelegramProofPlan) {
  return {
    gateway: {
      mode: "local",
      bind: "loopback",
      port: 19879,
      auth: { mode: "none" },
      controlUi: { enabled: false },
    },
    logging: { file: "/work/crabbox/state/gateway.log" },
    agents: {
      defaults: { model: { primary: "openai/gpt-5.5" } },
      entries: {
        main: { workspace: "/work/crabbox/state/workspace", model: { primary: "openai/gpt-5.5" } },
      },
    },
    models: {
      providers: {
        openai: {
          api: "openai-completions",
          baseUrl: "http://proof-bridge:8080/provider/v1",
          apiKey: alias,
          request: { allowPrivateNetwork: true },
          models: [
            { id: "gpt-5.5", name: "QA mock", api: "openai-completions", contextWindow: 128000 },
          ],
        },
      },
    },
    plugins: {
      enabled: true,
      allow: ["telegram", "openai"],
      entries: { telegram: { enabled: true }, openai: { enabled: true } },
    },
    channels: {
      telegram: {
        enabled: true,
        botToken: alias,
        apiRoot: "http://proof-bridge:8080/telegram",
        dmPolicy: "allowlist",
        allowFrom: [testerId],
        groupPolicy: "disabled",
        streaming: { mode: plan?.settings.streaming ?? "off" },
        commands: { native: plan?.settings.nativeCommands ?? false, nativeSkills: false },
      },
    },
    messages: { ackReaction: "" },
  };
}
async function preflight(candidate: string, image: string) {
  const storageEnvironment = assertPodmanProofStorage();
  if (!/^[a-f0-9]{40}$/.test(candidate) || !/^[a-z0-9][a-z0-9/.:@-]*$/.test(image)) {
    throw new Error("Invalid candidate/image selection");
  }
  const info = imageInfo.parse(JSON.parse(await podman(["image", "inspect", image])))[0];
  if (!info || info.Config.Labels["org.openclaw.mantis.candidate-sha"] !== candidate) {
    throw new Error("Prepared runtime does not match exact candidate");
  }
  const versionName = `mantis-tg-version-${randomUUID()}`;
  try {
    await podman([
      "run",
      "--name",
      versionName,
      "--memory",
      "8g",
      "--cpus",
      "2",
      "--pids-limit",
      "512",
      "--network",
      "none",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      info.Id,
      "node",
      "dist/entry.js",
      "--version",
    ]);
  } finally {
    await podman(["rm", "--force", "--ignore", versionName]);
  }
  const root = path.resolve(".artifacts");
  await mkdir(root, { recursive: true });
  const temp = await mkdtemp(path.join(root, "telegram-preflight-"));
  const validationName = `mantis-tg-preflight-${randomUUID()}`;
  let validationId: string | undefined;
  try {
    const file = path.join(temp, "config.json");
    await writeFile(file, JSON.stringify(telegramCandidateConfig("1:preflight-placeholder", "1")), {
      mode: 0o600,
    });
    validationId = (
      await podman([
        "create",
        "--name",
        validationName,
        "--memory",
        "8g",
        "--cpus",
        "2",
        "--pids-limit",
        "512",
        "--network",
        "none",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--env",
        "OPENCLAW_STATE_DIR=/state",
        "--env",
        "OPENCLAW_CONFIG_PATH=/candidate-config.json",
        info.Id,
        "node",
        "dist/entry.js",
        "config",
        "validate",
        "--json",
      ])
    ).trim();
    await podman(["cp", file, `${validationId}:/candidate-config.json`]);
    await podman(["start", "--attach", validationId]);
    const state = JSON.parse(
      await podman(["inspect", "--format", "{{json .State}}", validationId]),
    );
    if (state.Running || state.ExitCode !== 0) {
      throw new Error("Candidate Gateway configuration is not ready");
    }
  } finally {
    await podman(["rm", "--force", "--ignore", validationName]);
    await rm(temp, { recursive: true, force: true });
  }
  const probe = await execute(
    "python3",
    ["scripts/mantis/telegram-driver-preflight.py", path.join(skill, "user-driver.py")],
    {
      timeout: 30_000,
      maxBuffer: 65536,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TELEGRAM_USER_DRIVER_TDLIB_CACHE_DIR: process.env.TELEGRAM_USER_DRIVER_TDLIB_CACHE_DIR,
      },
    },
  );
  const tdlib = probe.stdout.trim();
  await access(tdlib);
  const imageTag = proofImageTag(info.Id);
  await podman(["tag", info.Id, imageTag]);
  return { imageId: info.Id, imageTag, tdlib, storageEnvironment };
}
const args = process.argv.slice(2);
if (args[0] === "--preflight") {
  const ready = await preflight(args[1] ?? "", args[2] ?? "localhost/mantis-telegram-runtime");
  console.log(
    JSON.stringify({
      runtime_ready: true,
      image_id: ready.imageId,
      tdlib_ready: true,
      lease_acquired: false,
    }),
  );
} else {
  await run().catch((error: unknown) => {
    const stage = error instanceof TelegramProofStageError ? error.stage : "unclassified";
    console.error(
      `[mantis-telegram] FAILED stage=${stage}: proof is inconclusive; no credentials or private identity are printed`,
    );
    process.exitCode = 1;
  });
}
async function run() {
  const plan = parseTelegramProofPlan(process.env.PROOF_PLAN ?? "", process.env.PLAN_SHA256 ?? "");
  const [
    candidate,
    outputArg,
    image = "localhost/mantis-telegram-runtime",
    bridgeImage = "localhost/mantis-telegram-proof",
  ] = args;
  if (!candidate || !outputArg) {
    throw new Error(
      "Usage: run-request-telegram.mts <sha> <fresh-public-output> [runtime-image] [trusted-bridge-image]",
    );
  }
  const subject = {
    repositoryId: process.env.GITHUB_REPOSITORY_ID ?? "",
    pullRequest: Number(process.env.TARGET_PR),
    candidateSha: candidate,
  };
  const identity = telegramProofIdentitySchema.parse({
    // The consumer binds the request to its source comment and target snapshot.
    // Recomputing it from PR/head would lose that identity and collapse new requests.
    request_id: process.env.REQUEST_ID,
    plan_sha256: process.env.PLAN_SHA256,
    repository: { id: subject.repositoryId, full_name: process.env.GITHUB_REPOSITORY },
    pull_request: subject.pullRequest,
    candidate_sha: subject.candidateSha,
    scenario: "telegram-bot-e2e-proof",
    workflow: {
      path: ".github/workflows/mantis-telegram-bot-e2e-proof.yml",
      sha: process.env.GITHUB_WORKFLOW_SHA,
    },
    harness: { sha: process.env.GITHUB_WORKFLOW_SHA },
    run: { id: process.env.GITHUB_RUN_ID, attempt: Number(process.env.GITHUB_RUN_ATTEMPT) },
  });
  const ready = await preflight(candidate, image).catch((error: unknown) => {
    throw new TelegramProofStageError("runtime-preflight", error);
  });
  const admissionOptions = {
    token: process.env.GH_TOKEN ?? "",
    workflowRef: process.env.GITHUB_REF,
  };
  await assertCurrentTelegramRequest(identity, admissionOptions).catch((error: unknown) => {
    throw new TelegramProofStageError("request-admission-before-lease", error);
  });
  let reviewDeadline = 0,
    reviewMonotonicDeadline = 0;
  const authorityState: { file?: string; revoked: boolean } = { revoked: false };
  const refreshReview = async () => {
    if (
      authorityState.revoked ||
      (reviewDeadline &&
        (Date.now() >= reviewDeadline || performance.now() >= reviewMonotonicDeadline))
    ) {
      throw new Error("Original review confirmation expired");
    }
    const started = Date.now(),
      monotonic = performance.now();
    const expires = await redeemTelegramReviewProof(identity);
    if (
      authorityState.revoked ||
      expires <= Date.now() ||
      (reviewDeadline &&
        (Date.now() >= reviewDeadline || performance.now() >= reviewMonotonicDeadline))
    ) {
      throw new Error("Original review confirmation expired");
    }
    reviewDeadline = Math.min(expires, started + 30_000);
    reviewMonotonicDeadline = monotonic + Math.min(expires - started, 30_000);
    if (authorityState.file) {
      const temporary = `${authorityState.file}.${randomUUID()}`;
      await writeFile(temporary, String(reviewDeadline), { mode: 0o600 });
      await rename(temporary, authorityState.file);
    }
  };
  await refreshReview();
  if (!/^[a-z0-9][a-z0-9/.:@-]*$/.test(bridgeImage)) {
    throw new Error("Invalid trusted bridge image");
  }
  const output = path.resolve(outputArg);
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(output, { mode: 0o700 });
  const privateRoot = await mkdtemp(path.join(path.dirname(output), ".telegram-private-"));
  await chmod(privateRoot, 0o700);
  const authorityFile = path.join(privateRoot, "review-deadline");
  authorityState.file = authorityFile;
  await writeFile(authorityFile, String(reviewDeadline), { mode: 0o600 });
  // Keep lease recovery records separate from credential material. On uncertain
  // candidate deletion they remain available to the trusted cleanup operator.
  const boxRoot = await mkdtemp(path.join(path.dirname(output), ".telegram-crabbox-"));
  await chmod(boxRoot, 0o700);
  const salt = randomBytes(32),
    alias = `1:${randomBytes(24).toString("base64url")}`;
  const network = `mantis-tg-${randomUUID()}`,
    bridge = `mantis-tg-bridge-${randomUUID()}`;
  const boxId = `cbx_${randomBytes(6).toString("hex")}`;
  const boxEnv = {
    PATH: process.env.PATH,
    HOME: boxRoot,
    XDG_CONFIG_HOME: path.join(boxRoot, "config"),
    XDG_CACHE_HOME: path.join(boxRoot, "cache"),
    ...ready.storageEnvironment,
  };
  const box = async (boxArgs: string[]) =>
    (
      await execute("crabbox", boxArgs, {
        cwd: boxRoot,
        env: boxEnv,
        maxBuffer: 2 * 1024 * 1024,
        timeout: 180_000,
      })
    ).stdout;
  let sutId: string | undefined,
    bridgeId: string | undefined,
    networkCreated = false,
    quiescent = true;
  let boxAttempted = false;
  let stoppingSut = false;
  let candidateProcess: ReturnType<typeof spawn> | undefined;
  let candidateClosed: Promise<void> | undefined;
  let candidateCliJoined = true;
  let candidateCancellationRequested = false;
  let lease: QaLease | undefined;
  let ingress: Awaited<ReturnType<typeof startTelegramProofIngress>> | undefined;
  let recorder: ReturnType<typeof spawn> | undefined;
  const aborted = new AbortController(),
    abort = () => {
      authorityState.revoked = true;
      aborted.abort();
    };
  process.once("SIGTERM", abort);
  process.once("SIGINT", abort);
  const ensureAuthority = () => {
    if (
      aborted.signal.aborted ||
      Date.now() >= reviewDeadline ||
      performance.now() >= reviewMonotonicDeadline
    ) {
      throw new Error("Proof aborted");
    }
    lease?.assertHealthy();
  };
  const ensureActive = () => {
    ensureAuthority();
    ingress?.assertHealthy();
  };
  let refreshing = false;
  const reviewTimer = setInterval(() => {
    if (refreshing) {
      return;
    }
    refreshing = true;
    void refreshReview()
      .catch(abort)
      .finally(() => {
        refreshing = false;
      });
  }, 10_000);
  reviewTimer.unref();
  const stopSut = async () => {
    if (!boxAttempted || quiescent) {
      return;
    }
    stoppingSut = true;
    if (candidateProcess && candidateClosed && !candidateCliJoined) {
      if (!candidateCancellationRequested) {
        candidateCancellationRequested = true;
        candidateProcess.kill("SIGTERM");
      }
      const deadline = new AbortController();
      try {
        const joined = await Promise.race([
          candidateClosed.then(() => true),
          delay(15_000, false, { signal: deadline.signal }),
        ]);
        if (!joined) {
          throw new Error("Crabbox command shutdown is incomplete; recovery state retained");
        }
      } finally {
        deadline.abort();
      }
    }
    // Independently inspect physical deletion even if CLI bookkeeping failed.
    await box([
      "stop",
      "--provider",
      "local-container",
      "--local-container-runtime",
      "podman",
      boxId,
    ]).catch(() => undefined);
    const remaining = (
      await podman(["ps", "-a", "--filter", `label=lease=${boxId}`, "--format", "{{.ID}}"])
    ).trim();
    if (remaining) {
      throw new Error("Crabbox candidate deletion is not confirmed");
    }
    quiescent = true;
  };
  let facts: ReturnType<typeof normalizeTelegramCapture> | undefined;
  let primaryError: unknown;
  let stage = "isolated-network";
  try {
    await podman(["network", "create", "--internal", network]);
    networkCreated = true;
    const networks = JSON.parse(await podman(["network", "inspect", network]));
    if (networks.length !== 1 || (networks[0].internal ?? networks[0].Internal) !== true) {
      throw new Error("Candidate network is not internal");
    }
    // First broker call is after exact runtime and driver preparation.
    stage = "lease-acquisition";
    lease = await acquireQaLease({
      kind: "telegram-test-userbot",
      leaseTtlMs: 2 * 60 * 60_000,
    });
    void lease.whenUnhealthy.then(abort);
    const credential = restoreTelegramTestCredential(
      lease.payload,
      path.join(privateRoot, "credential"),
    );
    const driverEnv = {
      PATH: process.env.PATH,
      HOME: privateRoot,
      TELEGRAM_USER_DRIVER_TDLIB_PATH: ready.tdlib,
      TELEGRAM_PROOF_AUTHORITY_FILE: authorityFile,
      TELEGRAM_PROOF_PARENT_PID: String(process.pid),
      ...credential.driverEnv,
    };
    stage = "leased-identity-validation";
    const status = await execute(
      "python3",
      [path.join(skill, "user-driver.py"), "status", "--json"],
      { env: driverEnv, timeout: 120_000, maxBuffer: 65536, signal: aborted.signal },
    );
    const user = z
      .object({
        ok: z.literal(true),
        authorized: z.literal(true),
        testDc: z.literal(true),
        tdlibVersion: z.literal("1.8.67"),
        user: z.object({ id: z.number().int().safe().positive() }),
      })
      .parse(JSON.parse(status.stdout));
    if (String(user.user.id) !== credential.testerUserId) {
      throw new Error("Tester does not match lease");
    }
    const socket = path.join(privateRoot, "proxy.sock");
    ingress = await startTelegramProofIngress({
      socket,
      alias,
      sutToken: credential.sutToken,
      testerId: credential.testerUserId,
      plan,
      providerLog: path.join(privateRoot, "provider.ndjson"),
      lease: {
        assertHealthy: ensureAuthority,
        whenUnhealthy: Promise.race([
          lease.whenUnhealthy,
          new Promise<Error>((resolve) => {
            aborted.signal.addEventListener(
              "abort",
              () => resolve(new Error("Original review ended")),
              { once: true },
            );
          }),
        ]),
      },
    });
    await ingress.drainStaleUpdates();
    ingress.assertHealthy();
    await chmod(socket, 0o600);
    const restrictions = [
      "--network",
      network,
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "512",
      "--memory",
      "8g",
    ];
    bridgeId = (
      await podman([
        "create",
        "--name",
        bridge,
        ...restrictions,
        "--network-alias",
        "proof-bridge",
        "--read-only",
        "--mount",
        `type=bind,source=${socket},target=/bridge.sock`,
        "--mount",
        `type=bind,source=${path.resolve("scripts/mantis/telegram-proof-bridge.mjs")},target=/bridge.mjs,readonly`,
        bridgeImage,
        "node",
        "/bridge.mjs",
        "/bridge.sock",
      ])
    ).trim();
    // Capture the identity before startup can fail after creating the container.
    await podman(["start", bridgeId]);
    const config = telegramCandidateConfig(alias, credential.testerUserId, plan);
    const configPath = path.join(privateRoot, "candidate-config.json");
    await writeFile(configPath, JSON.stringify(config), { mode: 0o644 });
    // The controller's private umask must not make this alias-only config root-only.
    await chmod(configPath, 0o644);
    boxAttempted = true;
    quiescent = false;
    // Podman normalizes Config.Image to a canonical tag; Crabbox validates that
    // field literally. Bind a private tag to the immutable image before creation,
    // then verify the created container's immutable image before Gateway startup.
    assertPodmanProofStorage();
    const tagged = imageInfo.parse(
      JSON.parse(await podman(["image", "inspect", ready.imageTag])),
    )[0];
    assertProofImage(ready.imageId, tagged?.Id ?? "");
    await box([
      "warmup",
      "--provider",
      "local-container",
      "--lease-id",
      boxId,
      "--local-container-runtime",
      "podman",
      "--local-container-image",
      ready.imageTag,
      "--local-container-network",
      network,
      "--local-container-docker-socket=false",
      "--local-container-memory",
      "8g",
      "--local-container-cpus",
      "2",
      "--local-container-work-root",
      "/work/crabbox",
      "--ttl",
      "15m",
      "--idle-timeout",
      "5m",
      "--timing-json",
    ]);
    const containers = (
      await podman(["ps", "-a", "--filter", `label=lease=${boxId}`, "--format", "{{.ID}}"])
    )
      .trim()
      .split("\n")
      .filter(Boolean);
    if (containers.length !== 1) {
      throw new Error("Crabbox candidate identity is ambiguous");
    }
    sutId = containers[0]!;
    const sutMeta = JSON.parse(await podman(["inspect", sutId]))[0];
    assertProofImage(ready.imageId, String(sutMeta.Image));
    const bootstrapRoot = path.resolve(sutMeta.Config.Labels.bootstrap_dir ?? "");
    if (
      Object.keys(sutMeta.NetworkSettings.Networks).join(",") !== network ||
      sutMeta.Config.Labels.lease !== boxId ||
      sutMeta.Config.Labels.docker_socket !== "0" ||
      !bootstrapRoot.startsWith(boxRoot + path.sep) ||
      (sutMeta.Mounts ?? []).some(
        (mount: { Type: string; Source: string; Destination: string; RW: boolean }) =>
          mount.Type !== "bind" ||
          mount.Source !== bootstrapRoot ||
          mount.Destination !== "/tmp/crabbox-bootstrap" ||
          mount.RW,
      )
    ) {
      throw new Error("Crabbox candidate isolation mismatch");
    }
    await podman(["cp", configPath, `${sutId}:/candidate-config.json`]);
    candidateProcess = spawn(
      "crabbox",
      [
        "run",
        "--provider",
        "local-container",
        "--local-container-runtime",
        "podman",
        "--id",
        boxId,
        "--no-sync",
        "--no-hydrate",
        "--",
        "env",
        "OPENCLAW_STATE_DIR=/work/crabbox/state",
        "OPENCLAW_CONFIG_PATH=/candidate-config.json",
        "XDG_CACHE_HOME=/work/crabbox/cache",
        "node",
        "/candidate/dist/entry.js",
        "gateway",
        "--port",
        "19879",
      ],
      {
        cwd: boxRoot,
        env: boxEnv,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    candidateCliJoined = false;
    candidateClosed = new Promise((resolve) => {
      candidateProcess!.once("close", () => {
        candidateCliJoined = true;
        resolve();
      });
    });
    let candidateLogBytes = 0;
    const candidateLogs: Buffer[] = [];
    for (const stream of [candidateProcess.stdout, candidateProcess.stderr]) {
      stream?.on("data", (chunk: Buffer) => {
        candidateLogBytes += chunk.length;
        if (candidateLogBytes > 1024 * 1024) {
          abort();
        } else {
          candidateLogs.push(Buffer.from(chunk));
        }
      });
    }
    candidateProcess.once("error", abort);
    candidateProcess.once("exit", () => {
      if (!stoppingSut) {
        abort();
      }
    });
    const until = Date.now() + 60_000;
    while (!ingress.isPolling()) {
      ensureActive();
      if (Date.now() > until) {
        throw new Error("Telegram channel did not begin polling");
      }
      await delay(100);
    }
    ensureActive();
    const scenario = path.join(privateRoot, "scenario.json");
    await writeFile(scenario, JSON.stringify({ actions: plan.actions }), { mode: 0o600 });
    const record = path.join(privateRoot, "events.ndjson"),
      summary = path.join(privateRoot, "summary.json"),
      peer = path.join(privateRoot, "ready.json");
    stage = "request-admission-before-send";
    await assertCurrentTelegramRequest(identity, admissionOptions);
    await refreshReview();
    ensureActive();
    ingress.armScenario();
    stage = "selected-test-server-scenario";
    recorder = spawn(
      "python3",
      [
        path.join(skill, "user-record.py"),
        "--proof-parent-pid",
        String(process.pid),
        "--proof-deadline-unix-ms",
        String(Date.now() + plan.maxDurationMs + 30_000),
        "--scenario",
        scenario,
        "--ready-file",
        peer,
        "--proof-dm-peer",
        "--seconds",
        String(plan.maxDurationMs / 1000),
        "--chat",
        `@${credential.sutUsername}`,
        "--record",
        record,
        "--output",
        summary,
      ],
      { env: driverEnv, stdio: ["ignore", "pipe", "pipe"], signal: aborted.signal },
    );
    let logBytes = 0;
    const chunks: Buffer[] = [];
    for (const stream of [recorder.stdout, recorder.stderr]) {
      stream?.on("data", (chunk: Buffer) => {
        logBytes += chunk.length;
        if (logBytes > 1024 * 1024) {
          aborted.abort();
        } else {
          chunks.push(Buffer.from(chunk));
        }
      });
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        aborted.abort();
        reject(new Error("Recorder deadline"));
      }, plan.maxDurationMs + 30_000);
      recorder?.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      recorder?.once("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve();
        } else {
          reject(new Error("Recorder incomplete"));
        }
      });
    });
    await writeFile(path.join(privateRoot, "recorder.log"), Buffer.concat(chunks), { mode: 0o600 });
    ensureActive();
    await writeFile(path.join(privateRoot, "gateway.log"), Buffer.concat(candidateLogs), {
      mode: 0o600,
    });
    await stopSut();
    ensureActive();
    const provider = ingress.providerCapture();
    const boundedRead = async (file: string, max: number) => {
      if ((await stat(file)).size > max) {
        throw new Error("Capture oversized");
      }
      return readFile(file, "utf8");
    };
    facts = normalizeTelegramCapture({
      identity,
      plan,
      salt,
      sutId: Number(credential.sutBotId),
      testerId: user.user.id,
      testDc: user.testDc,
      ready: JSON.parse(await boundedRead(peer, 8192)),
      summary: JSON.parse(await boundedRead(summary, 1024 * 1024)),
      raw: await boundedRead(record, 8 * 1024 * 1024),
      provider,
      privateValues: [
        credential.sutToken,
        credential.sutUsername,
        ...Object.values(credential.driverEnv),
      ],
      quiescent,
      leaseHealthy: true,
    });
  } catch (error) {
    primaryError = new TelegramProofStageError(stage, error);
  }
  const cleanupErrors: unknown[] = [];
  {
    const attempt = async (operation: () => Promise<unknown>) => {
      try {
        await operation();
        return true;
      } catch (error) {
        cleanupErrors.push(error);
        return false;
      }
    };
    const recorderExited = async (timeout: number) => {
      if (!recorder || recorder.exitCode !== null || recorder.signalCode !== null) {
        return true;
      }
      return new Promise<boolean>((resolve) => {
        const child = recorder;
        const finish = () => {
          clearTimeout(timer);
          resolve(true);
        };
        const timer = setTimeout(() => {
          child?.off("exit", finish);
          resolve(false);
        }, timeout);
        child?.once("exit", finish);
      });
    };
    if (recorder && recorder.exitCode === null && recorder.signalCode === null) {
      recorder.kill("SIGTERM");
      if (!(await recorderExited(2000))) {
        recorder.kill("SIGKILL");
        await recorderExited(2000);
      }
    }
    if (!quiescent) {
      try {
        await stopSut();
      } catch {
        /* Keep the lease unreleased below; never infer quiescence from a failed command. */
      }
    }
    const ingressClosed = await attempt(async () => {
      await ingress?.close();
    });
    if (boxAttempted && !quiescent) {
      await attempt(stopSut);
    }
    const currentBridgeId = bridgeId;
    if (currentBridgeId) {
      await attempt(() => podman(["rm", "--force", currentBridgeId]));
    }
    if (networkCreated) {
      await attempt(() => podman(["network", "rm", network]));
    }
    const recorderQuiescent = await recorderExited(1);
    if (quiescent && candidateCliJoined) {
      await attempt(() => rm(boxRoot, { recursive: true, force: true }));
    }
    const privateStateErased = await attempt(() =>
      rm(privateRoot, { recursive: true, force: true }),
    );
    if (lease && quiescent && ingressClosed && recorderQuiescent && privateStateErased) {
      const acquired = lease;
      if (await attempt(() => acquired.release())) {
        lease = undefined;
      }
    } else if (lease) {
      const acquired = lease;
      // Ingress and TDLib own revocation. An uncertain teardown never frees
      // an identity early; the unchanged broker's existing TTL reclaims it.
      await attempt(() => acquired.abandon());
    }
    process.off("SIGTERM", abort);
    process.off("SIGINT", abort);
    clearInterval(reviewTimer);
  }
  if (primaryError || cleanupErrors.length || lease) {
    const diagnostics = ingress?.getDiagnostics() ?? [];
    if (diagnostics.length) {
      await writeFile(
        path.join(output, "telegram-failure.json"),
        JSON.stringify(createTelegramFailureDiagnostic(identity, diagnostics)) + "\n",
        { mode: 0o600, flag: "wx" },
      );
    }
    throw new AggregateError(
      [primaryError, ...cleanupErrors].filter((error) => error !== undefined),
      lease
        ? "Telegram proof cleanup incomplete; leased identity was not released"
        : "Telegram proof failed",
    );
  }
  if (!facts) {
    throw new TelegramProofStageError("capture-finalization");
  }
  for (const [name, value] of Object.entries(facts)) {
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > 65536) {
      throw new Error("Public observation oversized");
    }
    await writeFile(path.join(output, name), text + "\n", { mode: 0o600, flag: "wx" });
  }
  console.log(
    "Telegram Test Server capture completed; only normalized public observations exported.",
  );
}
