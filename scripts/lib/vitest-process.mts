import { spawn, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { createTempDirTracker } from "../../test/helpers/temp-dir.ts";
import {
  resolveTestBrowserCache,
  resolveTestCorepackHome,
  readTestHomeSource,
  writeTestHomeSource,
} from "../../test/test-home-context.mts";
import {
  assertTestHomeSelection,
  LIVE_TEST_TRIGGER_ENV_KEYS,
  resolveTestHomePolicy,
  type TestHomeSelection,
} from "../../test/test-home-policy.mts";
import {
  createVitestProcessCompletion,
  shouldUseDetachedVitestProcessGroup,
} from "../vitest-process-group.mts";

/** Own temporary files until the Vitest child, its group, and its pipes have joined. */
export function spawnOwnedVitestProcess(spec: {
  command: string;
  args: string[];
  options: SpawnOptions;
  // Preparatory tools share lifetime ownership, but are not Vitest home consumers.
  homeMode?: TestHomeSelection | "tooling";
}) {
  const env = spec.options.env ?? process.env;
  const mode = spec.homeMode ?? "unknown";
  if (mode !== "tooling") {
    assertTestHomeSelection(env, mode);
  }
  const policy = resolveTestHomePolicy(env, mode === "tooling" ? "live-aware" : mode);
  const tempDirs = createTempDirTracker();
  const detached = spec.options.detached ?? shouldUseDetachedVitestProcessGroup();
  const verifiedGroup = detached && shouldUseDetachedVitestProcessGroup();
  const tempRoot = tempDirs.make(
    "oc-vt-",
    fs.realpathSync(env.TMPDIR || env.TMP || env.TEMP || tmpdir()),
  );
  let child;
  try {
    const childEnv: NodeJS.ProcessEnv = { ...env, TMPDIR: tempRoot, TMP: tempRoot, TEMP: tempRoot };
    if (mode !== "tooling" && !(policy.live && policy.allowRealHome)) {
      const nativeHome = path.join(tempRoot, "home");
      fs.mkdirSync(nativeHome);
      const callerHome = env.HOME ?? env.USERPROFILE ?? homedir();
      childEnv.COREPACK_HOME = resolveTestCorepackHome(env, callerHome);
      childEnv.PLAYWRIGHT_BROWSERS_PATH = resolveTestBrowserCache(env, callerHome);
      // Set the actual process environment before config imports and Worker creation.
      // Worker-local process.env and restored os.homedir mocks cannot retarget libuv.
      if (!policy.hermetic) {
        const sourceHome =
          policy.live || policy.loadProfileEnv ? readTestHomeSource(env) : undefined;
        writeTestHomeSource(tempRoot, sourceHome ?? callerHome);
      }
      childEnv.HOME = nativeHome;
      childEnv.USERPROFILE = nativeHome;
    }
    if (policy.hermetic) {
      for (const key of [...LIVE_TEST_TRIGGER_ENV_KEYS, "OPENCLAW_LIVE_USE_REAL_HOME"]) {
        delete childEnv[key];
      }
    }
    const options = { ...spec.options, detached, env: childEnv };
    child = spawn(spec.command, spec.args, options);
  } catch (error) {
    tempDirs.cleanup();
    throw error;
  }
  const completion = createVitestProcessCompletion({ child, detached }).then(
    (result) => {
      if (verifiedGroup) {
        tempDirs.cleanup();
      } else {
        console.error(
          `[vitest] retained temporary namespace ${tempRoot}; descendant completion is unverified on this non-group launch. Stop the remaining writers before removing this exact directory.`,
        );
      }
      return result;
    },
    (error: unknown) => {
      // No PID means spawn failed; otherwise unverified writers still own the files.
      if (!child.pid) {
        tempDirs.cleanup();
      } else {
        throw new Error(
          `[vitest] retained temporary namespace ${tempRoot}; child/group completion was not verified. Stop the remaining writers before removing this exact directory.`,
          { cause: error },
        );
      }
      throw error;
    },
  );
  return { child, completion };
}
