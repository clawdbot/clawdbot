import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveEnvironmentValue } from "../../infra/process-env.js";
import { createWindowsOutputDecoder } from "../../infra/windows-encoding.js";
import { getWindowsCmdExePath } from "../../infra/windows-install-roots.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type {
  ServiceChildAnchorMessage,
  ServiceChildAnchorPayload,
  ServiceChildStart,
} from "./service-child-protocol.js";
import { createWindowsJobBindings } from "./service-child-windows-job-native.js";
import {
  buildWindowsJobEnvironmentBlock,
  isWindowsJobServiceStart,
} from "./service-child-windows-job-start.js";

type AnchorState = "starting" | "active" | "closing" | "closed";
type NativeHandle = bigint;
type WindowsJobBindings = ReturnType<typeof createWindowsJobBindings>;
type CommandStdio = ReturnType<WindowsJobBindings["createCommandStdio"]>;
type ClosingReason = Extract<ServiceChildAnchorMessage, { type: "closing" }>["reason"];
type OutputStream = {
  name: "stdout" | "stderr";
  handle?: NativeHandle;
  decoder?: ReturnType<typeof createWindowsOutputDecoder>;
  ended: boolean;
};

const JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION = 1;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
const STARTF_USESTDHANDLES = 0x0000_0100;
const CREATE_NEW_PROCESS_GROUP = 0x0000_0200;
const CREATE_UNICODE_ENVIRONMENT = 0x0000_0400;
const EXTENDED_STARTUPINFO_PRESENT = 0x0008_0000;
// Keep the noninteractive command console-free even when its anchor is detached.
const CREATE_NO_WINDOW = 0x0800_0000;
const WAIT_OBJECT_0 = 0;
const WAIT_TIMEOUT = 258;
const WAIT_FAILED = 0xffff_ffff;
const ERROR_BROKEN_PIPE = 109;
const IDLE_OBSERVATION_MS = 10;
const OUTPUT_BUFFER_BYTES = 64 * 1024;
const OUTPUT_ROUNDS_PER_TURN = 2;

function sendProcessMessage(message: ServiceChildAnchorMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.connected || !process.send) {
      reject(new Error("Windows Job anchor IPC is closed"));
      return;
    }
    process.send(message, (error) => (error ? reject(error) : resolve()));
  });
}

