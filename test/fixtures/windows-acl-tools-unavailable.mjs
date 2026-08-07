import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const WINDOWS_ACL_TOOLS = new Set(["icacls.exe", "powershell.exe", "whoami.exe"]);
const realExecFile = childProcess.execFile;
const missingToolPath = fileURLToPath(new URL("missing-windows-acl-tool.exe", import.meta.url));

function fixtureExecFile(command, ...args) {
  if (!WINDOWS_ACL_TOOLS.has(path.win32.basename(String(command)).toLowerCase())) {
    return realExecFile.call(this, command, ...args);
  }
  return realExecFile.call(this, missingToolPath, ...args);
}

Object.defineProperty(fixtureExecFile, promisify.custom, {
  value: function promisifiedExecFile(...args) {
    let child;
    const promise = new Promise((resolve, reject) => {
      child = fixtureExecFile(...args, (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      });
    });
    promise.child = child;
    return promise;
  },
  configurable: false,
  enumerable: false,
  writable: false,
});

childProcess.execFile = fixtureExecFile;
syncBuiltinESMExports();
