// Keep this client guard aligned with the gateway protocol's 16 MiB limit so
// oversized files never expand into a WebSocket base64 payload.
const MAX_TERMINAL_UPLOAD_BYTES = 16 * 1024 * 1024;

type TerminalUploadFile = { name: string; contentBase64: string };
type TerminalUploadResult = { path: string; size: number };

type TerminalUploadClient = {
  request<T = unknown>(
    method: string,
    params?: unknown,
    options?: { signal?: AbortSignal },
  ): Promise<T>;
};

export async function uploadTerminalFile(
  client: TerminalUploadClient,
  sessionId: string,
  file: TerminalUploadFile,
  signal?: AbortSignal,
): Promise<TerminalUploadResult> {
  const params = { sessionId, ...file };
  return await (signal
    ? client.request<TerminalUploadResult>("terminal.upload", params, { signal })
    : client.request<TerminalUploadResult>("terminal.upload", params));
}

export async function encodeTerminalUpload(file: File): Promise<string> {
  if (file.size > MAX_TERMINAL_UPLOAD_BYTES) {
    throw new Error(`File exceeds the 16 MiB terminal upload limit: ${file.name}`);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const chunks: string[] = [];
  const chunkSize = 32 * 1024;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
  }
  return btoa(chunks.join(""));
}

/** Quotes one staged path for the shell that owns the active terminal. */
export function quoteTerminalUploadPath(filePath: string, shell: string): string {
  const shellName = shell.split(/[\\/]/u).pop()?.toLowerCase() ?? "";
  if (/^(?:pwsh|powershell)(?:\.exe)?$/u.test(shellName)) {
    return `'${filePath.replaceAll("'", "''")}'`;
  }
  if (/^cmd(?:\.exe)?$/u.test(shellName)) {
    if (/[%!]/u.test(filePath)) {
      throw new Error("Cannot safely insert an uploaded path containing % or ! into cmd.exe");
    }
    return `"${filePath.replaceAll('"', '""')}"`;
  }
  const posixShell = /^(?:(?:ba|da|a|k|z)?sh|fish)(?:\.exe)?$/u.test(shellName);
  if (!posixShell) {
    throw new Error(
      `Cannot safely insert an uploaded path into unsupported shell: ${shellName || shell}`,
    );
  }
  if (/^[A-Za-z0-9_@%+=:,./-]+$/u.test(filePath)) {
    return filePath;
  }
  return `'${filePath.replaceAll("'", "'\\''")}'`;
}
