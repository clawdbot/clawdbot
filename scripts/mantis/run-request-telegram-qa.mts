#!/usr/bin/env node
// One trusted catalog recipe, not candidate-supplied QA code or a live service.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { z } from "zod";
import { requestIdentitySchema } from "./request-proof.ts";
import { removeTelegramQaNetwork } from "./telegram-qa-cleanup.ts";
import {
  telegramQaExecutionSchema,
  telegramQaObservationsSchema,
  telegramQaResultSchema,
  telegramQaScenario,
} from "./telegram-qa-proof.ts";

const [
  candidate,
  outputArg,
  image = "localhost/mantis-telegram-runtime",
  harness = "localhost/mantis-telegram-proof",
] = process.argv.slice(2);
if (!outputArg || ![image, harness].every((name) => /^[a-z0-9][a-z0-9/.:@-]*$/.test(name))) {
  throw new Error(
    "Usage: run-request-telegram-qa.mts <sha> <fresh-output> [candidate-image] [trusted-image]",
  );
}
const identity = requestIdentitySchema.parse({
  request_id: process.env.REQUEST_ID,
  repository: { id: process.env.GITHUB_REPOSITORY_ID, full_name: process.env.GITHUB_REPOSITORY },
  pull_request: Number(process.env.TARGET_PR),
  candidate_sha: candidate,
  scenario: telegramQaScenario,
  workflow: {
    path: ".github/workflows/mantis-telegram-bot-e2e-proof.yml",
    sha: process.env.GITHUB_WORKFLOW_SHA,
  },
  harness: { sha: process.env.GITHUB_WORKFLOW_SHA },
  run: { id: process.env.GITHUB_RUN_ID, attempt: Number(process.env.GITHUB_RUN_ATTEMPT) },
});
const execute = promisify(execFile);
const podman = async (args: string[]) =>
  (await execute("podman", args, { timeout: 300_000, maxBuffer: 2 * 1024 * 1024 })).stdout;
const info = z
  .array(
    z.object({
      Id: z.string().regex(/^(?:sha256:)?[a-f0-9]{64}$/),
      Config: z.object({ Labels: z.record(z.string(), z.string()) }),
    }),
  )
  .length(1)
  .parse(JSON.parse(await podman(["image", "inspect", image])))[0]!;
if (info.Config.Labels["org.openclaw.mantis.candidate-sha"] !== candidate) {
  throw new Error("Candidate runtime identity mismatch");
}
const output = path.resolve(outputArg);
await mkdir(path.dirname(output), { recursive: true });
await mkdir(output);
const scratch = await mkdtemp(path.join(path.dirname(output), ".telegram-qa-"));
await chmod(scratch, 0o777);
const network = `mantis-qa-${randomUUID()}`,
  observer = `${network}-observer`,
  sut = `${network}-sut`;
