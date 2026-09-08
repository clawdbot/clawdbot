import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const QUERY_TIMEOUT_MS = 1_000;
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_STDERR_CHARS = 16 * 1024;
const metadataPath = (root) => path.join(root, "census.json");

function assertLease(root, token) {
  if (fs.readFileSync(path.join(root, "lease"), "utf8") !== token) {
    throw new Error("Fixture census lease retired");
  }
}

function validatePids(pids) {
  if (!Array.isArray(pids) || pids.some((pid) => !Number.isSafeInteger(pid) || pid <= 0)) {
    throw new Error("Fixture census requires explicit positive PIDs");
  }
}

function observationsFor(pids, observations) {
  if (
    !Array.isArray(observations) ||
    observations.length !== pids.length ||
    observations.some(
      (entry, index) =>
        entry?.pid !== pids[index] ||
        typeof entry.alive !== "boolean" ||
        (!(typeof entry.creationTime === "string" && /^\d+$/.test(entry.creationTime)) &&
          !(entry.alive === false && entry.creationTime === null)),
    )
  ) {
    throw new Error("Fixture Windows process census returned invalid identities");
  }
  return new Map(observations.map((entry) => [entry.pid, entry]));
}

function readFrames(stream, receive, fail) {
  let buffered = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffered += chunk;
    try {
      if (Buffer.byteLength(buffered) > MAX_FRAME_BYTES) {
        throw new Error("Fixture census frame exceeded its bound");
      }
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        receive(JSON.parse(line));
      }
    } catch (error) {
      fail(error);
    }
  });
  stream.on("end", () => {
    if (buffered) fail(new Error("Truncated fixture census frame"));
  });
  stream.on("error", fail);
}

/** One supervisor owns Python, its streams, and the broker until final census. */
export function createWindowsProcessCensus({ root, token, onFailure }) {
  const child = spawn(
    "python",
    ["-I", "-S", fileURLToPath(new URL("./ci-windows-process-census.py", import.meta.url))],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let closing = false;
  let failure;
  let stderr = "";
  let stderrTruncated = false;
  let childResult;
  let sequence = 0;
  let initialized = false;
  let resolveReady, rejectReady;
  const pending = new Map();
  const sockets = new Map();
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void ready.catch(() => {});
  const diagnostics = () =>
    "Fixture Windows process census: " +
    JSON.stringify({
      error: failure?.message,
      errorCode: failure?.code,
      errno: failure?.errno,
      code: childResult?.code,
      signal: childResult?.signal,
      stderr,
      stderrTruncated,
    });
  const rejectPending = (error) => {
    rejectReady(error);
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  };
  const fail = (error) => {
    if (closing || failure) return;
    failure = error;
    rejectPending(error);
    for (const socket of sockets.keys()) socket.destroy(error);
    child.kill("SIGKILL");
    onFailure(new Error(diagnostics(), { cause: error }));
  };
  const childClosed = new Promise((resolve) => {
    child.once("close", (code, signal) => {
      childResult = { code, signal };
      fail(new Error("Census helper closed before retirement"));
      resolve();
    });
  });
  child.on("error", fail);
  child.stdin.on("error", fail);
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    // Drain the bounded traceback through child close; killing on its first chunk
    // can discard the native error and replace its exit status with SIGKILL.
    stderrTruncated ||= stderr.length + chunk.length > MAX_STDERR_CHARS;
    stderr = (stderr + chunk).slice(-MAX_STDERR_CHARS);
  });
  child.stderr.on("error", fail);
  readFrames(
    child.stdout,
    (message) => {
      if (closing || failure) return;
      if (stderr) throw new Error("Census helper wrote stderr");
      if (!initialized) {
        if (message?.ready !== true || Object.keys(message).length !== 1) {
          throw new Error("Invalid census helper readiness");
        }
        initialized = true;
        resolveReady();
        return;
      }
      const request = pending.get(message?.id);
      if (!request || Object.keys(message).length !== 2 || Date.now() >= request.deadline) {
        throw new Error("Late or mismatched census helper reply");
      }
      const observations = observationsFor(request.pids, message.observations);
      clearTimeout(request.timer);
      pending.delete(message.id);
      request.resolve(observations);
    },
    fail,
  );
  const read = (pids) => {
    validatePids(pids);
    if (closing || failure || !initialized) {
      return Promise.reject(failure ?? new Error("Census helper is not ready"));
    }
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error("Census query ETIMEDOUT")), QUERY_TIMEOUT_MS);
      pending.set(id, {
        pids: [...pids],
        resolve,
        reject,
        timer,
        deadline: Date.now() + QUERY_TIMEOUT_MS,
      });
      child.stdin.write(JSON.stringify({ id, pids }) + "\n", (error) => {
        if (error) fail(error);
      });
    }).then((observations) => {
      if (closing || failure) throw failure ?? new Error("Census owner retired");
      return observations;
    });
  };
  const server = net.createServer((socket) => {
    if (closing || failure) {
      socket.destroy();
      return;
    }
    const closed = new Promise((resolve) => socket.once("close", resolve));
    sockets.set(socket, closed);
    void closed.then(() => sockets.delete(socket));
    let received = false;
    readFrames(
      socket,
      (request) => {
        if (
          received ||
          closing ||
          failure ||
          request?.token !== token ||
          typeof request.id !== "string"
        ) {
          throw new Error("Invalid or retired census request");
        }
        received = true;
        assertLease(root, token);
        void read(request.pids)
          .then((observations) => {
            assertLease(root, token);
            if (socket.destroyed || closing || failure) return;
            socket.end(
              JSON.stringify({ id: request.id, observations: [...observations.values()] }) + "\n",
            );
          })
          .catch((error) => socket.destroy(error));
      },
      (error) => socket.destroy(error),
    );
    // Malformed clients cannot keep a broker stream alive through retirement.
    socket.on("error", () => {});
  });
  const listening = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  server.on("error", fail);
  const published = Promise.all([ready, listening]).then(() => {
    assertLease(root, token);
    if (closing || failure) throw failure ?? new Error("Census owner retired during startup");
    const endpoint = { token, port: server.address().port };
    const temporary = metadataPath(root) + ".tmp";
    fs.writeFileSync(temporary, JSON.stringify(endpoint));
    fs.renameSync(temporary, metadataPath(root));
  });
  void published.catch(() => {});
  let retirement;
  return {
    ready: published,
    read,
    diagnostics,
    close() {
      if (retirement) return retirement;
      closing = true;
      rejectPending(new Error("Census owner retired"));
      for (const socket of sockets.keys()) socket.destroy();
      child.stdin.destroy();
      child.kill("SIGKILL");
      retirement = Promise.all([
        childClosed,
        ...sockets.values(),
        listening.catch(() => {}).then(() => new Promise((resolve) => server.close(resolve))),
      ]).then(() => {
        fs.rmSync(metadataPath(root), { force: true });
      });
      return retirement;
    },
  };
}

