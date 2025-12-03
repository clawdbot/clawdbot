import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import readline from "node:readline";

import { piSpec } from "../agents/pi.js";

type TauRpcOptions = {
  argv: string[];
  cwd?: string;
  timeoutMs: number;
};

type TauRpcResult = {
  stdout: string;
  stderr: string;
  code: number;
  signal?: NodeJS.Signals | null;
  killed?: boolean;
};

class TauRpcClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private rl: readline.Interface | null = null;
  private stderr = "";
  private buffer: string[] = [];
  private idleTimer: NodeJS.Timeout | null = null;
  private seenAssistantEnd = false;
  private readonly idleMs = 120;
  private pending:
    | {
        resolve: (r: TauRpcResult) => void;
        reject: (err: unknown) => void;
        timer: NodeJS.Timeout;
      }
    | undefined;

  constructor(
    private readonly argv: string[],
    private readonly cwd: string | undefined,
  ) {}

  private ensureChild() {
    if (this.child) return;
    this.child = spawn(this.argv[0], this.argv.slice(1), {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.rl = readline.createInterface({ input: this.child.stdout });
    this.rl.on("line", (line) => this.handleLine(line));
    this.child.stderr.on("data", (d) => {
      this.stderr += d.toString();
    });
    this.child.on("exit", (code, signal) => {
      if (this.pending) {
        this.pending.reject(
          new Error(`tau rpc exited (code=${code}, signal=${signal})`),
        );
        clearTimeout(this.pending.timer);
        this.pending = undefined;
      }
      this.dispose();
    });
  }

  private handleLine(line: string) {
    if (!this.pending) return;
    this.buffer.push(line);
    // Streamed JSON arrives line-by-line; mark when an assistant message finishes
    // and resolve after a short idle to capture any follow-up events (e.g. tools)
    // that belong to the same turn.
    if (
      line.includes('"type":"message_end"') &&
      line.includes('"role":"assistant"')
    ) {
      this.seenAssistantEnd = true;
    }

    if (this.seenAssistantEnd) {
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => {
        if (!this.pending) return;
        const out = this.buffer.join("\n");
        // Only resolve once we have at least one assistant text payload; otherwise keep waiting.
        const parsed = piSpec.parseOutput(out);
        if (parsed.texts && parsed.texts.length > 0) {
          const pending = this.pending;
          this.pending = undefined;
          this.buffer = [];
          this.seenAssistantEnd = false;
          clearTimeout(pending.timer);
          pending.resolve({ stdout: out, stderr: this.stderr, code: 0 });
          return;
        }
        // No assistant text yet; wait for more lines.
      }, this.idleMs); // small idle window to group streaming blocks
    }
  }

  async prompt(prompt: string, timeoutMs: number): Promise<TauRpcResult> {
    this.ensureChild();
    if (this.pending) {
      throw new Error("tau rpc already handling a request");
    }
    const child = this.child;
    if (!child) throw new Error("tau rpc child not initialized");
    await new Promise<void>((resolve, reject) => {
      const ok = child.stdin.write(
        `${JSON.stringify({
          type: "prompt",
          message: { role: "user", content: [{ type: "text", text: prompt }] },
        })}\n`,
        (err) => (err ? reject(err) : resolve()),
      );
      if (!ok) child.stdin.once("drain", () => resolve());
    });
    return await new Promise<TauRpcResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = undefined;
        reject(new Error(`tau rpc timed out after ${timeoutMs}ms`));
        child.kill("SIGKILL");
      }, timeoutMs);
      this.pending = { resolve, reject, timer };
    });
  }

  dispose() {
    this.rl?.close();
    this.rl = null;
    if (this.child && !this.child.killed) {
      this.child.kill("SIGKILL");
    }
    this.child = null;
    this.buffer = [];
    this.stderr = "";
  }
}

let singleton: { key: string; client: TauRpcClient } | undefined;

export async function runPiRpc(
  opts: TauRpcOptions & { prompt: string },
): Promise<TauRpcResult> {
  const key = `${opts.cwd ?? ""}|${opts.argv.join(" ")}`;
  if (!singleton || singleton.key !== key) {
    singleton?.client.dispose();
    singleton = { key, client: new TauRpcClient(opts.argv, opts.cwd) };
  }
  return singleton.client.prompt(opts.prompt, opts.timeoutMs);
}

export function resetPiRpc() {
  singleton?.client.dispose();
  singleton = undefined;
}
