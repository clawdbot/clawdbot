import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";

const WINDOWS_ACL_TOOLS = new Set(["icacls.exe", "powershell.exe", "whoami.exe"]);
const realExecFile = childProcess.execFile;

childProcess.execFile = function execFile(command, ...args) {
  if (!WINDOWS_ACL_TOOLS.has(path.win32.basename(String(command)).toLowerCase())) {
    return realExecFile.call(this, command, ...args);
  }

  const callback = args.findLast((value) => typeof value === "function");
  const error = Object.assign(new Error(`spawn ${command} ENOENT`), {
    code: "ENOENT",
    errno: -4058,
    path: command,
    syscall: `spawn ${command}`,
  });
  queueMicrotask(() => callback?.(error, "", ""));
  return undefined;
};

syncBuiltinESMExports();
