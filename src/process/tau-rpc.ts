import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";

type TauRpcOptions = {
  argv: string[];
  cwd?: string;
  timeoutMs: number;
};

type TauRpcResult = { stdout: string; stderr: string; code: number };

class TauRpcClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private rl: readline.Interface | null = null;
  private stderr = "";
  private buffer: string[] = [];
  private pending:
    | {
        resolve: (r: TauRpcResult) => void;
        reject: (err: unknown) => void;
        timer: NodeJS.Timeout;
      }
    | undefined;

  constructor(private readonly argv: string[], private readonly cwd: string | undefined) {}

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
        this.pending.reject(new Error(`tau rpc exited (code=${code}, signal=${signal})`));
        clearTimeout(this.pending.timer);
        this.pending = undefined;
      }
      this.dispose();
    });
  }

  private handleLine(line: string) {
    if (!this.pending) return;
    this.buffer.push(line);
    // Finish on assistant message_end event to mirror parse logic in piSpec
    if (line.includes('"type":"message_end"') && line.includes('"role":"assistant"')) {
      const out = this.buffer.join("\n");
      clearTimeout(this.pending.timer);
      const pending = this.pending;
      this.pending = undefined;
      this.buffer = [];
      pending.resolve({ stdout: out, stderr: this.stderr, code: 0 });
    }
  }

  async prompt(prompt: string, timeoutMs: number): Promise<TauRpcResult> {
    this.ensureChild();
    if (this.pending) {
      throw new Error("tau rpc already handling a request");
    }
    const child = this.child!;
    await new Promise<void>((resolve, reject) => {
      const ok = child.stdin.write(
        JSON.stringify({
          type: "prompt",
          message: { role: "user", content: [{ type: "text", text: prompt }] },
        }) + "\n",
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
