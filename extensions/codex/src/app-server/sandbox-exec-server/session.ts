/** Owns the JSON-RPC protocol and resources of one sandbox execution connection. */
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { JsonValue } from "../protocol.js";
import {
  closeAllFileReads,
  closeFile,
  copyPath,
  createDirectory,
  getMetadata,
  openFile,
  readDirectory,
  readFile,
  readFileBlock,
  removePath,
  writeFile,
  type CodexSandboxFileReadHandles,
} from "./filesystem.js";
import { httpRequest } from "./http.js";
import {
  JSON_RPC_METHOD_NOT_FOUND,
  JsonRpcProtocolError,
  sendError,
  sendResult,
} from "./json-rpc.js";
import { readProcess, startProcess, terminateProcess, writeProcess } from "./processes.js";
import type {
  CodexSandboxExecMessageTransport,
  CodexSandboxExecSessionNotifications,
  JsonRpcRequest,
  ManagedProcess,
  OpenClawExecServer,
} from "./types.js";

/** Connection-local execution state; closing it never enables session resumption. */
export class CodexSandboxExecSession {
  private readonly processes = new Map<string, ManagedProcess>();
  private readonly fileReads: CodexSandboxFileReadHandles = new Map();
  private readonly closeController = new AbortController();
  private readonly notifications: CodexSandboxExecSessionNotifications;
  private cleanup?: Promise<void>;

  constructor(
    private readonly execServer: OpenClawExecServer,
    private readonly transport: CodexSandboxExecMessageTransport,
  ) {
    this.notifications = {
      isOpen: transport.isOpen,
      signal: this.closeController.signal,
      send: (method, params) => {
        if (transport.isOpen()) {
          transport.send({ jsonrpc: "2.0", method, params });
        }
      },
    };
  }

  async handleRequest(request: JsonRpcRequest): Promise<void> {
    const method = request.method;
    if (!method) {
      sendError(this.transport.send, request.id, -32600, "Invalid Request");
      return;
    }
    if (request.id === undefined) {
      if (method !== "initialized") {
        sendError(this.transport.send, -1, -32600, `Unexpected notification: ${method}`);
      }
      return;
    }
    try {
      const result = await this.dispatchRequest(method, request.params);
      sendResult(this.transport.send, request.id, result);
    } catch (error) {
      sendError(
        this.transport.send,
        request.id,
        error instanceof JsonRpcProtocolError ? error.code : -32603,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  close(): Promise<void> {
    if (!this.cleanup) {
      // Abort streamed HTTP and file reservations before reaping connection-owned processes.
      this.closeController.abort();
      closeAllFileReads(this.fileReads);
      this.cleanup = Promise.all(
        [...this.processes.keys()].map(async (processId) =>
          terminateProcess(this.processes, { processId }),
        ),
      ).then(() => undefined);
    }
    return this.cleanup;
  }

  private async dispatchRequest(method: string, params?: JsonValue): Promise<JsonValue> {
    switch (method) {
      case "initialize":
        return { sessionId: randomUUID() };
      case "environment/info":
        // Shell and cwd describe the sandbox target, never the Gateway host.
        return {
          shell: { name: "sh", path: "/bin/sh" },
          cwd: pathToFileURL(this.execServer.sandbox.containerWorkdir, { windows: false }).href,
          capabilities: { networkProxyLaunch: false },
        };
      case "environment/status":
        return { status: "ready" };
      // Registered exec-server URLs use these process methods, not app-server process/spawn.
      case "process/start":
        return startProcess(this.execServer, this.processes, this.notifications.send, params);
      case "process/read":
        return await readProcess(this.processes, params);
      case "process/write":
        return writeProcess(this.processes, params);
      case "process/terminate":
        return await terminateProcess(this.processes, params);
      case "fs/open":
        return await openFile(this.execServer, this.fileReads, params);
      case "fs/readBlock":
        return readFileBlock(this.fileReads, params);
      case "fs/close":
        return closeFile(this.fileReads, params);
      case "fs/readFile":
        return await readFile(this.execServer, params);
      case "fs/writeFile":
        await writeFile(this.execServer, params);
        return {};
      case "fs/createDirectory":
        await createDirectory(this.execServer, params);
        return {};
      case "fs/getMetadata":
        return await getMetadata(this.execServer, params);
      case "fs/readDirectory":
        return await readDirectory(this.execServer, params);
      case "fs/remove":
        await removePath(this.execServer, params);
        return {};
      case "fs/copy":
        await copyPath(this.execServer, params);
        return {};
      case "http/request":
        return await httpRequest(this.execServer, this.notifications, params);
      default:
        throw new JsonRpcProtocolError(
          JSON_RPC_METHOD_NOT_FOUND,
          `Unsupported OpenClaw sandbox exec-server method: ${method}`,
        );
    }
  }
}
