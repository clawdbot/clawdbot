// One staged helper for managed updates and revocable automatic triage.
import { MANAGED_SERVICE_UPDATE_UNSAFE_EXIT_CODE } from "./update-control-plane-sentinel.js";
import {
  HANDOFF_COMMAND_SCRIPT,
  PARENT_EXIT_SHUTDOWN_RESERVE_MS,
} from "./update-managed-service-handoff-command-script.js";
import { MANAGED_HANDOFF_RUNTIME_ENTRY } from "./update-managed-service-handoff-runtime-assets.js";
import {
  HANDOFF_SENTINEL_SCRIPT,
  HANDOFF_SENTINEL_STATE_SCRIPT,
} from "./update-managed-service-handoff-sentinel-script.js";
import { HANDOFF_SERVICE_SCRIPT } from "./update-managed-service-handoff-service-script.js";
const HANDOFF_READY_MARKER = "OPENCLAW_UPDATE_HANDOFF_READY\n";
const HANDOFF_BUSY_MARKER = "HANDOFF_BUSY ";
export const HANDOFF_SCRIPT = String.raw`
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const params = JSON.parse(fs.readFileSync(process.argv[2], "utf-8"));

function appendLog(line) {
  try {
    fs.mkdirSync(path.dirname(params.logPath), { recursive: true, mode: 0o700 });
    fs.appendFileSync(params.logPath, "[" + new Date().toISOString() + "] " + line + "\n", {
      mode: 0o600,
    });
  } catch {
    // Best effort only.
  }
}

const { createManagedHandoffLeaseRuntime } = require("./runtime/${MANAGED_HANDOFF_RUNTIME_ENTRY}");
const leaseStore = createManagedHandoffLeaseRuntime({
  databasePath: params.updateLeaseDatabasePath,
  serviceManagerEnv: params.serviceManagerEnv,
}, { warn: (message, metadata) => appendLog(message + " " + JSON.stringify(metadata)) });
const { isPidAlive, readProcessStartIdentity, properties: parseSystemdProperties, validFailure: validTriageFailure } = leaseStore;
let managedUpdateLease = null;
function initialTriageAction() {
  return { kind: "triage", phase: "reserved", lifetime: { kind: "native", unit: params.serviceRecovery.unit, scope: params.scopeUnit, placement: { kind: "pending" } } };
}
function acquireManagedUpdateLease() {
  const result = leaseStore.acquire(params.updateLeaseKey, params.updateLeaseOwner,
    params.action === "triage" ? initialTriageAction() : { kind: "update" }, params.triageTransition);
  if (result.kind === "acquired") {
    managedUpdateLease = result.lease;
    if (params.action === "triage") nativePlacement = result.lease;
  }
  return { acquired: result.kind === "acquired", owner: result.owner };
}
function bindManagedUpdateLeaseToProcess(pid, expectedPayload, action) {
  if (!managedUpdateLease || expectedPayload && managedUpdateLease.payload !== expectedPayload) return false;
  const next = leaseStore.bind(managedUpdateLease, pid, action);
  if (!next) return false;
  managedUpdateLease = next;
  return true;
}
function hasManagedUpdateLease() { return managedUpdateLease && leaseStore.owns(managedUpdateLease); }
function ownsManagedUpdateLease() { return hasManagedUpdateLease() && managedUpdateLease.executor.pid === process.pid; }
function releaseManagedUpdateLease() {
  const lease = managedUpdateLease;
  if (!lease) return;
  try {
    if (lease.action.kind === "triage") leaseStore.revoke(lease);
    else leaseStore.release(lease);
  } catch (error) { appendLog("managed handoff release failed: " + String(error)); }
  managedUpdateLease = null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanupSensitiveFiles() {
  for (const filePath of params.sensitivePaths || []) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      // Best effort only.
    }
  }
}

${HANDOFF_SENTINEL_SCRIPT}
${HANDOFF_SENTINEL_STATE_SCRIPT}
${HANDOFF_SERVICE_SCRIPT}${HANDOFF_COMMAND_SCRIPT}
async function collectUpdateFailureTriage() {
  try {
    if (!triageFailure || !ownsManagedUpdateLease()) return;
    // Diagnostic reads share this boundary so they cannot bypass terminal cleanup.
    captureFailedUpdateResult();
    appendLog("If triage is unavailable, run " + params.triageRecoveryCommand + " on the Gateway host.");
    // The helper and outer updater start from the same installation. Preserve
    // its complete export; absent exports have only the helper's observed failure.
    const recordedFailure = fs.existsSync(params.triageContextPath);
    if (recordedFailure) {
      appendLog("Saved update failure: " + params.triageContextPath);
      appendLog("Reuse this diagnostic context on the Gateway host: " + params.triageContextCommand);
    }
    const failure = recordedFailure
      ? JSON.parse(fs.readFileSync(params.triageContextPath, "utf8"))
      : { error: "Managed update failed: " + (triageFailure.payload?.stats?.reason || triageFailure.reason) };
    const recovery = typeof triageFailure.restored === "boolean"
      ? "Service recovery " + (triageFailure.restored ? "succeeded." : "failed.")
      : "Service recovery outcome was not recorded; inspect the handoff log before restarting.";
    failure.error = [failure.error, recovery].filter(Boolean).join("\n");
    // Keep the canonical export intact even when installed triage cannot start.
    // Only this private annotated input is removed with the helper's other files.
    fs.writeFileSync(params.triageInputPath, JSON.stringify(failure), { mode: 0o600, flag: "wx" });
    appendLog("starting diagnostic-only update triage after service recovery settled");
    const exit = await runOwnedUpdateCommand(
      "diagnostic",
      [...params.triageCommandArgv, "--update-result", params.triageInputPath],
      Math.min(params.recoveryTimeoutMs, 60_000),
    );
    appendLog(!exit.signal && exit.code === 0
      ? "update triage completed; diagnostic report is above"
      : "update triage could not complete; " + params.triageHint);
  } catch (error) {
    appendLog("update triage could not complete: " + String(error) + "; " + params.triageHint);
  }
}

let automaticRequested = false;

(async () => {
  if (
    !params.triageTransition &&
    (!Number.isInteger(params.parentPid) ||
      params.parentPid <= 0 ||
      typeof params.parentStartIdentity !== "string" ||
      !params.parentStartIdentity)
  ) {
    throw new Error("managed update parent process identity is unavailable");
  }
  if (
    !params.triageTransition &&
    isPidAlive(params.parentPid) &&
    readProcessStartIdentity(params.parentPid) !== params.parentStartIdentity
  ) {
    throw new Error("managed update parent process identity changed");
  }
  if (
    !["update", "triage"].includes(params.action) ||
    !Number.isFinite(params.parentExitTimeoutMs) ||
    params.parentExitTimeoutMs < 0 ||
    !Number.isFinite(params.parentExitDeadlineAt)
  ) {
    throw new Error("managed update parent exit deadline is unavailable");
  }
  const lease = acquireManagedUpdateLease();
  if (!lease.acquired) {
    appendLog("managed update handoff joined active owner=" + (lease.owner || "unknown"));
    cleanupSensitiveFiles();
    fs.writeSync(1, ${JSON.stringify(HANDOFF_BUSY_MARKER)} + (lease.owner || "") + "\n");
    await sleep(25);
    return;
  }
  let outcome = params.triageTransition ? "triage" : undefined;
  let wake;
  let deadlineExpired = false;
  const parentExitDeadline = setTimeout(() => {
    deadlineExpired = true;
    if (outcome !== "update" && outcome !== "triage") outcome = "restore";
    wake?.();
  }, params.parentExitTimeoutMs);
  try {
    if (params.action === "update" && params.runId) {
      // Load the ledger writer before READY and package replacement can remove its chunks.
      runLedger = await import(pathToFileURL(params.recoveryModulePath).href);
      for (const name of ["finishUpdateRun", "recordUpdateRunStep", "recordUpdateRunVerification"]) {
        if (typeof runLedger[name] !== "function") throw new Error("managed update ledger writer is unavailable");
      }
    }
    if (params.action === "triage") await admitTriageScope();
    if (!params.triageTransition) fs.writeSync(1, ${JSON.stringify(HANDOFF_READY_MARKER)});
    const commands = [];
    let input = "";
    let disconnected = false;
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      input += chunk;
      if (input.length > 64) return process.stdin.destroy();
      let newline;
      while ((newline = input.indexOf("\n")) >= 0) {
        if (commands.length >= 4) return process.stdin.destroy();
        commands.push(input.slice(0, newline));
        input = input.slice(newline + 1);
      }
      wake?.();
    });
    const onDisconnect = () => { disconnected = true; wake?.(); };
    process.stdin.once("end", onDisconnect).once("close", onDisconnect);
    const reply = (line) => fs.writeSync(1, line + "\n");
    let parked = false;
    let transferred = false;
    while (outcome !== "triage" && isPidAlive(params.parentPid)) {
      if (!ownsManagedUpdateLease())
        throw new Error("managed update lease no longer owns the helper");
      if (readProcessStartIdentity(params.parentPid) !== params.parentStartIdentity) {
        if (isPidAlive(params.parentPid))
          throw new Error("managed update parent process identity changed");
        await new Promise((resolve) => setImmediate(resolve));
        if (!commands.length) break;
      }
      if (deadlineExpired) {
        if (params.action === "triage") throw new Error("automatic triage admission expired");
        deadlineExpired = false;
        if (!parked) {
          await parkGatewayService();
          parked = true;
        }
        if (
          ownsManagedUpdateLease() &&
          readProcessStartIdentity(params.parentPid) === params.parentStartIdentity
        ) {
          try {
            process.kill(params.parentPid, "SIGKILL");
          } catch {}
        }
      }
      // The acknowledged initiating CLI reports its result before EOF commits parking.
      if (transferred && disconnected && !parked) {
        await parkGatewayService();
        parked = true;
        outcome = Date.now() < params.parentExitDeadlineAt ? "update" : "restore";
      }
      const command = commands.shift();
      if (command === "transfer" && params.action === "update" && !parked && !transferred) {
        transferred = true;
        reply("transferred");
      } else if (command === "commit" && params.action === "triage") {
        await inspectTriageScope();
        if (!ownsManagedUpdateLease()) throw new Error("automatic triage admission lost its lease");
        outcome = "triage";
        reply("committed");
        break;
      } else if (command === "park" && params.action !== "triage") {
        try {
          if (!parked) await parkGatewayService();
          parked = true;
          reply("parked");
        } catch (error) {
          appendLog("managed service parking failed: " + String(error));
          if (restorationArmed) {
            outcome = "restore";
            reply("restore-after-exit");
          } else {
            recordUpdateHandoffOutcome("managed-service-handoff-cancelled");
            reply("cancelled");
            return;
          }
        }
      } else if (command === "commit" && parked) {
        const restoring = outcome === "restore" || Date.now() >= params.parentExitDeadlineAt;
        outcome = restoring ? "restore" : "update";
        reply(restoring ? "restore-after-exit" : "committed");
      } else if (command === "cancel" || (disconnected && outcome !== "update")) {
        if (!restorationArmed) {
          if (params.action === "update")
            recordUpdateHandoffOutcome("managed-service-handoff-cancelled");
          if (command) reply("cancelled");
          return;
        }
        outcome = "restore";
        if (command) reply("restore-after-exit");
      } else if (command === "restore-commit" && outcome === "restore") {
        reply("committed");
      } else if (command) {
        throw new Error("invalid managed update control command");
      }
      await Promise.race([
        sleep(25),
        new Promise((resolve) => {
          wake = resolve;
        }),
      ]);
    }
    clearTimeout(parentExitDeadline);
    const stopped = pendingServiceStop ? await pendingServiceStop : null;
    if (stopped) runLedger?.recordUpdateRunStep(params.runId, {
      step: "service-stop", status: stopped.code === 0 || (params.serviceRecovery?.kind === "launchd" && isLaunchdNotLoaded(stopped)) ? "completed" : "failed", endedAtMs: Date.now(),
    });
    if (
      stopped &&
      stopped.code !== 0 &&
      params.serviceRecovery?.kind === "launchd" &&
      !isLaunchdNotLoaded(stopped)
    ) {
      throw new Error("launchctl bootout failed: " + stopped.stderr);
    }
    if (outcome !== "update" && outcome !== "triage") {
      if (restorationArmed) await restoreGatewayService("managed-service-handoff-cancelled");
      else if (params.action === "update")
        recordUpdateHandoffOutcome("managed-service-handoff-cancelled");
      return;
    }
    if (params.action !== "triage" && params.serviceRecovery?.kind === "systemd") {
      if (!stopped || stopped.code !== 0 || Date.now() >= params.parentExitDeadlineAt) {
        throw new Error("systemd stop failed or exceeded the parent-exit deadline");
      }
      const unit = params.serviceRecovery.unit;
      for (;;) {
        const current = await inspectSystemdService(unit, params.parentExitDeadlineAt);
        if (
          !current ||
          current.Id !== unit ||
          current.LoadState !== "loaded" ||
          Date.now() >= params.parentExitDeadlineAt
        ) {
          throw new Error("systemd service remained active or changed execution generation");
        }
        if (current.ActiveState === "inactive" && current.MainPID === "0") {
          const retainedIdentity =
            current.ExecMainStartTimestampMonotonic === parkedServiceGeneration &&
            current.InvocationID === parkedServiceInvocation;
          const clearedIdentity =
            current.ExecMainStartTimestampMonotonic === "0" && !current.InvocationID;
          if (!retainedIdentity && !clearedIdentity) {
            throw new Error("systemd service remained active or changed execution generation");
          }
          break;
        }
        if (
          current.ActiveState !== "deactivating" ||
          current.MainPID !== "0" ||
          current.ExecMainStartTimestampMonotonic !== parkedServiceGeneration ||
          current.InvocationID !== parkedServiceInvocation
        ) {
          throw new Error("systemd service remained active or changed execution generation");
        }
        // The exact stop job has completed; systemd may publish inactive a moment later.
        await sleep(Math.min(25, Math.max(0, params.parentExitDeadlineAt - Date.now())));
      }
    }
    if (params.serviceRecovery?.kind === "launchd") {
      const target = "gui/" + params.serviceRecovery.uid + "/" + params.serviceRecovery.label;
      const deadline = Date.now() + ${PARENT_EXIT_SHUTDOWN_RESERVE_MS};
      for (;;) {
        const result = await runServiceCommand("launchctl", ["print", target], undefined, deadline);
        if (result.code !== 0) {
          if (!isLaunchdNotLoaded(result))
            throw new Error("launchctl print failed: " + result.stderr);
          break;
        }
        if (Date.now() >= deadline)
          throw new Error("launchd service remained loaded after parent exit");
        await sleep(Math.min(500, Math.max(0, deadline - Date.now())));
      }
    }

    if (params.action === "update" && params.requester) {
      const { isManagedUpdateRequesterOwner } = await import(pathToFileURL(params.recoveryModulePath).href);
      if (!(await isManagedUpdateRequesterOwner(params.requester))) {
        throw Object.assign(new Error("owner_required: chat requester is no longer a configured command owner"), { code: "owner_required" });
      }
    }
    appendLog("starting managed update command: " + params.commandLabel);
    // Update inputs retain shell-relative paths; recovery keeps the durable helper cwd.
    const exit = await runOwnedUpdateCommand(params.action, params.commandArgv, undefined, params.action === "update" ? params.invocationCwd : params.cwd);
    if (params.action === "triage") {
      if (exit.signal || exit.code !== 0) process.exitCode = exit.code || 1;
      return;
    }
    automaticRequested = Boolean(exit.continuation);
    const { updaterOutput, outputOverflow } = exit;
    // Only this invocation's direct child result carries the producer decision.
    // Success may change install roots; only recovery requires the original root.
    // Sentinels and diagnostic exports never authorize activation.
    let result = null;
    try { if (!outputOverflow) result = JSON.parse(updaterOutput); } catch {}
    let resultRoot;
    try { resultRoot = fs.realpathSync(result?.root); } catch {}
    const reportedFailure = isFailedUpdateOutcome(result?.status, result?.reason);
    if (!exit.signal && exit.code === 0 && resultRoot && result?.status === "ok") {
      runOutcome = { status: "succeeded", after: result.after };
    } else if (resultRoot && ["error", "skipped"].includes(result?.status)) {
      runOutcome = { status: result.status === "error" ? "failed" : "skipped", reason: result.reason, after: result.after };
    }
    if (reportedFailure) triageFailure ??= { reason: result?.reason || "managed-service-handoff-failed" };
    if (exit.code === ${MANAGED_SERVICE_UPDATE_UNSAFE_EXIT_CODE}) {
      appendLog("managed update reported unsafe recovery; keep the gateway stopped until the installation is repaired and update succeeds");
      recordUpdateHandoffOutcome("managed-service-handoff-unsafe-recovery");
      process.exitCode = exit.code;
    } else if (!resultRoot || result?.status !== "ok" ||
      exit.signal || exit.code !== 0) {
      const childStatus = !exit.signal && resultRoot === params.updateLeaseKey && ["error", "skipped"].includes(result?.status) ? result.status : undefined;
      const recovery = childStatus ? result.recovery : null;
      const safe = !exit.signal && recovery?.serviceRestartSafe === true &&
        typeof recovery.version === "string" && recovery.version.trim() &&
        (recovery.buildId === undefined ? result.mode !== "git" :
          typeof recovery.buildId === "string" && recovery.buildId.trim() && recovery.buildId.length <= 96) &&
        ownsManagedUpdateLease();
      let restored = safe && recovery.service === "healthy";
      if (safe && recovery.service === undefined) {
        restored = await restoreGatewayService("managed-service-handoff-failed", recovery, childStatus);
      } else {
        if (restored && triageFailure) triageFailure.restored = true;
        appendLog("managed update recovery not attempted: " +
          (recovery?.serviceRestartSafe === false ? "updater explicitly rejected activation" :
            recovery?.service === "healthy" ? "updater already verified recovery" :
              recovery?.service === "failed" ? "updater recovery failed; no automatic retry" :
                "no verified recovery result; inspect the installation before restarting"));
        if (childStatus !== "skipped" || !restored) {
          recordUpdateHandoffOutcome("managed-service-handoff-failed", undefined, childStatus === "skipped" ? "error" : childStatus);
        }
      }
      process.exitCode = exit.code || (childStatus === "skipped" && restored && !exit.signal && !reportedFailure ? 0 : 1);
    }
    if (exit.continuation && !exit.signal) await enterTriageAfterUpdate(exit.continuation);
  } catch (err) {
    appendLog("handoff failed: " + (err && err.stack ? err.stack : String(err)));
    const reason = err?.code === "owner_required" ? "owner_required" : "managed-service-handoff-helper-failed";
    if (params.action === "update") runOutcome = { status: "failed", reason };
    if (hasManagedUpdateLease()) {
      if (params.action !== "triage") bindManagedUpdateLeaseToProcess(process.pid);
      if (restorationArmed && !updaterStarted) await restoreGatewayService(reason);
      else if (params.action === "update") recordUpdateHandoffOutcome(reason);
    }
    process.exitCode = 1;
  } finally {
    clearTimeout(parentExitDeadline);
    try { finishManagedUpdateRun(); }
    catch (error) {
      appendLog("failed to finalize update run: " + String(error));
      process.exitCode = 1;
    }
    if (params.action === "update" && !automaticRequested) await collectUpdateFailureTriage();
    releaseManagedUpdateLease();
    process.stdin.destroy();
    cleanupSensitiveFiles();
    stopTriageScope();
    appendLog("managed update helper completed code=" + (process.exitCode || 0));
  }
})().catch((err) => {
  appendLog("handoff setup failed: " + (err && err.stack ? err.stack : String(err)));
  cleanupSensitiveFiles();
  stopTriageScope();
  process.exitCode = 1;
});
`;