/** Actors use the supervisor's sampler, never a fresh interpreter or cached PID identity. */
export async function requestWindowsProcessCensus(root, token, pids) {
  validatePids(pids);
  assertLease(root, token);
  const endpoint = JSON.parse(fs.readFileSync(metadataPath(root), "utf8"));
  if (
    endpoint.token !== token ||
    !Number.isInteger(endpoint.port) ||
    endpoint.port < 1 ||
    endpoint.port > 65535
  ) {
    throw new Error("Invalid fixture census endpoint");
  }
  const id = randomUUID();
  const socket = net.createConnection({ host: "127.0.0.1", port: endpoint.port });
  let observations;
  let failure;
  const deadline = Date.now() + QUERY_TIMEOUT_MS;
  const fail = (error) => {
    failure ??= error;
    socket.destroy();
  };
  const closed = new Promise((resolve, reject) => {
    socket.once("close", () => {
      if (failure || !observations)
        reject(failure ?? new Error("Census broker closed without a reply"));
      else resolve(observations);
    });
  });
  const timer = setTimeout(
    () => fail(new Error("Census broker query ETIMEDOUT")),
    QUERY_TIMEOUT_MS,
  );
  readFrames(
    socket,
    (message) => {
      if (
        observations ||
        failure ||
        message?.id !== id ||
        Object.keys(message).length !== 2 ||
        Date.now() >= deadline
      ) {
        throw new Error("Late or mismatched census broker reply");
      }
      observations = observationsFor(pids, message.observations);
    },
    fail,
  );
  socket.once("connect", () => {
    try {
      assertLease(root, token);
      socket.write(JSON.stringify({ id, token, pids }) + "\n");
    } catch (error) {
      fail(error);
    }
  });
  try {
    const result = await closed;
    if (Date.now() >= deadline) throw new Error("Census broker query ETIMEDOUT");
    assertLease(root, token);
    return result;
  } finally {
    clearTimeout(timer);
  }
}
