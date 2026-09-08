import { randomUUID } from "node:crypto";
import type { CliBackendExecuteContext } from "openclaw/plugin-sdk/cli-backend";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { signalProcessTree } from "openclaw/plugin-sdk/process-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { createClaudeCliProcessOwner, type ClaudeCliSecretInput } from "./cli-process.js";

// Match the host's per-record JSONL budget, including large image/tool records.
const MAX_LINE_CHARS = 8 * 1024 * 1024;
// Leave room for process exit and Windows taskkill completion inside the host's 5s close budget.
const CLOSE_GRACE_MS = 500;
const KILL_GRACE_MS = 1_000;

/** One Claude Code subprocess and its bidirectional stream-json control channel. */
export function createClaudeCliTransport(params: {
  context: CliBackendExecuteContext;
  args: string[];
  initialize: Record<string, unknown>;
  currentContext: () => CliBackendExecuteContext | undefined;
  secretInput?: ClaudeCliSecretInput;
  onMessage: (message: Record<string, unknown>) => Promise<void>;
  onRequest: (request: Record<string, unknown>, signal: AbortSignal) => Promise<() => unknown>;
  onError: (error: unknown) => void;
}) {
  const owner = createClaudeCliProcessOwner(params.currentContext, params.secretInput);
  let child: ReturnType<typeof owner.spawn>;
  try {
    const env = { ...params.context.env };
    delete env.NODE_OPTIONS;
    delete env.DEBUG;
    child = owner.spawn({ ...params.context, args: params.args, env });
  } catch (error) {
    owner[Symbol.dispose]();
    throw error;
  }
  const requests = new Map<string, AbortController>();
  const initializeId = randomUUID();
  const { promise: ready, resolve: resolveReady, reject: rejectReady } = createDeferred<void>();
  // A child can fail before its caller reaches initialize().
  void ready.catch(() => {});
  let closed = false;
  let hasExited = false;
  let exitError: Error | undefined;
  let terminateTimer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const { promise: exited, resolve: resolveExit } = createDeferred<void>();
  let treeExit = Promise.resolve();
  const signalTree = (signal: "SIGTERM" | "SIGKILL") =>
    new Promise<void>((resolve) => {
      if (!child.pid) {
        resolve();
        return;
      }
      signalProcessTree(child.pid, signal, {
        detached: process.platform !== "win32",
        onComplete: resolve,
      });
    });
  const terminate = () => {
    treeExit = signalTree("SIGTERM");
    killTimer = setTimeout(() => {
      treeExit = signalTree("SIGKILL");
    }, KILL_GRACE_MS);
    killTimer.unref();
  };

  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    rejectReady(new Error("Claude CLI closed before initialization completed."));
    for (const controller of requests.values()) {
      controller.abort();
    }
    requests.clear();
    owner[Symbol.dispose]();
    if (process.platform === "win32" && !hasExited) {
      // /T without /F can fail, and EOF would then erase the root before escalation.
      // Force the owned tree while its root exists and await taskkill's completion.
      treeExit = signalTree("SIGKILL");
      void treeExit.then(() => child.stdin.end());
    } else {
      // On POSIX the private process group survives root exit. Let native flush on EOF first.
      child.stdin.end();
    }
    if (process.platform !== "win32" && !hasExited) {
      terminateTimer = setTimeout(terminate, CLOSE_GRACE_MS);
      terminateTimer.unref();
    }
  };
  const fail = async (error: unknown) => {
    if (closed) {
      return;
    }
    const diagnostic = await owner.withDiagnostics(error);
    if (!closed) {
      rejectReady(diagnostic);
      params.onError(diagnostic);
      close();
    }
  };
  const didExit = () => {
    if (hasExited) {
      return;
    }
    hasExited = true;
    clearTimeout(terminateTimer);
    clearTimeout(killTimer);
    // Descendants can hold pipes and process-owned resources after the root exits.
    if (process.platform !== "win32" || !closed) {
      treeExit = signalTree("SIGKILL");
    }
    resolveExit();
  };
  child.once("error", (error) => {
    exitError = error;
    if (!child.pid) {
      didExit();
    }
    void fail(error);
  });
  child.once("exit", (code, signal) => {
    if (code !== 0) {
      exitError = new Error(
        signal
          ? `Claude Code process exited with signal ${signal}`
          : `Claude Code process exited with code ${code}`,
      );
    }
    didExit();
  });
  child.stdin.on("error", (error) => {
    void fail(error);
  });

  const send = (message: Record<string, unknown>): Promise<void> => {
    if (closed) {
      return Promise.reject(new Error("Claude CLI control channel is closed."));
    }
    return new Promise((resolve, reject) => {
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  };
  const dispatch = async (id: string, request: Record<string, unknown>) => {
    // Redelivered in-flight requests must not open a second operator approval.
    if (requests.has(id)) {
      return;
    }
    const controller = new AbortController();
    requests.set(id, controller);
    try {
      let response: () => Record<string, unknown>;
      try {
        const reply = await params.onRequest(request, controller.signal);
        response = () => ({
          subtype: "success",
          request_id: id,
          response: reply(),
        });
      } catch {
        response = () => ({
          subtype: "error",
          request_id: id,
          error: "OpenClaw could not handle this Claude control request.",
        });
      }
      if (!closed) {
        await send({ type: "control_response", response: response() });
      }
    } finally {
      if (requests.get(id) === controller) {
        requests.delete(id);
      }
    }
  };
  const acceptLine = async (line: string) => {
    if (!line.trim()) {
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      // CLI launchers can emit plain diagnostics. Never echo native stdout in errors.
      return;
    }
    if (!isRecord(message)) {
      return;
    }
    if (message.type === "control_response") {
      const response = message.response;
      if (isRecord(response) && response.request_id === initializeId) {
        if (response.subtype === "success") {
          resolveReady();
        } else {
          throw new Error("Claude CLI initialization failed.");
        }
      }
    } else if (message.type === "control_request") {
      if (typeof message.request_id !== "string" || !isRecord(message.request)) {
        throw new Error("Claude CLI sent a malformed control request.");
      }
      // Permission callbacks can await the operator; keep reading cancellation and output.
      void dispatch(message.request_id, message.request).catch(fail);
    } else if (message.type === "control_cancel_request") {
      if (typeof message.request_id === "string") {
        requests.get(message.request_id)?.abort();
      }
    } else if (message.type !== "keep_alive") {
      await params.onMessage(message);
    }
  };
  const read = async () => {
    let pending = "";
    child.stdout.setEncoding("utf8");
    for await (const chunk of child.stdout) {
      const text = String(chunk);
      for (let offset = 0; offset < text.length;) {
        const newline = text.indexOf("\n", offset);
        const end = newline < 0 ? text.length : newline;
        if (pending.length + end - offset > MAX_LINE_CHARS) {
          throw new Error(`Claude CLI JSONL line exceeded ${MAX_LINE_CHARS} characters.`);
        }
        pending += text.slice(offset, end);
        offset = end + 1;
        if (newline >= 0) {
          const line = pending;
          pending = "";
          await acceptLine(line);
        }
      }
    }
    if (pending) {
      await acceptLine(pending);
    }
    await exited;
    if (!closed) {
      throw (
        exitError ??
        new Error("Claude CLI live session exited unexpectedly without a terminal result.")
      );
    }
  };
  void read().catch(fail);
  return {
    close,
    waitForExit: async () => {
      await exited;
      await treeExit;
    },
    send,
    async initialize() {
      await send({
        type: "control_request",
        request_id: initializeId,
        request: { subtype: "initialize", ...params.initialize },
      });
      await ready;
    },
  };
}
