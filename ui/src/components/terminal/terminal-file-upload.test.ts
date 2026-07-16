/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import {
  encodeTerminalUpload,
  quoteTerminalUploadPath,
  uploadTerminalFile,
} from "./terminal-file-upload.ts";

const MAX_TERMINAL_UPLOAD_BYTES = 16 * 1024 * 1024;

describe("terminal file upload", () => {
  it("requests terminal.upload with the session-bound payload", async () => {
    const requests: Array<{ method: string; params: unknown; signal?: AbortSignal }> = [];
    const abortController = new AbortController();
    const client = {
      request: async <T>(method: string, params?: unknown, options?: { signal?: AbortSignal }) => {
        requests.push({ method, params, signal: options?.signal });
        return { path: "/tmp/scan.pdf", size: 1 } as T;
      },
    };

    await expect(
      uploadTerminalFile(
        client,
        "s1",
        { name: "scan.pdf", contentBase64: "AA==" },
        abortController.signal,
      ),
    ).resolves.toEqual({ path: "/tmp/scan.pdf", size: 1 });
    expect(requests).toEqual([
      {
        method: "terminal.upload",
        params: { sessionId: "s1", name: "scan.pdf", contentBase64: "AA==" },
        signal: abortController.signal,
      },
    ]);
  });

  it("base64-encodes arbitrary browser files", async () => {
    const file = new File([new Uint8Array([0, 1, 2, 255])], "scan.pdf");
    await expect(encodeTerminalUpload(file)).resolves.toBe("AAEC/w==");
  });

  it("rejects oversized files before reading them", async () => {
    const file = {
      name: "archive.zip",
      size: MAX_TERMINAL_UPLOAD_BYTES + 1,
      arrayBuffer: () => Promise.reject(new Error("should not read")),
    } as File;
    await expect(encodeTerminalUpload(file)).rejects.toThrow("16 MiB");
  });

  it("quotes paths for POSIX, PowerShell, and cmd terminals", () => {
    expect(quoteTerminalUploadPath("/tmp/report.pdf", "/bin/zsh")).toBe("/tmp/report.pdf");
    expect(quoteTerminalUploadPath("/tmp/report final.pdf", "/bin/zsh")).toBe(
      "'/tmp/report final.pdf'",
    );
    expect(quoteTerminalUploadPath("/tmp/it's.pdf", "/bin/zsh")).toBe("'/tmp/it'\\''s.pdf'");
    expect(quoteTerminalUploadPath("C:\\Temp\\report final.pdf", "pwsh.exe")).toBe(
      "'C:\\Temp\\report final.pdf'",
    );
    expect(quoteTerminalUploadPath("C:\\Temp\\report.pdf", "cmd.exe")).toBe(
      '"C:\\Temp\\report.pdf"',
    );
    expect(quoteTerminalUploadPath("C:\\Temp\\x$(touch pwned).txt", "C:\\Git\\bin\\bash.exe")).toBe(
      "'C:\\Temp\\x$(touch pwned).txt'",
    );
  });

  it("refuses Windows paths for shells with unknown quoting and path semantics", () => {
    expect(() => quoteTerminalUploadPath("C:\\Temp\\x$(touch pwned).txt", "wsl.exe")).toThrow(
      "unsupported shell: wsl.exe",
    );
    expect(() =>
      quoteTerminalUploadPath("\\\\server\\profiles\\x$(touch pwned).txt", "wsl.exe"),
    ).toThrow("unsupported shell: wsl.exe");
  });

  it("refuses POSIX paths for shells with unknown quoting", () => {
    expect(() => quoteTerminalUploadPath("/tmp/it's.pdf", "/usr/bin/nu")).toThrow(
      "unsupported shell: nu",
    );
  });

  it.each(["C:\\Users\\%USERNAME%\\report.pdf", "C:\\Users\\bang!\\report.pdf"])(
    "refuses cmd.exe expansion in the complete staged path: %s",
    (filePath) => {
      expect(() => quoteTerminalUploadPath(filePath, "cmd.exe")).toThrow(
        "path containing % or ! into cmd.exe",
      );
    },
  );
});
