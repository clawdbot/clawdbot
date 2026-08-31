import { spawn } from "node:child_process";

type WriterEvent = {
  event: "ready" | "progress" | "busy";
  commits: number;
  transaction: boolean;
};

export function startSqliteConcurrentWriter(
  databasePath: string,
  journal: "WAL" | "MEMORY",
  busyTimeoutMs = 30_000,
) {
  // Snapshot header reads close raw descriptors. A thread would share the
  // writer's POSIX locks with those reads; a separate process owns its locks.
  const child = spawn(
    process.execPath,
    [
      "--input-type=commonjs",
      "-e",
      `
        const { DatabaseSync } = require("node:sqlite");
        const database = new DatabaseSync(process.argv[1]);
        const journal = process.argv[2];
        const busyTimeoutMs = Number(process.argv[3]);
        database.exec("PRAGMA busy_timeout = " + busyTimeoutMs + "; PRAGMA journal_mode = " + journal);
        if (journal === "WAL") database.exec("PRAGMA wal_autocheckpoint = 0");
        const write = database.prepare(journal === "WAL"
          ? "INSERT INTO writes DEFAULT VALUES"
          : "UPDATE pair SET value = ? WHERE name = ?");
        let running = true;
        let progress = false;
        let commits = 0;
        let busyReported = false;
        process.on("message", (message) => {
          if (message === "stop") running = false;
          if (message === "progress") progress = true;
        });
        process.on("disconnect", () => { running = false; });
        function report(event) {
          if (process.connected) process.send({ event, commits, transaction: database.isTransaction });
        }
        function writeBatch() {
          if (!running) {
            database.close();
            if (process.connected) process.disconnect();
            return;
          }
          try {
            database.exec("BEGIN IMMEDIATE");
            if (journal === "WAL") {
              for (let index = 0; index < 32; index += 1) write.run();
            } else {
              write.run(commits + 1, "left");
              write.run(commits + 1, "right");
            }
            database.exec("COMMIT");
            commits += 1;
            if (commits === 1) report("ready");
            if (progress) { progress = false; report("progress"); }
          } catch (error) {
            // A reader can outlast busy_timeout. COMMIT BUSY leaves the
            // transaction active: abandon it before the next independent batch.
            if (database.isTransaction) database.exec("ROLLBACK");
            if (error.code !== "ERR_SQLITE_ERROR" || error.errcode !== 5) throw error;
            // Zero-wait contention can repeat every turn; one barrier must not flood IPC.
            if (!busyReported) {
              busyReported = true;
              report("busy");
            }
          }
          setImmediate(writeBatch);
        }
        writeBatch();
      `,
      databasePath,
      journal,
      String(busyTimeoutMs),
    ],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  const messages = new Map<WriterEvent["event"], WriterEvent>();
  const waiters = new Set<() => void>();
  let failure: Error | undefined;
  let stderr = "";
  let closed = false;
  let stopping = false;
  const wake = () => {
    for (const resolve of waiters) {
      resolve();
    }
    waiters.clear();
  };
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4000);
  });
  child.on("message", (message: WriterEvent) => {
    messages.set(message.event, message);
    wake();
  });
  child.on("error", (error) => {
    failure = error;
    wake();
  });
  // Record failure, rather than rejecting a detached lifetime Promise. Every
  // barrier and stop observes it, including errors after readiness.
  const exited = new Promise<void>((resolve) => {
    child.once("close", (code, signal) => {
      closed = true;
      if (code !== 0 || !stopping) {
        failure ??= new Error(`SQLite writer exited (${code ?? signal}): ${stderr}`);
      }
      wake();
      resolve();
    });
  });
  async function waitFor(event: WriterEvent["event"]): Promise<WriterEvent> {
    for (;;) {
      if (failure) {
        throw failure;
      }
      const message = messages.get(event);
      if (message) {
        messages.delete(event);
        return message;
      }
      if (closed) {
        throw new Error(`SQLite writer closed before ${event}`);
      }
      await new Promise<void>((resolve) => {
        waiters.add(resolve);
      });
    }
  }
  return {
    pid: child.pid,
    waitFor,
    async progress() {
      child.send("progress");
      return await waitFor("progress");
    },
    async stop() {
      if (!stopping && !closed && child.connected) {
        stopping = true;
        child.send("stop");
      }
      await exited;
      if (failure) {
        throw failure;
      }
    },
  };
}
