import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";

const root = new URL(import.meta.url).searchParams.get("root");
const file = (name) => path.join(root, name);
const publish = (name, value) => {
  fs.writeFileSync(file(`${name}.tmp`), String(value));
  fs.renameSync(file(`${name}.tmp`), file(name));
};

if (process.argv[2] === root) {
  const spawn = childProcess.spawn;
  childProcess.spawn = (command, args, options) => {
    const child = spawn(command, args, {
      ...options,
      env: {
        ...options.env,
        NODE_OPTIONS: `${options.env.NODE_OPTIONS} --import=${JSON.stringify(import.meta.url)}`,
      },
    });
    publish("shim.pid", child.pid);
    return child;
  };
  // Release after every TERM listener and its microtasks run. An immediate KILL
  // loses the paused forwarding shim; a graceful owner lets it forward first.
  process.on("SIGTERM", () => {
    publish("term-received", process.pid);
    setImmediate(() => {
      for (const name of ["shim.pid", "worker.pid"]) {
        try {
          process.kill(Number(fs.readFileSync(file(name), "utf8")), "SIGCONT");
        } catch (error) {
          if (error.code !== "ESRCH") {
            throw error;
          }
        }
      }
    });
  });
} else {
  const write = fs.writeFileSync;
  fs.writeFileSync = (target, ...args) => {
    const result = write(target, ...args);
    if (target === file("receipt.json")) {
      // Stop at the actual worker receipt, before any test result or teardown.
      publish("worker.pid", process.pid);
      process.kill(process.pid, "SIGSTOP");
    }
    return result;
  };
}
syncBuiltinESMExports();