export function runServiceChildWindowsJobAnchor(): void {
  let start: ServiceChildStart | undefined;
  let state: AnchorState = "starting";
  let sequence = 0;
  let lastHostSequence = 0;
  let outboundQueue = Promise.resolve();
  let job: NativeHandle | undefined;
  let processHandle: NativeHandle | undefined;
  let bindings: WindowsJobBindings | undefined;
  let pendingCommandStdio: CommandStdio | undefined;
  let rootObserved = false;
  let extinctionProven = false;
  let terminationRequested = false;
  let closeReason: ClosingReason | undefined;
  let lifecycleTimer: NodeJS.Timeout | undefined;
  let lifecycleImmediate: NodeJS.Immediate | undefined;
  let lifecycleRunning = false;
  let lifecycleRerun = false;
  const outputStreams: OutputStream[] = [];
  const outputBuffer = Buffer.allocUnsafe(OUTPUT_BUFFER_BYTES);
  const startupErrorAcknowledged = createDeferredCore();
  const cleanupFinished = createDeferredCore();
  void cleanupFinished.promise.catch(() => {});

  const send = (payload: ServiceChildAnchorPayload): Promise<void> => {
    if (!start) {
      return Promise.reject(new Error("Windows Job anchor has not started"));
    }
    sequence += 1;
    const message: ServiceChildAnchorMessage = {
      ...payload,
      generation: start.generation,
      sequence,
    };
    const delivery = outboundQueue.then(() => sendProcessMessage(message));
    outboundQueue = delivery.catch(() => {});
    return delivery;
  };

  const deliver = async (payload: ServiceChildAnchorPayload): Promise<void> => {
    if (!process.connected) {
      if (!closeReason) {
        void requestCleanup("parent-lost");
      }
      return;
    }
    try {
      await send(payload);
    } catch (error) {
      if (process.connected) {
        throw error;
      }
      if (!closeReason) {
        void requestCleanup("parent-lost");
      }
    }
  };

  const stopLifecycle = () => {
    clearTimeout(lifecycleTimer);
    clearImmediate(lifecycleImmediate);
    lifecycleTimer = undefined;
    lifecycleImmediate = undefined;
  };

  const finishAnchor = (exitCode: number) => {
    stopLifecycle();
    process.exitCode = exitCode;
    if (process.connected) {
      process.disconnect?.();
    }
  };

  const closeOutputHandle = (stream: OutputStream) => {
    const handle = stream.handle;
    if (handle === undefined) {
      return;
    }
    if (!bindings) {
      throw new Error(`${stream.name} output bindings were not initialized`);
    }
    if (!bindings.CloseHandle(handle)) {
      throw bindings.lastError(`CloseHandle(${stream.name} pipe)`);
    }
    stream.handle = undefined;
  };

  const closeNativeHandles = () => {
    let closeError: Error | undefined;
    for (const stream of outputStreams) {
      try {
        closeOutputHandle(stream);
      } catch (error) {
        closeError ??= error instanceof Error ? error : new Error(coerceErrorMessage(error));
      }
    }
    for (const handle of [processHandle, job]) {
      if (handle !== undefined && bindings && !bindings.CloseHandle(handle)) {
        const error = bindings.lastError("CloseHandle");
        closeError ??= error;
      }
    }
    processHandle = undefined;
    job = undefined;
    if (closeError) {
      throw closeError;
    }
  };

  const closeAuthority = async (reason: ClosingReason) => {
    if (state === "closed") {
      return;
    }
    state = "closed";
    stopLifecycle();
    try {
      if (process.connected) {
        await send({ type: "closing", reason });
      }
      closeNativeHandles();
      cleanupFinished.resolve();
      finishAnchor(0);
    } catch (error) {
      try {
        closeNativeHandles();
      } catch {
        // Preserve the original delivery/close failure while KILL_ON_JOB_CLOSE still owns cleanup.
      }
      cleanupFinished.reject(error);
      finishAnchor(1);
    }
  };

  const failAuthority = async (error: unknown) => {
    if (state === "closed") {
      return;
    }
    state = "closed";
    stopLifecycle();
    try {
      if (process.connected && start) {
        await send({ type: "result-error", error: coerceErrorMessage(error) }).catch(() => {});
      }
      closeNativeHandles();
    } catch {
      // An owner failure never receives a closing receipt or claims unobserved extinction.
    } finally {
      cleanupFinished.reject(error);
      finishAnchor(1);
    }
  };

  const finishOutput = async (stream: OutputStream) => {
    if (stream.ended) {
      return;
    }
    closeOutputHandle(stream);
    stream.ended = true;
    const tail = stream.decoder?.flush();
    if (tail) {
      await deliver({ type: "output", stream: stream.name, chunk: tail });
    }
    await deliver({ type: "output-end", stream: stream.name });
  };

  const observeOutput = async (stream: OutputStream): Promise<boolean> => {
    if (stream.ended) {
      return false;
    }
    if (!bindings || stream.handle === undefined || !stream.decoder) {
      throw new Error(`${stream.name} output ownership was not initialized`);
    }
    const available = [0];
    if (!bindings.PeekNamedPipe(stream.handle, null, 0, null, available, null)) {
      const errorCode = bindings.getLastErrorCode();
      if (errorCode !== ERROR_BROKEN_PIPE) {
        throw new Error(`PeekNamedPipe(${stream.name}) failed (Win32 error ${errorCode})`);
      }
      await finishOutput(stream);
      return true;
    }
    const availableBytes = available[0];
    if (
      typeof availableBytes !== "number" ||
      !Number.isSafeInteger(availableBytes) ||
      availableBytes < 0
    ) {
      throw new Error(`PeekNamedPipe(${stream.name}) returned an invalid byte count`);
    }
    if (availableBytes === 0) {
      return false;
    }
    const requestedBytes = Math.min(availableBytes, outputBuffer.length);
    const bytesRead = [0];
    // This anchor owns the only read handle, so a read capped at the peeked bytes cannot block.
    if (!bindings.ReadFile(stream.handle, outputBuffer, requestedBytes, bytesRead, null)) {
      const errorCode = bindings.getLastErrorCode();
      if (errorCode !== ERROR_BROKEN_PIPE) {
        throw new Error(`ReadFile(${stream.name}) failed (Win32 error ${errorCode})`);
      }
      await finishOutput(stream);
      return true;
    }
    const count = bytesRead[0];
    if (
      typeof count !== "number" ||
      !Number.isSafeInteger(count) ||
      count < 0 ||
      count > requestedBytes
    ) {
      throw new Error(`ReadFile(${stream.name}) returned an invalid byte count`);
    }
    if (count === 0) {
      throw new Error(`ReadFile(${stream.name}) returned no available bytes`);
    }
    const text = stream.decoder.decode(outputBuffer.subarray(0, count));
    if (text) {
      await deliver({ type: "output", stream: stream.name, chunk: text });
    }
    return true;
  };

  const observeRoot = async (): Promise<boolean> => {
    if (rootObserved) {
      return false;
    }
    if (!bindings || !processHandle) {
      throw new Error("Windows root process ownership was not initialized");
    }
    const waitResult = bindings.WaitForSingleObject(processHandle, 0);
    if (waitResult === WAIT_TIMEOUT) {
      return false;
    }
    if (waitResult === WAIT_FAILED) {
      throw bindings.lastError("WaitForSingleObject(root)");
    }
    if (waitResult !== WAIT_OBJECT_0) {
      throw new Error(`WaitForSingleObject(root) returned unexpected result ${waitResult}`);
    }
    const exitCode = [0];
    if (!bindings.GetExitCodeProcess(processHandle, exitCode)) {
      throw bindings.lastError("GetExitCodeProcess");
    }
    const code = exitCode[0];
    if (typeof code !== "number" || !Number.isSafeInteger(code) || code < 0 || code > 0xffff_ffff) {
      throw new Error("GetExitCodeProcess returned an invalid exit code");
    }
    rootObserved = true;
    await deliver({ type: "root-result", code, signal: null });
    return true;
  };

  const observeJob = (): boolean => {
    if (extinctionProven) {
      return false;
    }
    if (!bindings || !job) {
      throw new Error("Windows Job ownership was not initialized");
    }
    const accounting: { ActiveProcesses?: unknown } = {};
    if (
      !bindings.QueryInformationJobObject(
        job,
        JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION,
        accounting,
        bindings.basicAccountingSize,
        null,
      )
    ) {
      throw bindings.lastError("QueryInformationJobObject");
    }
    const count = accounting.ActiveProcesses;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
      throw new Error("QueryInformationJobObject returned an invalid active process count");
    }
    extinctionProven = count === 0;
    return extinctionProven;
  };

  const runLifecycle = async () => {
    if (lifecycleRunning || state === "closed" || !processHandle) {
      lifecycleRerun ||= lifecycleRunning;
      return;
    }
    lifecycleRunning = true;
    let advanced = false;
    try {
      advanced = (await observeRoot()) || advanced;
      // The admitted root itself proves the Job is nonempty until its exact HANDLE signals.
      advanced = (rootObserved && observeJob()) || advanced;
      for (let round = 0; round < OUTPUT_ROUNDS_PER_TURN; round += 1) {
        let outputAdvanced = false;
        for (const stream of outputStreams) {
          outputAdvanced = (await observeOutput(stream)) || outputAdvanced;
        }
        advanced ||= outputAdvanced;
        if (!outputAdvanced) {
          break;
        }
      }
      if (extinctionProven && rootObserved && outputStreams.every((stream) => stream.ended)) {
        await closeAuthority(closeReason ?? "lineage-closed");
        return;
      }
    } catch (error) {
      await failAuthority(error);
      return;
    } finally {
      lifecycleRunning = false;
    }
    const immediate = advanced || lifecycleRerun;
    lifecycleRerun = false;
    scheduleLifecycle(immediate);
  };

  const scheduleLifecycle = (immediate: boolean) => {
    if (state === "closed" || !processHandle) {
      return;
    }
    if (lifecycleRunning) {
      lifecycleRerun ||= immediate;
      return;
    }
    if (immediate && lifecycleTimer) {
      clearTimeout(lifecycleTimer);
      lifecycleTimer = undefined;
    }
    if (lifecycleTimer || lifecycleImmediate) {
      return;
    }
    if (immediate) {
      lifecycleImmediate = setImmediate(() => {
        lifecycleImmediate = undefined;
        void runLifecycle();
      });
      return;
    }
    lifecycleTimer = setTimeout(() => {
      lifecycleTimer = undefined;
      void runLifecycle();
    }, IDLE_OBSERVATION_MS);
    // A disconnected IPC channel cannot retain Node; cleanup must retain its exact Job owner.
    if (state === "active" && process.connected) {
      lifecycleTimer.unref();
    }
  };

  const requestCleanup = (reason: "cancel" | "parent-lost" | "lineage-lost"): Promise<void> => {
    if (state === "closed") {
      return cleanupFinished.promise;
    }
    closeReason ??= reason;
    state = "closing";
    if (!processHandle) {
      void closeAuthority(reason);
      return cleanupFinished.promise;
    }
    if (!terminationRequested && !extinctionProven) {
      terminationRequested = true;
      if (!bindings || !job) {
        void failAuthority(new Error("Windows Job cleanup authority was not initialized"));
        return cleanupFinished.promise;
      }
      if (!bindings.TerminateJobObject(job, 1)) {
        const error = bindings.lastError("TerminateJobObject");
        void failAuthority(error);
        return cleanupFinished.promise;
      }
    }
    scheduleLifecycle(true);
    return cleanupFinished.promise;
  };

  const reportStartupError = async (error: unknown) => {
    if (!process.connected) {
      return;
    }
    await send({ type: "startup-error", error: coerceErrorMessage(error) });
    await startupErrorAcknowledged.promise;
  };

  const startCommand = async (next: ServiceChildStart) => {
    start = next;
    if (typeof next.windowsShellCommand !== "string") {
      state = "closed";
      finishAnchor(1);
      return;
    }
    try {
      const koffi = (await import("koffi")).default;
      if (state !== "starting") {
        return;
      }
      bindings = createWindowsJobBindings(koffi);
      bindings.assertLayouts();
      job = bindings.requireHandle(bindings.CreateJobObjectW(null, null), "CreateJobObjectW");
      if (
        !bindings.SetExtendedLimits(
          job,
          JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
          bindings.extendedLimits,
          bindings.extendedLimitsSize,
        )
      ) {
        throw bindings.lastError("SetInformationJobObject(KILL_ON_JOB_CLOSE)");
      }

      const commandStdio = bindings.createCommandStdio();
      pendingCommandStdio = commandStdio;
      let processAttributes:
        | ReturnType<WindowsJobBindings["createProcessAttributeList"]>
        | undefined;
      const processInfo: Record<string, unknown> = {};
      try {
        processAttributes = bindings.createProcessAttributeList(commandStdio.inheritedHandles, job);
        const shell =
          resolveEnvironmentValue(next.env, "COMSPEC", "win32") || getWindowsCmdExePath(next.env);
        const commandLine = Buffer.from(
          `"${shell}" /d /s /c "${next.windowsShellCommand}"\0`,
          "utf16le",
        );
        if (
          !bindings.CreateProcessW(
            shell,
            commandLine,
            null,
            null,
            1,
            CREATE_NEW_PROCESS_GROUP |
              CREATE_UNICODE_ENVIRONMENT |
              EXTENDED_STARTUPINFO_PRESENT |
              CREATE_NO_WINDOW,
            // NULL inherits; an explicitly empty environment must remain an empty block.
            next.env === undefined ? null : buildWindowsJobEnvironmentBlock(next.env),
            next.cwd ?? null,
            {
              StartupInfo: {
                cb: bindings.startupInfoExSize,
                dwFlags: STARTF_USESTDHANDLES,
                hStdInput: commandStdio.stdinHandle,
                hStdOutput: commandStdio.stdoutWriteHandle,
                hStdError: commandStdio.stderrWriteHandle,
              },
              lpAttributeList: processAttributes.attributeList,
            },
            processInfo,
          )
        ) {
          throw bindings.lastError("CreateProcessW(JOB_LIST)");
        }
        // JOB_LIST makes containment atomic: a successful root never exists outside its Job.
        processHandle = bindings.requireHandle(processInfo.hProcess, "CreateProcessW process");
        const threadHandle = bindings.requireHandle(processInfo.hThread, "CreateProcessW thread");
        if (!bindings.CloseHandle(threadHandle)) {
          throw bindings.lastError("CloseHandle(command thread)");
        }
      } finally {
        processAttributes?.release();
        pendingCommandStdio?.closeChildHandles();
      }

      const commandPid = Number(processInfo.dwProcessId);
      const handles = commandStdio.takeOutputReadHandles();
      // Admit both transferred HANDLEs before decoder construction can throw.
      outputStreams.push(
        { name: "stdout", handle: handles.stdoutReadHandle, ended: false },
        { name: "stderr", handle: handles.stderrReadHandle, ended: false },
      );
      for (const stream of outputStreams) {
        stream.decoder = createWindowsOutputDecoder();
      }

      state = "active";
      const readyDelivery = send({ type: "ready", commandPid, anchorPid: process.pid });
      // Queue ready before polling so an instantly exiting command cannot overtake admission.
      scheduleLifecycle(true);
      await readyDelivery;
    } catch (error) {
      if (state === "closed") {
        return;
      }
      if (state === "closing") {
        await cleanupFinished.promise.catch(() => {});
        return;
      }
      if (processHandle && outputStreams.some((stream) => !stream.decoder)) {
        for (const stream of outputStreams) {
          closeOutputHandle(stream);
          stream.ended = true;
        }
      }
      await reportStartupError(error);
      await (processHandle ? requestCleanup("lineage-lost") : closeAuthority("lineage-lost"));
    } finally {
      pendingCommandStdio?.close();
      pendingCommandStdio = undefined;
    }
  };

  process.once("disconnect", () => {
    startupErrorAcknowledged.resolve();
    if (!start) {
      state = "closed";
      process.exitCode = 1;
      return;
    }
    void requestCleanup("parent-lost");
  });
  process.once("SIGTERM", () => void requestCleanup("parent-lost"));
  process.once("SIGINT", () => void requestCleanup("parent-lost"));
  process.on("message", (raw: unknown) => {
    if (isWindowsJobServiceStart(raw) && start === undefined && state === "starting") {
      void startCommand(raw);
      return;
    }
    const message = asOptionalRecord(raw);
    if (
      !start ||
      state === "closed" ||
      !message ||
      (message.type !== "cancel" && message.type !== "startup-error-ack") ||
      typeof message.generation !== "string" ||
      typeof message.sequence !== "number" ||
      message.generation !== start.generation ||
      message.sequence <= lastHostSequence
    ) {
      if (start && state !== "closed") {
        void requestCleanup("lineage-lost");
      }
      return;
    }
    lastHostSequence = message.sequence;
    if (message.type === "startup-error-ack") {
      startupErrorAcknowledged.resolve();
    } else {
      void requestCleanup("cancel");
    }
  });
}

runServiceChildWindowsJobAnchor();
