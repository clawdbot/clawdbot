import { spawn } from "node:child_process";

type WriterEvent = {
  event: "ready" | "progress" | "busy" | "held";
  commits: number;
  transaction: boolean;
  values?: number[];
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
        let holdRequested = false;
        let held = false;
        function resume() {
          if (held) {
            held = false;
            setImmediate(writeBatch);
          }
        }
        process.on("message", (message) => {
          if (message === "hold") holdRequested = true;
          if (message === "stop") { running = false; resume(); }
          if (message === "progress") { progress = true; resume(); }
        });
        process.on("disconnect", () => { running = false; resume(); });
        function report(event) {
          if (process.connected) {
            const message = { event, commits, transaction: database.isTransaction };
            if (event === "held" && journal === "MEMORY") {
              message.values = database.prepare("SELECT value FROM pair ORDER BY name")
                .all().map((row) => row.value);
            }
            process.send(message);
          }
        }
        function writeBatch() {
          if (!running) {
            if (database.isTransaction) database.exec("ROLLBACK");
            database.close();
            if (process.connected) process.disconnect();
            return;
          }
          try {
            // A held partial batch resumes here without opening another transaction.
            if (!database.isTransaction) {
              database.exec("BEGIN IMMEDIATE");
              if (journal === "WAL") {
                for (let index = 0; index < 32; index += 1) write.run();
              } else {
                write.run(commits + 1, "left");
              }
              if (holdRequested) {
                holdRequested = false;
                held = true;
                report("held");
                return;
              }
            }
            if (journal === "MEMORY") write.run(commits + 1, "right");
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
    async holdTransaction() {
      child.send("hold");
      return await waitFor("held");
    },
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
