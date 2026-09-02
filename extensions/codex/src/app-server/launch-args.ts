// Single-value root/app-server options from the pinned Codex CLI, shared_options,
// tui/cli, transport/auth, and code_mode_host. Values are never subcommands.
const CODEX_VALUE_OPTIONS = new Set([
  "-m",
  "--model",
  "--local-provider",
  "-p",
  "--profile",
  "-s",
  "--sandbox",
  "-a",
  "--ask-for-approval",
  "-C",
  "--cd",
  "--add-dir",
  "--remote",
  "--remote-auth-token-env",
  "-c",
  "--config",
  "--enable",
  "--disable",
  "--listen",
  "--code-mode-host",
  "--ws-auth",
  "--ws-token-file",
  "--ws-token-sha256",
  "--ws-shared-secret-file",
  "--ws-issuer",
  "--ws-audience",
  "--ws-max-clock-skew-seconds",
]);

type CodexArg = { index: number; end: number; name: string; value?: string };

/** One tokenization owner for launch, turn policy, reviewer trust, and private turns. */
function readCodexArgs(args: readonly string[]): CodexArg[] {
  const tokens: CodexArg[] = [];
  let nativeSubcommand = false;
  let end = 0;
  for (const [index, arg] of args.entries()) {
    if (index < end) {
      continue;
    }
    end = index + 1;
    const attached = /^(--[^=]+)=([\s\S]*)$/u.exec(arg) ?? /^(-[cmpisaC])=?([\s\S]+)$/u.exec(arg);
    const name = attached?.[1] ?? arg;
    let value = attached?.[2];
    if (name === "-i" || name === "--image") {
      // Native image arguments consume multiple paths, even one named app-server.
      while (args[end]?.startsWith("-") === false) {
        end += 1;
      }
    } else if (!attached && CODEX_VALUE_OPTIONS.has(name)) {
      value = args[end];
      if (value !== undefined) {
        end += 1;
      }
    }
    tokens.push({ index, end, name, value });
    if (name === "app-server") {
      nativeSubcommand = true;
    }
    // A prefix -- may belong to a shell wrapper. After app-server it is native.
    if (name === "--" && nativeSubcommand) {
      break;
    }
  }
  return tokens;
}

export function readCodexAppServerConfigOptions(args: readonly string[]) {
  return readCodexArgs(args).filter(
    ({ name }) => name === "-c" || name === "--config" || name === "-p" || name === "--profile",
  );
}

/** The stdio proxy forwards to an external server; it does not own that runtime. */
export function isCodexAppServerProxyLaunch(args: readonly string[]): boolean {
  const tokens = readCodexArgs(args);
  const server = tokens.findLastIndex(({ name }) => name === "app-server");
  return (
    server >= 0 &&
    tokens.slice(server + 1).find(({ name }) => !name.startsWith("-"))?.name === "proxy"
  );
}

/** Keeps Codex overrides in one CLI scope without rewriting raw TOML or wrapper prefixes. */
export function normalizeCodexAppServerArgs(
  rawArgs: string[],
  enforcedOverride?: string,
): string[] {
  const tokens = readCodexArgs(rawArgs);
  const subcommandIndex = tokens.findLast(({ name }) => name === "app-server")?.index ?? -1;
  const prefix = subcommandIndex < 0 ? [...rawArgs] : rawArgs.slice(0, subcommandIndex);
  const suffix: string[] = [];
  if (subcommandIndex >= 0) {
    // clap replaces root global Append values when a suffix config flag exists.
    // Move only native suffix overrides, retaining their original order and bytes.
    for (const token of tokens) {
      if (token.index <= subcommandIndex) {
        continue;
      }
      if (token.name === "--") {
        suffix.push(...rawArgs.slice(token.index));
        break;
      }
      const target = token.name === "-c" || token.name === "--config" ? prefix : suffix;
      target.push(...rawArgs.slice(token.index, token.end));
    }
  }
  if (enforcedOverride && !(prefix.at(-2) === "-c" && prefix.at(-1) === enforcedOverride)) {
    prefix.push("-c", enforcedOverride);
  }
  const normalized = subcommandIndex < 0 ? prefix : [...prefix, "app-server", ...suffix];
  return normalized.length === rawArgs.length &&
    normalized.every((arg, index) => arg === rawArgs[index])
    ? rawArgs
    : normalized;
}
