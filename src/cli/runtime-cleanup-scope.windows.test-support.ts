import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  retainCliProcessJobUntilExit,
  withCliCommandCleanup,
  withCliProcessScope,
} from "./runtime-cleanup-scope.js";

const [role, ownership, inherited, requestedCode] = process.argv.slice(2);
const fixture = fileURLToPath(import.meta.url);
const args = [...process.execArgv, fixture];

if (role === "launcher") {
  const child = spawn(
    process.execPath,
    ["-e", "setTimeout(()=>process.exit(0),30000);process.send('ready');process.disconnect();"],
    { stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true, detached: true },
  );
  await once(child, "message");
  process.send?.({ descendantPid: child.pid }, () => process.exit(0));
} else if (role === "candidate") {
  const { default: koffi } = await import("koffi");
  const kernel32 = koffi.load("kernel32.dll");
  const currentProcess = kernel32.func("__stdcall", "GetCurrentProcess", "void *", []);
  const isProcessInJob = kernel32.func("__stdcall", "IsProcessInJob", "int32_t", [
    "void *",
    "void *",
    koffi.out(koffi.pointer("int32_t")),
  ]);
  const wasInJob = [0];
  if (!isProcessInJob(currentProcess(), null, wasInJob)) {
    throw new Error("Could not inspect inherited Job membership");
  }
  if (ownership === "borrowed") {
    await retainCliProcessJobUntilExit();
  } else {
    await withCliProcessScope(() =>
      withCliCommandCleanup(ownership === "gateway", retainCliProcessJobUntilExit),
    );
  }
  const launcher = spawn(process.execPath, [...args, "launcher"], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
    windowsHide: true,
  });
  const exited = once(launcher, "exit");
  const [message] = await once(launcher, "message");
  await exited;
  writeSync(
    1,
    `${JSON.stringify({ ...message, inheritedJob: wasInJob[0] === 1, launcherExited: true })}\n`,
  );
  process.exit(Number(requestedCode));
} else {
  if (inherited === "true") {
    await withCliProcessScope(retainCliProcessJobUntilExit);
  }
  const candidate = spawn(
    process.execPath,
    [...args, "candidate", ownership!, inherited!, requestedCode!],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  let stdout = "";
  let stderr = "";
  candidate.stdout.on("data", (chunk) => (stdout += String(chunk)));
  candidate.stderr.on("data", (chunk) => (stderr += String(chunk)));
  const [code, signal] = await once(candidate, "close");
  // Stay alive until the test observes descendant exit. Closing an inherited
  // outer Job first would mask a missing Job in the candidate.
  process.once("message", () => process.exit(0));
  process.send?.({ code, signal, stdout, stderr });
}
