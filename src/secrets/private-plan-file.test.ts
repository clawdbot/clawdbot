import path from "node:path";
import { expect, it, vi } from "vitest";
import type { runExec } from "../process/exec.js";
import { createPrivateWindowsPlanFile } from "./private-plan-file.js";

it("resolves trusted PowerShell and passes private plan content through stdin", async () => {
  let observedInput: string | Uint8Array | undefined;
  const run = vi.fn<typeof runExec>(async (_command, _args, options) => {
    observedInput = typeof options === "object" ? options.input : undefined;
    return { stdout: "", stderr: "" };
  });
  const powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const resolveTrustedExecutable = vi.fn(async () => powershell);
  const content = '{"version":1}\n';
  await createPrivateWindowsPlanFile(
    "C:\\plans\\plan.json",
    content,
    { SYSTEMROOT: "C:\\Windows" },
    {
      resolveCompilerTempDir: async () => "C:\\Users\\me\\AppData\\Local\\Temp",
      resolveTrustedExecutable,
      run,
    },
  );
  expect(resolveTrustedExecutable).toHaveBeenCalledWith(powershell);
  expect(run).toHaveBeenCalledOnce();
  expect(run).toHaveBeenCalledWith(
    powershell,
    expect.any(Array),
    expect.objectContaining({ baseEnv: {}, input: expect.any(String), logOutput: false }),
  );
  const payload = JSON.parse(Buffer.from(String(observedInput), "base64").toString("utf8")) as {
    content: string;
    finalPath: string;
    stagingPath: string;
  };
  expect(Buffer.from(payload.content, "base64").toString("utf8")).toBe(content);
  expect(payload.finalPath).toContain("plan.json");
  expect(path.win32.basename(payload.stagingPath)).toMatch(/^\.openclaw-plan-[^.]+\.tmp$/u);
});
