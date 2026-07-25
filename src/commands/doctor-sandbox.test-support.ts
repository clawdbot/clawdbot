import "./doctor-sandbox.js";

type TestApi = {
  resolveSandboxScript(
    scriptRel: string,
    options?: { argv1?: string; cwd?: string },
  ): { scriptPath: string; cwd: string } | null;
};

function getTestApi(): TestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.doctorSandboxTestApi")
  ] as TestApi;
}

export const resolveSandboxScript: TestApi["resolveSandboxScript"] = (scriptRel, options) =>
  getTestApi().resolveSandboxScript(scriptRel, options);
