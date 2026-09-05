#!/usr/bin/env node
// Trusted host controller; candidate gets no broker, TDLib, capture or host socket.
import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { z } from "zod";
import { acquireQaLease } from "../../.agents/skills/telegram-e2e-userbot/scripts/qa-credential-lease.mjs";
import { restoreTelegramTestCredential } from "../../.agents/skills/telegram-e2e-userbot/scripts/telegram-test-credential.mjs";
import { normalizeTelegramCapture } from "./telegram-capture.ts";
import { startTelegramProofIngress } from "./telegram-proof-ingress.mts";
import { telegramProofIdentitySchema, telegramProofPrompt } from "./telegram-request-proof.ts";
import { assertCurrentTelegramRequest } from "./telegram-run-admission.ts";

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
const acquireTelegramQaLease = acquireQaLease as unknown as (options: {
  kind: string;
  leaseTtlMs: number;
  quarantineOnExpiry: boolean;
  requestId: string;
}) => Promise<QaLease>;

function telegramCandidateConfig(alias: string, testerId: string) {
  return {
    gateway: {
      mode: "local",
      bind: "loopback",
      port: 19879,
      auth: { mode: "none" },
      controlUi: { enabled: false },
    },
    logging: { file: "/state/gateway.log" },
    agents: {
      defaults: { model: { primary: "openai/gpt-5.5" } },
      entries: { main: { workspace: "/state/workspace", model: { primary: "openai/gpt-5.5" } } },
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
        streaming: { mode: "off" },
        commands: { native: false, nativeSkills: false },
      },
    },
    messages: { ackReaction: "" },
  };
}
async function preflight(candidate: string, image: string) {
  if (!/^[a-f0-9]{40}$/.test(candidate) || !/^[a-z0-9][a-z0-9/.:@-]*$/.test(image)) {
    throw new Error("Invalid candidate/image selection");
  }
  const info = imageInfo.parse(JSON.parse(await podman(["image", "inspect", image])))[0];
  if (!info || info.Config.Labels["org.openclaw.mantis.candidate-sha"] !== candidate) {
    throw new Error("Prepared runtime does not match exact candidate");
  }
  await podman([
    "run",
    "--rm",
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
    if (validationId) {
      await podman(["rm", "--force", validationId]);
    }
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
  return { imageId: info.Id, tdlib };
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
  const admissionOptions = { token: process.env.GH_TOKEN ?? "" };
  await assertCurrentTelegramRequest(identity, admissionOptions).catch((error: unknown) => {
    throw new TelegramProofStageError("request-admission-before-lease", error);
  });
  if (!/^[a-z0-9][a-z0-9/.:@-]*$/.test(bridgeImage)) {
    throw new Error("Invalid trusted bridge image");
  }
  const output = path.resolve(outputArg);
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(output, { mode: 0o700 });
  const privateRoot = await mkdtemp(path.join(path.dirname(output), ".telegram-private-"));
  await chmod(privateRoot, 0o700);
  const nonce = randomBytes(32).toString("hex"),
    salt = randomBytes(32),
    alias = `1:${randomBytes(24).toString("base64url")}`;
  const network = `mantis-tg-${randomUUID()}`,
    sut = `mantis-tg-sut-${randomUUID()}`,
    bridge = `mantis-tg-bridge-${randomUUID()}`;
  let sutId: string | undefined,
    bridgeId: string | undefined,
    networkCreated = false,
    quiescent = true;
  let lease: QaLease | undefined;
  let ingress: Awaited<ReturnType<typeof startTelegramProofIngress>> | undefined;
  let recorder: ReturnType<typeof spawn> | undefined;
  const aborted = new AbortController(),
    abort = () => aborted.abort();
  process.once("SIGTERM", abort);
  process.once("SIGINT", abort);
  const ensureActive = () => {
    if (aborted.signal.aborted) {
      throw new Error("Proof aborted");
    }
    lease?.assertHealthy();
    ingress?.assertHealthy();
  };
  const stopSut = async () => {
    if (!sutId) {
      return;
    }
    await podman(["stop", "--time", "5", sutId]);
    const state = JSON.parse(await podman(["inspect", "--format", "{{json .State}}", sutId]));
    if (state.Running) {
      throw new Error("SUT quiescence not established");
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
    if (networks.length !== 1 || networks[0].internal !== true) {
      throw new Error("Candidate network is not internal");
    }
    // First broker call is after exact runtime and driver preparation.
    stage = "lease-acquisition";
    lease = await acquireTelegramQaLease({
      kind: "telegram-test-userbot",
      leaseTtlMs: 2 * 60 * 60_000,
      quarantineOnExpiry: true,
      requestId: identity.request_id,
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
      nonce,
      providerLog: path.join(privateRoot, "provider.ndjson"),
      lease,
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
        "run",
        "--detach",
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
    const config = telegramCandidateConfig(alias, credential.testerUserId);
    const configPath = path.join(privateRoot, "candidate-config.json");
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    sutId = (
      await podman([
        "create",
        "--name",
        sut,
        ...restrictions,
        "--read-only",
        "--tmpfs",
        "/state:rw,nosuid,nodev,size=1g",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,size=512m",
        "--env",
        "XDG_CACHE_HOME=/state/cache",
        "--env",
        "OPENCLAW_STATE_DIR=/state",
        "--env",
        "OPENCLAW_CONFIG_PATH=/candidate-config.json",
        ready.imageId,
        "node",
        "dist/entry.js",
        "gateway",
        "--port",
        "19879",
      ])
    ).trim();
    await podman(["cp", configPath, `${sutId}:/candidate-config.json`]);
    quiescent = false;
    await podman(["start", sutId]);
    const sutMeta = JSON.parse(await podman(["inspect", sutId]))[0];
    if (
      Object.keys(sutMeta.NetworkSettings.Networks).join(",") !== network ||
      (sutMeta.Mounts ?? []).some((mount: { Type: string }) => mount.Type === "bind")
    ) {
      throw new Error("Candidate isolation mismatch");
    }
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
    await writeFile(
      scenario,
      JSON.stringify({ actions: [{ type: "send", atMs: 0, text: telegramProofPrompt(nonce) }] }),
      { mode: 0o600 },
    );
    const record = path.join(privateRoot, "events.ndjson"),
      summary = path.join(privateRoot, "summary.json"),
      peer = path.join(privateRoot, "ready.json");
    stage = "request-admission-before-send";
    await assertCurrentTelegramRequest(identity, admissionOptions);
    ensureActive();
    ingress.armSingleSend();
    stage = "single-test-server-dm";
    recorder = spawn(
      "python3",
      [
        path.join(skill, "user-record.py"),
        "--scenario",
        scenario,
        "--ready-file",
        peer,
        "--proof-dm-peer",
        "--seconds",
        "60",
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
      }, 90_000);
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
    await stopSut();
    await writeFile(path.join(privateRoot, "gateway.log"), await podman(["logs", sutId]), {
      mode: 0o600,
    });
    ensureActive();
    const provider = ingress.providerCapture();
    if (!provider) {
      throw new Error("Provider evidence missing");
    }
    ingress.assertSingleSendComplete();
    const boundedRead = async (file: string, max: number) => {
      if ((await stat(file)).size > max) {
        throw new Error("Capture oversized");
      }
      return readFile(file, "utf8");
    };
    facts = normalizeTelegramCapture({
      identity,
      nonce,
      salt,
      sutId: Number(credential.sutBotId),
      testerId: user.user.id,
      testDc: user.testDc,
      ready: JSON.parse(await boundedRead(peer, 8192)),
      summary: JSON.parse(await boundedRead(summary, 1024 * 1024)),
      raw: await boundedRead(record, 8 * 1024 * 1024),
      provider,
      rejectedReply: ingress.rejectedReplyCapture(),
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
    const currentSutId = sutId;
    if (currentSutId && (await attempt(() => podman(["rm", "--force", currentSutId])))) {
      quiescent = true;
    }
    const currentBridgeId = bridgeId;
    if (currentBridgeId) {
      await attempt(() => podman(["rm", "--force", currentBridgeId]));
    }
    if (networkCreated) {
      await attempt(() => podman(["network", "rm", network]));
    }
    const recorderQuiescent = await recorderExited(1);
    const privateStateErased = await attempt(() =>
      rm(privateRoot, { recursive: true, force: true }),
    );
    if (lease && quiescent && ingressClosed && recorderQuiescent && privateStateErased) {
      const acquired = lease;
      if (await attempt(() => acquired.release())) {
        lease = undefined;
      } else if (await attempt(() => acquired.quarantine())) {
        lease = undefined;
      }
    } else if (lease) {
      const acquired = lease;
      if (await attempt(() => acquired.quarantine())) {
        lease = undefined;
      }
    }
    process.off("SIGTERM", abort);
    process.off("SIGINT", abort);
  }
  if (primaryError || cleanupErrors.length || lease) {
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
    if (Buffer.byteLength(text) > 8192) {
      throw new Error("Public observation oversized");
    }
    await writeFile(path.join(output, name), text + "\n", { mode: 0o600, flag: "wx" });
  }
  console.log(
    "Telegram Test Server capture completed; only normalized public observations exported.",
  );
}
