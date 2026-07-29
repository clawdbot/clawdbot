// In-memory stdout/stderr capture helper for command tests.

/** Create a minimal IO object plus readers for captured output. */
export function createCapturedIo() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: {
        write(chunk: unknown) {
          stdout += String(chunk);
        },
      },
      stderr: {
        write(chunk: unknown) {
          stderr += String(chunk);
        },
      },
    },
    readStdout: () => stdout,
    readStderr: () => stderr,
  };
}
