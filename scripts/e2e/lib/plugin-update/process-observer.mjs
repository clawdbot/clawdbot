import { once } from "node:events";
import fs from "node:fs";

function readProc(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    // Descendants can exit or deny ptrace access to environ. Neither is evidence
    // of a post-core handoff; keep scanning other descendants.
    if (["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(error.code)) {
      return null;
    }
    throw error;
  }
}

function descendants(pid, seen) {
  const children = readProc(`/proc/${pid}/task/${pid}/children`);
  for (const child of children?.trim().split(/\s+/).filter(Boolean) ?? []) {
    const argv = readProc(`/proc/${child}/cmdline`)?.split("\0").filter(Boolean);
    const postCore = argv
      ? (argv.includes("update") || argv[0] === "openclaw-update") &&
        (readProc(`/proc/${child}/environ`)?.split("\0").includes("OPENCLAW_UPDATE_POST_CORE=1") ??
          null)
      : null;
    const previous = seen.get(child);
    seen.set(child, {
      pid: child,
      // process.title overwrites Linux argv; retain previously observed arguments.
      argv: previous?.argv.includes("update") ? previous.argv : (argv ?? previous?.argv ?? []),
      postCore: previous?.postCore === true || postCore,
    });
    descendants(child, seen);
  }
}

export async function observePostCoreCommand(child, label) {
  const observed = new Map();
  let observationError;
  const observer = setInterval(() => {
    try {
      descendants(child.pid, observed);
    } catch (error) {
      observationError = error;
      clearInterval(observer);
    }
  }, 20);
  try {
    // The command runner still owns its timeout/cleanup. Join it before surfacing
    // observer failures so a timer cannot strand a running command or registry.
    const [code, signal] = await once(child, "exit");
    if (observationError) {
      throw new Error(`${label} observation failed after command exit ${code} (${signal})`, {
        cause: observationError,
      });
    }
    return { code, children: [...observed.values()] };
  } finally {
    clearInterval(observer);
  }
}