const restrictions = [
  "--network",
  network,
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges",
  "--read-only",
  "--pids-limit",
  "512",
  "--memory",
  "8g",
  "--tmpfs",
  "/tmp:rw,nosuid,nodev,size=1g",
];
const errors: unknown[] = [];
let createdNetwork: string | undefined;
try {
  await podman(["network", "create", "--internal", network]);
  createdNetwork = network;
  const networks = JSON.parse(await podman(["network", "inspect", network]));
  if (networks.length !== 1 || networks[0].internal !== true) {
    throw new Error("Candidate network is not internal");
  }
  await podman([
    "run",
    "--detach",
    "--name",
    observer,
    ...restrictions,
    "--network-alias",
    "proof-observer",
    // Crabline's canonical recorder locks use the trusted image's root account
    // cache, not XDG_CACHE_HOME. Keep that owner-only scratch off the read-only
    // image; neither this mount nor its lock files is shared with the candidate.
    "--tmpfs",
    "/root/.cache:rw,nosuid,nodev,noexec,notmpcopyup,size=16m,mode=0700",
    // Canonical GatewayClient requires this existing explicit opt-in for the
    // private container hostname. Only this observer gets it; the network is
    // internal and the Gateway token is synthetic and unique to this run.
    "--env",
    "OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1",
    "--mount",
    `type=bind,source=${scratch},target=/out`,
    harness,
    "node",
    "--import",
    "tsx",
    "scripts/mantis/observe-request-telegram-qa.mts",
    "/out",
  ]);
  const configPath = path.join(scratch, "candidate-config.json");
  const until = Date.now() + 90_000;
  while (true) {
    try {
      JSON.parse(await readFile(configPath, "utf8"));
      break;
    } catch {
      if (Date.now() >= until) {
        throw new Error("Trusted QA observer did not prepare candidate config");
      }
      const state = JSON.parse(await podman(["inspect", "--format", "{{json .State}}", observer]));
      if (!state.Running) {
        throw new Error("Trusted QA observer exited before preparation");
      }
      await sleep(100);
    }
  }
  await podman([
    "create",
    "--name",
    sut,
    ...restrictions,
    "--network-alias",
    "proof-candidate",
    "--tmpfs",
    "/state:rw,nosuid,nodev,size=1g",
    "--env",
    "OPENCLAW_STATE_DIR=/state",
    "--env",
    "XDG_CACHE_HOME=/state/cache",
    "--env",
    "OPENCLAW_CONFIG_PATH=/candidate-config.json",
    info.Id,
    "sh",
    "-eu",
    "-c",
    "mkdir -p /state/state && cp /candidate-pairing.sqlite /state/state/openclaw.sqlite && exec node dist/entry.js gateway --port 19879",
  ]);
  await podman(["cp", configPath, `${sut}:/candidate-config.json`]);
  await podman([
    "cp",
    path.join(scratch, "candidate-pairing.sqlite"),
    `${sut}:/candidate-pairing.sqlite`,
  ]);
  const metadata = JSON.parse(await podman(["inspect", sut]))[0];
  if (
    (metadata.Mounts ?? []).some((mount: { Type: string }) => mount.Type === "bind") ||
    Object.keys(metadata.NetworkSettings.Networks).join(",") !== network
  ) {
    throw new Error("Candidate isolation mismatch");
  }
  await podman(["start", sut]);
  const observerExit = await podman(["wait", observer]);
  if (observerExit.trim() !== "0") {
    throw new Error("Trusted QA observer did not complete");
  }
  await podman(["stop", "--time", "5", sut]);
  const state = JSON.parse(await podman(["inspect", "--format", "{{json .State}}", sut]));
  if (state.Running) {
    throw new Error("Candidate quiescence is unconfirmed");
  }
  telegramQaResultSchema.parse(
    JSON.parse(await readFile(path.join(scratch, "qa-result.json"), "utf8")),
  );
  telegramQaObservationsSchema.parse(
    JSON.parse(await readFile(path.join(scratch, "qa-observations.json"), "utf8")),
  );
  const execution = telegramQaExecutionSchema.parse({
    schema: "mantis.telegram-qa-execution.v1",
    request_id: identity.request_id,
    candidate_sha: identity.candidate_sha,
    harness_sha: identity.harness.sha,
    run_id: identity.run.id,
    run_attempt: identity.run.attempt,
    scenario: telegramQaScenario,
    transport: "Crabline",
    live_service: false,
    candidate_quiescent: true,
  });
  await copyFile(path.join(scratch, "qa-result.json"), path.join(output, "qa-result.json"));
  await copyFile(
    path.join(scratch, "qa-observations.json"),
    path.join(output, "qa-observations.json"),
  );
  await writeFile(path.join(output, "qa-execution.json"), JSON.stringify(execution) + "\n", {
    flag: "wx",
  });
} catch (error) {
  errors.push(error);
} finally {
  for (const owned of [sut, observer]) {
    try {
      await podman(["rm", "--force", "--ignore", owned]);
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    await removeTelegramQaNetwork(podman, createdNetwork);
  } catch (error) {
    errors.push(error);
  }
  try {
    await rm(scratch, { recursive: true, force: true });
  } catch (error) {
    errors.push(error);
  }
}
if (errors.length) {
  throw new AggregateError(errors, "Requested QA execution or owned environment cleanup failed");
}
