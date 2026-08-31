import { spawn, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { createTempDirTracker } from "../../test/helpers/temp-dir.ts";
import {
  createVitestProcessCompletion,
  shouldUseDetachedVitestProcessGroup,
} from "../vitest-process-group.mts";

/** Own temporary files until the Vitest child, its group, and its pipes have joined. */
export function spawnOwnedVitestProcess(spec: {
  command: string;
  args: string[];
  options: SpawnOptions;
}) {
  const tempDirs = createTempDirTracker();
  const detached = spec.options.detached ?? shouldUseDetachedVitestProcessGroup();
  let options = { ...spec.options, detached };
  let tempRoot: string | undefined;
  // Windows has no verified group join. Keep its existing temporary-file behavior.
  if (detached && shouldUseDetachedVitestProcessGroup()) {
    const env = options.env ?? process.env;
    tempRoot = tempDirs.make(
      "oc-vt-",
      fs.realpathSync(env.TMPDIR || env.TMP || env.TEMP || tmpdir()),
    );
    options = { ...options, env: { ...env, TMPDIR: tempRoot, TMP: tempRoot, TEMP: tempRoot } };
  }
  let child;
  try {
    child = spawn(spec.command, spec.args, options);
  } catch (error) {
    tempDirs.cleanup();
    throw error;
  }
  const completion = createVitestProcessCompletion({ child, detached }).then(
    (result) => {
      tempDirs.cleanup();
      return result;
    },
    (error: unknown) => {
      // No PID means spawn failed; otherwise unverified writers still own the files.
      if (!child.pid) {
        tempDirs.cleanup();
      } else if (tempRoot) {
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
