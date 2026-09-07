// Fixture adapter for native plutil output on non-macOS test hosts. Only the
// generated XML fixture subset is supported; native validation is tested separately.
export function decodeLaunchAgentPlistFixture(input: string | Uint8Array) {
  const xml = typeof input === "string" ? input : Buffer.from(input).toString("utf8");
  const decode = (value: string) =>
    value
      .replaceAll("&apos;", "'")
      .replaceAll("&quot;", '"')
      .replaceAll("&gt;", ">")
      .replaceAll("&lt;", "<")
      .replaceAll("&amp;", "&");
  const args = xml.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1];
  const environment = xml.match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/)?.[1];
  return {
    stdout: JSON.stringify({
      ProgramArguments:
        args === undefined
          ? undefined
          : Array.from(args.matchAll(/<string>([\s\S]*?)<\/string>/g), (match) =>
              decode(match[1] ?? ""),
            ),
      WorkingDirectory: xml.match(
        /<key>WorkingDirectory<\/key>\s*<string>([\s\S]*?)<\/string>/,
      )?.[1],
      EnvironmentVariables:
        environment === undefined
          ? undefined
          : Object.fromEntries(
              Array.from(
                environment.matchAll(/<key>([\s\S]*?)<\/key>\s*<string>([\s\S]*?)<\/string>/g),
                (match) => [decode(match[1] ?? ""), decode(match[2] ?? "")],
              ),
            ),
    }),
    stderr: "",
  };
}
