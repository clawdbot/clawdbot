import type { ChildProcessWithoutNullStreams } from "node:child_process";

export function ignoreChildOutputStreamErrors(child: ChildProcessWithoutNullStreams): void {
  const ignoreOutputStreamError = () => {};
  child.stdout.on("error", ignoreOutputStreamError);
  child.stderr.on("error", ignoreOutputStreamError);
}

export function onChildOutputStreamError(
  child: ChildProcessWithoutNullStreams,
  onError: (message: string) => void,
): void {
  const streamErrorToFail = (error: Error) => {
    onError(`sandbox http/request output stream error: ${error.message}`);
  };
  child.stdout.on("error", streamErrorToFail);
  child.stderr.on("error", streamErrorToFail);
}
