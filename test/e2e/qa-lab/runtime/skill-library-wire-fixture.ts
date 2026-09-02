// Real child Gateway and real WebSocket authentication; no handler/client authority injection.
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import type { HelloOk, ResponseFrame } from "../../../../packages/gateway-protocol/src/index.js";
import { PROTOCOL_VERSION } from "../../../../packages/gateway-protocol/src/index.js";
import type { SkillLibraryFile } from "../../../../packages/gateway-protocol/src/schema/skill-library.js";
import { VERSION } from "../../../../src/version.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../helpers/openclaw-test-instance.js";

export const SKILL_LIBRARY_ALICE = "alice@skills.example.invalid";
export const SKILL_LIBRARY_BOB = "bob@skills.example.invalid";
export const SKILL_LIBRARY_WRITER_SCOPES = ["operator.read", "operator.write"];

export function decodedSkillLibraryFiles(files: SkillLibraryFile[]) {
  return files
    .map((file) => ({
      path: file.path,
      bytes: Buffer.from(file.content, file.encoding === "base64" ? "base64" : "utf8").toString(
        "hex",
      ),
      executable: file.executable === true,
    }))
    .toSorted((a, b) => a.path.localeCompare(b.path));
}

class SkillLibraryWireError extends Error {
  constructor(readonly error: NonNullable<ResponseFrame["error"]>) {
    super(error.message);
  }
}

export class SkillLibraryWireClient {
  private readonly pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as ResponseFrame;
      if (frame.type !== "res") {
        return;
      }
      const pending = this.pending.get(frame.id);
      if (!pending) {
        return;
      }
      this.pending.delete(frame.id);
      clearTimeout(pending.timer);
      if (frame.ok) {
        pending.resolve(frame.payload);
      } else {
        pending.reject(
          frame.error
            ? new SkillLibraryWireError(frame.error)
            : new Error("RPC failed without an error"),
        );
      }
    });
    const rejectPending = (error: Error) => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
    };
    socket.on("error", rejectPending);
    socket.on("close", (code) => rejectPending(new Error(`Gateway socket closed (${code})`)));
  }

  static async connect(
    instance: OpenClawTestInstance,
    options: {
      email?: string;
      scopes?: string[];
      buildId?: string;
    } = {},
  ): Promise<{ client: SkillLibraryWireClient; hello: HelloOk }> {
    // This socket acts as a synthetic same-host proxy: an actual Upgrade request reaches
    // trusted-proxy auth with a non-loopback client address. Identity never enters RPC params.
    const origin = `http://127.0.0.1:${instance.port}`;
    const socket = new WebSocket(instance.url, {
      ...(options.email ? { origin } : {}),
      ...(options.email
        ? {
            headers: {
              "x-forwarded-user": options.email,
              "x-forwarded-for": "198.51.100.40",
              "x-forwarded-proto": "http",
              "x-forwarded-host": `127.0.0.1:${instance.port}`,
              "x-openclaw-scopes": (options.scopes ?? SKILL_LIBRARY_WRITER_SCOPES).join(","),
            },
          }
        : {}),
    });
    const client = new SkillLibraryWireClient(socket);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Gateway challenge timed out")), 30_000);
        const onMessage = (data: { toString(): string }) => {
          const frame = JSON.parse(data.toString()) as { event?: string };
          if (frame.event === "connect.challenge") {
            clearTimeout(timer);
            socket.off("message", onMessage);
            resolve();
          }
        };
        socket.on("message", onMessage);
        socket.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        socket.once("close", () => {
          clearTimeout(timer);
          reject(new Error("Gateway closed before challenge"));
        });
      });
      const hello = await client.request<HelloOk>("connect", {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: {
          id: options.email ? "openclaw-control-ui" : "gateway-client",
          version: VERSION,
          ...(options.buildId ? { buildId: options.buildId } : {}),
          platform: "web",
          mode: options.email ? "webchat" : "backend",
        },
        role: "operator",
        // Deliberately request admin: the proxy scope cap must determine effective authority.
        scopes: ["operator.admin", "operator.read", "operator.write", "operator.pairing"],
        ...(!options.email ? { auth: { password: instance.gatewayToken } } : {}),
      });
      return { client, hello };
    } catch (error) {
      socket.terminate();
      throw error;
    }
  }

  async request<T>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
    const id = randomUUID();
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      this.socket.send(JSON.stringify({ type: "req", id, method, params }));
    });
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) {
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => this.socket.terminate(), 2_000);
      this.socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.close();
    });
  }
}

export async function createSkillLibraryWireInstance(): Promise<OpenClawTestInstance> {
  const instance = await createOpenClawTestInstance({
    name: "skill-library-wire",
    startTimeoutMs: 120_000,
    env: {
      OPENCLAW_GATEWAY_TOKEN: undefined,
      OPENCLAW_GATEWAY_PASSWORD: undefined,
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      OPENCLAW_SKIP_CHANNELS: undefined,
      OPENCLAW_SKIP_PROVIDERS: undefined,
      VITEST: undefined,
      VITEST_POOL_ID: undefined,
      VITEST_WORKER_ID: undefined,
      NODE_ENV: undefined,
      CODEX_HOME: undefined,
      OPENAI_API_KEY: undefined,
      ANTHROPIC_API_KEY: undefined,
      OPENCLAW_BUILD_PRIVATE_QA: "1",
    },
  });
  await instance.state.writeConfig({
    gateway: {
      mode: "local",
      bind: "loopback",
      port: instance.port,
      trustedProxies: ["127.0.0.1", "::1"],
      auth: {
        mode: "trusted-proxy",
        password: instance.gatewayToken,
        identityScopes: {
          [SKILL_LIBRARY_ALICE]: ["operator.admin", "operator.read", "operator.write"],
          [SKILL_LIBRARY_BOB]: SKILL_LIBRARY_WRITER_SCOPES,
        },
        trustedProxy: {
          userHeader: "x-forwarded-user",
          allowLoopback: true,
          requiredHeaders: ["x-forwarded-proto", "x-forwarded-host"],
          allowUsers: [SKILL_LIBRARY_ALICE, SKILL_LIBRARY_BOB],
        },
      },
      controlUi: { enabled: false, allowedOrigins: [`http://127.0.0.1:${instance.port}`] },
    },
    agents: { defaults: { workspace: instance.state.workspaceDir } },
    plugins: { enabled: false },
  });
  return instance;
}
