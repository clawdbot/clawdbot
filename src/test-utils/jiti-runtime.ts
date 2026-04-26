export function shouldExpectNativeJitiForJavaScriptTestRuntime(): boolean {
  return (
    typeof (process.versions as { bun?: string }).bun !== "string" && process.platform !== "win32"
  );
}
