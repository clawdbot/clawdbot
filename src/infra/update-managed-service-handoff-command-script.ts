// Staged command execution owns its admission and output/IPC cleanup.
export const PARENT_EXIT_SHUTDOWN_RESERVE_MS = 30_000;
const HANDOFF_COMMAND_RUNNER_SCRIPT = String.raw`
await new Promise((resolve, reject) => {
  process.stdin.once("data", (decision) => {
    if (decision.toString() === "go") resolve();
    else reject(new Error("Managed handoff admission was refused"));
  });
  process.stdin.once("end", () => reject(new Error("Managed handoff admission was cancelled")));
});
`;

// Non-Node update launchers keep their existing exec handoff; only the installed
// Node CLI can retain IPC and request the private automatic-triage continuation.
const HANDOFF_EXEC_RUNNER_SCRIPT = String.raw`
const { spawn } = require("node:child_process");
process.stdin.once("data", (decision) => {
  if (decision.toString() !== "go") return;
  const argv = JSON.parse(process.argv[1]);
  if (process.platform !== "win32" && typeof process.execve === "function")
    process.execve(argv[0], argv, process.env);
  const child = spawn(argv[0], argv.slice(1), { env: process.env, stdio: "inherit" });
  child.once("error", () => {
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    process.exitCode = typeof code === "number" ? code : signal ? 1 : 0;
  });
});
`;

