// Starts and monitors SSH tunnels for remote gateway access.
import { spawn } from "node:child_process";
import net from "node:net";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { formatErrorMessage, isErrno } from "./errors.js";
import { parseStrictPositiveInteger } from "./parse-finite-number.js";
import { ensurePortAvailable, PortInUseError } from "./ports.js";

export type SshParsedTarget = {
  user?: string;
  host: string;
  port: number;
};

export type SshTunnel = {
  parsedTarget: SshParsedTarget;
  localPort: number;
  remotePort: number;
  pid: number | null;
  stderr: string[];
  stop: () => Promise<void>;
};

// Reject hosts that would corrupt the SSH HostName field or enable argument
// injection: a leading '-' becomes an ssh option, and a stray leading/trailing
// ':' (e.g. sliced from "host::22") produces an invalid HostName.
function isMalformedHost(host: string): boolean {
  return host.startsWith("-") || host.startsWith(":") || host.endsWith(":");
}

export function parseSshTarget(raw: string): SshParsedTarget | null {
  const trimmed = raw.trim().replace(/^ssh\s+/, "");
  if (!trimmed) {
    return null;
  }

  const [userPart, hostPart] = trimmed.includes("@")
    ? ((): [string | undefined, string] => {
        const idx = trimmed.indexOf("@");
        const user = trimmed.slice(0, idx).trim();
        const host = trimmed.slice(idx + 1).trim();
        return [user || undefined, host];
      })()
    : [undefined, trimmed];

  const colonIdx = hostPart.lastIndexOf(":");
  if (colonIdx > 0 && colonIdx < hostPart.length - 1) {
    const host = hostPart.slice(0, colonIdx).trim();
    const portRaw = hostPart.slice(colonIdx + 1).trim();
    const port = parseStrictPositiveInteger(portRaw);
    if (!host || port === undefined || port > 65535) {
      return null;
    }
    if (isMalformedHost(host)) {
      return null;
    }
    return { user: userPart, host, port };
  }

  if (!hostPart) {
    return null;
  }
  if (isMalformedHost(hostPart)) {
    return null;
  }
  return { user: userPart, host: hostPart, port: 22 };
}

async function pickEphemeralPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      server.close(() => {
        if (!addr || typeof addr === "string") {
          reject(new Error("failed to allocate a local port"));
          return;
        }
        resolve(addr.port);
      });
    });
  });
}

async function canConnectLocal(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(250, () => done(false));
  });
}

async function waitForLocalListener(port: number, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await canConnectLocal(port)) {
      return;
    }
    await new Promise((r) => {
      setTimeout(r, 50);
    });
  }
  throw new Error(`ssh tunnel did not start listening on localhost:${port}`);
}

export async function startSshPortForward(opts: {
  target: string;
  identity?: string;
  localPortPreferred: number;
  remotePort: number;
  timeoutMs: number;
}): Promise<SshTunnel> {
  const parsed = parseSshTarget(opts.target);
  if (!parsed) {
    throw new Error(`invalid SSH target: ${opts.target}`);
  }

  let localPort = opts.localPortPreferred;
  try {
    await ensurePortAvailable(localPort, "127.0.0.1");
  } catch (err) {
    if (err instanceof PortInUseError || (isErrno(err) && err.code === "EADDRINUSE")) {
      localPort = await pickEphemeralPort();
    } else {
      throw err;
    }
  }

  const userHost = parsed.user ? `${parsed.user}@${parsed.host}` : parsed.host;
  const args = [
    "-N",
    "-L",
    `127.0.0.1:${localPort}:127.0.0.1:${opts.remotePort}`,
    "-p",
    String(parsed.port),
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "UpdateHostKeys=yes",
    "-o",
    "ConnectTimeout=5",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
  ];
  if (opts.identity?.trim()) {
    args.push("-i", opts.identity.trim());
  }
  // Security: Use '--' to prevent userHost from being interpreted as an option
  args.push("--", userHost);

  const stderr: string[] = [];
  const child = spawn("/usr/bin/ssh", args, {
    stdio: ["ignore", "ignore", "pipe"],
  });
  const stderrStream = child.stderr;
  // Child events own tunnel failure. Keep the diagnostic pipe observed so a
  // stream error cannot become an uncaught exception during active use or teardown.
  stderrStream?.on("error", () => {});
  stderrStream?.setEncoding("utf8");
  stderrStream?.on("data", (chunk) => {
    const lines = normalizeStringEntries(String(chunk).split("\n"));
    stderr.push(...lines);
  });

  const stop = async () => {
    if (child.killed || !child.kill("SIGTERM")) {
      return;
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } finally {
          resolve();
        }
      }, 1500);
      child.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
  };

  try {
    await Promise.race([
      waitForLocalListener(localPort, Math.max(250, opts.timeoutMs)),
      new Promise<void>((_, reject) => {
        child.once("error", (err) => reject(err));
        child.once("exit", (code, signal) => {
          reject(new Error(`ssh exited (${code ?? "null"}${signal ? `/${signal}` : ""})`));
        });
      }),
    ]);
  } catch (err) {
    await stop();
    const suffix = stderr.length > 0 ? `\n${stderr.join("\n")}` : "";
    throw new Error(`${formatErrorMessage(err)}${suffix}`, { cause: err });
  }

  return {
    parsedTarget: parsed,
    localPort,
    remotePort: opts.remotePort,
    pid: typeof child.pid === "number" ? child.pid : null,
    stderr,
    stop,
  };
}