export const HANDOFF_COMMAND_SCRIPT = String.raw`
function killOwnedCommand(child) {
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      env: params.serviceManagerEnv, stdio: "ignore", windowsHide: true, timeout: 5000,
    });
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  }
  try { child.kill("SIGKILL"); } catch {}
}


async function runOwnedUpdateCommand(phase, commandArgv, timeoutMs, cwd = params.cwd) {
  const updaterChunks = [];
  let updaterBytes = 0;
  let outputOverflow = false;
  let outputFd;
  let timeout;
  let continuation;
  let stagedContinuation;
  let continuationCancelled = false;
  let triageAdmitted = false;
  let leaseWatch;
  let admissionDeadline;
  let outputDrainDeadline;
  try {
    outputFd = fs.openSync(params.logPath, "a", 0o600);
    const retainedIpc = Array.isArray(params.nodeExecArgv);
    const child = spawn(
      retainedIpc ? commandArgv[0] : process.execPath,
      retainedIpc
        ? [
            ...params.nodeExecArgv,
            "--import",
            ${JSON.stringify(`data:text/javascript,${encodeURIComponent(HANDOFF_COMMAND_RUNNER_SCRIPT)}`)},
            ...commandArgv.slice(1),
          ]
        : ["-e", ${JSON.stringify(HANDOFF_EXEC_RUNNER_SCRIPT)}, JSON.stringify(commandArgv)],
      {
        cwd,
        env:
          params.action === "triage"
            ? { ...process.env, NODE_DISABLE_COMPILE_CACHE: "1" }
            : process.env,
        detached: true,
        stdio: ["pipe", "pipe", outputFd, "ipc"],
      },
    );
    child.stdout.on("data", (chunk) => {
      try { fs.writeSync(outputFd, chunk); } catch {}
      updaterBytes += chunk.length;
      if (updaterBytes > 4 * 1024 * 1024) {
        outputOverflow = true;
        updaterChunks.length = 0;
      } else updaterChunks.push(chunk);
    });
    let childError;
    const exited = new Promise((resolve) => {
      const boundTriageOutputDrain = () => {
        if (params.action !== "triage" || outputDrainDeadline) return;
        const lease = managedUpdateLease;
        // The executor can finish before inherited stdout closes. Preserve ordinary
        // output draining, but never let it prevent the native owner's cleanup.
        outputDrainDeadline = setTimeout(() => {
          appendLog("automatic triage output drain did not settle; retaining an uncertain native cleanup claim. Inspect " + params.scopeUnit + " before retrying.");
          try { if (lease) leaseStore.revoke(lease, true); }
          catch (error) { appendLog("automatic triage cleanup uncertainty could not be recorded: " + String(error)); }
          stopTriageScope();
          // A stop request is not cgroup extinction. Close only our local handles;
          // the existing native lease reclaimer still requires verified emptiness.
          child.stdout.destroy();
          child.stdin.destroy();
          if (child.connected) child.disconnect();
          child.unref();
          resolve({
            code: child.exitCode,
            signal: child.signalCode,
            error: childError || new Error("automatic triage native cleanup remains unconfirmed"),
          });
        }, ${PARENT_EXIT_SHUTDOWN_RESERVE_MS});
      };
      child.once("error", (error) => { childError = error; });
      child.once("exit", boundTriageOutputDrain);
      child.once("disconnect", boundTriageOutputDrain);
      child.once("close", (code, signal) => {
        clearTimeout(outputDrainDeadline);
        resolve({ code, signal, error: childError });
      });
    });
    child.stdin.on("error", () => {});
    let runnerIdentity = managedUpdateLease?.payload;
    try {
      // Errors before the gate still own this runner and its pipe/IPC handles.
      await new Promise((resolve, reject) => child.once("spawn", resolve).once("error", reject));
      if (!bindManagedUpdateLeaseToProcess(child.pid)) {
        throw new Error("managed update runner lease binding failed");
      }
      runnerIdentity = managedUpdateLease.payload;
      child.once("disconnect", () => {
        if (stagedContinuation) {
          appendLog("automatic triage skipped: updater disconnected before committing its request");
          stagedContinuation = undefined;
        }
      });
      child.on("message", async (message) => {
        try {
          if (phase === "update" && message?.version === 2 &&
            message.type === "triage-request-cancel" && Object.keys(message).length === 2 &&
            !continuation) {
            stagedContinuation = undefined;
            continuationCancelled = true;
            appendLog("automatic triage request cancelled before handoff");
            return;
          }
          if (
            !message ||
            message.version !== 2 ||
            !hasManagedUpdateLease() ||
            managedUpdateLease.payload !== runnerIdentity ||
            child.exitCode !== null ||
            child.signalCode !== null
          ) {
            throw new Error("managed handoff child lost its current claim");
          }
          if (
            params.action === "triage" &&
            message.type === "triage-ready" &&
            !triageAdmitted &&
            Object.keys(message).length === 2
          ) {
            // Claim the one admission before awaiting native inspection; duplicate
            // messages cannot both pass the same current runner lease.
            triageAdmitted = true;
            const scope = await inspectTriageScope();
            if (
              !hasManagedUpdateLease() ||
              managedUpdateLease.payload !== runnerIdentity ||
              fs.readFileSync("/proc/" + child.pid + "/cgroup", "utf8").trim() !==
                "0::" + scope.ControlGroup
            ) {
              throw new Error("automatic triage executor lost its native placement");
            }
            if (!child.connected || child.exitCode !== null || child.signalCode !== null) throw new Error("automatic triage child disconnected");
            const admitted = leaseStore.activate(managedUpdateLease);
            if (!admitted) throw new Error("automatic triage activation lost its claim");
            managedUpdateLease = admitted;
            runnerIdentity = admitted.payload;
            clearTimeout(admissionDeadline);
            child.send(
              {
                type: "triage",
                version: 2,
                failure: params.failure,
                installRoot: params.updateLeaseKey,
                owner: managedUpdateLease.owner,
              },
              () => {},
            );
          } else if (
            phase === "update" &&
            message.type === "triage-request" &&
            !stagedContinuation && !continuation && !continuationCancelled &&
            Object.keys(message).length === 4 &&
            Array.isArray(message.commandArgv) &&
            (message.commandArgv.length === 3 ||
              (message.commandArgv.length === 5 && message.commandArgv[3] === "--update-result")) &&
            message.commandArgv.every((arg) => typeof arg === "string" && arg.length < 4096) &&
            message.commandArgv[2] === "triage" &&
            validTriageFailure(message.failure) &&
            message.failure.kind === "update" &&
            params.serviceRecovery?.kind === "systemd" &&
            Buffer.byteLength(JSON.stringify(message)) <= 16384
          ) {
            stagedContinuation = message;
            child.send({ type: "triage-queued", version: 2 }, () => {});
          } else if (phase === "update" && message.type === "triage-commit" &&
            Object.keys(message).length === 2 && stagedContinuation &&
            !continuation && !continuationCancelled) {
            // The same live updater transfers its request only after the queue ACK.
            // Never infer this decision from its exit code or disconnected IPC.
            continuation = stagedContinuation;
            stagedContinuation = undefined;
            // The updater stays alive until it receives this accepted transfer.
            child.send({ type: "triage-committed", version: 2 }, () => {});
          } else throw new Error("invalid or repeated managed handoff continuation");
        } catch (error) {
          if (!continuation) {
            stagedContinuation = undefined;
            continuationCancelled = true;
          }
          appendLog("automatic triage admission failed: " + String(error));
          if (params.action === "triage") stopTriageScope();
          else if (child.connected) child.send({ type: "triage-refused", version: 2 }, () => {});
        }
      });
      if (params.action === "triage") {
        admissionDeadline = setTimeout(() => {
          appendLog("installed candidate did not admit triage; run openclaw triage manually");
          stopTriageScope();
        }, 30000);
        leaseWatch = setInterval(() => {
          if (!hasManagedUpdateLease()) {
            clearInterval(leaseWatch);
            appendLog("automatic triage cancelled: lease lost or replaced");
            stopTriageScope();
          }
        }, 250);
      }
      // Sending the gate can start mutation even if its write callback fails.
      // From here, only the updater can authorize recovery of this installation.
      if (phase === "update") updaterStarted = true;
      if (timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          appendLog("verified recovery command exceeded its update timeout");
          killOwnedCommand(child);
        }, timeoutMs);
      }
      await new Promise((resolve, reject) => {
        child.stdin.once("error", reject);
        child.stdin.once("close", () => reject(new Error("managed update runner stdin closed")));
        child.once("exit", () =>
          reject(new Error("managed update runner exited before its gate")),
        );
        child.stdin.write("go", (error) => (error ? reject(error) : resolve()));
      });
      child.stdin.end();
    } catch (error) {
      // A rejected spawn has no signalable process, but still needs its close join.
      if (child.pid) killOwnedCommand(child);
      await exited;
      try {
        if (runnerIdentity) bindManagedUpdateLeaseToProcess(process.pid, runnerIdentity);
      } catch (rebindError) {
        appendLog("managed update runner cleanup could not rebind helper: " + String(rebindError));
      }
      throw error;
    }
    appendLog("managed update " + phase + " command pid=" + (child.pid || "unknown"));
    const exit = await exited;
    clearInterval(leaseWatch);
    clearTimeout(admissionDeadline);
    if (params.action !== "triage" && !bindManagedUpdateLeaseToProcess(process.pid, runnerIdentity)) {
      throw new Error("managed update command lease binding was lost");
    }
    if (exit.error) throw exit.error;
    appendLog(
      "managed update " + phase + " command exited code=" +
        (exit && exit.code !== null && exit.code !== undefined ? exit.code : "null") +
        " signal=" +
        (exit && exit.signal ? exit.signal : "null"),
    );
    if (params.action === "triage" && !triageAdmitted) {
      appendLog(
        "installed candidate cannot accept automatic triage; run openclaw triage manually",
      );
      process.exitCode = 1;
    }
    return { ...exit, continuation, updaterOutput: Buffer.concat(updaterChunks).toString(), outputOverflow };
  } finally {
    clearTimeout(timeout);
    clearTimeout(outputDrainDeadline);
    clearInterval(leaseWatch);
    clearTimeout(admissionDeadline);
    if (outputFd !== undefined) {
      try {
        fs.closeSync(outputFd);
      } catch {
        // Ignore close failures.
      }
    }
  }
}
`;
