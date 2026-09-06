import { Script } from "node:vm";

const JAVASCRIPT_EXPORT =
  /^export\s+(?:(?:abstract|as|async|class|const|declare|default|enum|function|import|interface|let|namespace|type|var)\b|[={*])/u;
const JAVASCRIPT_KEYWORD =
  /^(?:abstract|as|async|await|break|case|catch|class|const|continue|debugger|declare|default|delete|do|else|enum|export|extends|false|finally|for|function|if|implements|import|in|instanceof|interface|let|namespace|new|null|of|private|protected|public|return|satisfies|static|super|switch|this|throw|true|try|typeof|undefined|var|void|while|with|yield)$/u;
const JAVASCRIPT_GLOBAL =
  /^(?:API|MCP|AggregateError|Array|ArrayBuffer|BigInt|BigInt64Array|BigUint64Array|Boolean|DataView|Date|Error|EvalError|Float32Array|Float64Array|Function|Infinity|Int16Array|Int32Array|Int8Array|Intl|JSON|Map|Math|NaN|Number|Object|Promise|Proxy|RangeError|ReferenceError|Reflect|RegExp|Set|String|Symbol|SyntaxError|TypeError|URIError|Uint16Array|Uint32Array|Uint8Array|Uint8ClampedArray|WeakMap|WeakSet|catalog|clearTimeout|console|decodeURI|decodeURIComponent|encodeURI|encodeURIComponent|eval|globalThis|isFinite|isNaN|json|nodes|parseFloat|parseInt|setTimeout|skills|text|yield_control)$/u;

const SHELL_COMMAND =
  /^(?:\/(?:usr\/(?:local\/)?)?bin\/)?(alias|apt|awk|bash|bg|brew|builtin|bun|cargo|cat|cd|chmod|cmd|command|cp|curl|cut|date|declare|df|dir|docker|dotnet|du|echo|env|exec|exit|export|fg|file|find|getopts|git|go|gradle|grep|hash|head|help|hostname|id|java|javac|jobs|jq|kill|kubectl|ln|local|logout|ls|make|mkdir|mvn|mv|node|npm|npx|perl|php|pip|pip3|pnpm|poetry|popd|powershell|printf|ps|pushd|pwd|pwsh|pytest|python|python3|read|readonly|rg|rm|ruby|rustc|rustup|sed|set|sh|shift|sleep|sort|source|stat|sudo|swift|systemctl|tail|tar|tee|test|touch|trap|tree|type|ulimit|umask|uname|uniq|unset|unzip|uv|uvx|vitest|wait|wc|wget|which|whoami|xargs|yarn|zip|zsh)(?=$|[\s;&|<>])/u;

const SHELL_IDENTIFIER = /^([A-Za-z_][\w-]*)(?=$|[\s;&|<>])/u;
const SHELL_EXECUTABLE_PATH =
  /^(?:(?:\.{1,2}|~)[\\/]|\/|[A-Za-z]:[\\/])[^\s;|&()]+(?=$|[\t \r\n;&|])/u;
const SHELL_ARGUMENT =
  /^(?:-{1,2}[a-z\d][\w-]*(?:[\t =;&|]|$)|(?:(?:\.{1,2}|~)[\\/]|\/|[A-Za-z]:[\\/])[^\s]+)/iu;
const SHELL_CONTROL =
  /^(?:(?:if|elif|while|until)[\t ]+(?:\[{1,2}(?=[\t ]|$)|test\b|[A-Za-z_][\w-]*(?=[\t ;]))|for[\t ]+(?:[A-Za-z_]\w*[\t ]+in\b|\(\([^\r\n]*\)\)[\t ]*;[\t ]*do\b)|case[\t ]+\S+[\t ]+in\b|function[\t ]+[A-Za-z_][\w-]*[\t ]*\{)/u;
const SHELL_REDIRECTION = /^(?:\d*(?:>>?|<<?)|&>>?)/u;
const LEADING_SOURCE_COMMENTS =
  /^(?:(?:\/\/[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?\*\/|#[^\r\n]*(?:\r?\n|$))[\t \r\n]*)+/u;

function parsesAsGuestJavaScript(source: string, declaration = ""): boolean {
  try {
    return new Script(`(async () => {\n${declaration}${source}\n})`) instanceof Script;
  } catch {
    return false;
  }
}

function hasHoistedGuestBinding(source: string, name: string): boolean {
  // A lexical probe conflicts only with a real same-scope declaration; the
  // matching var probe succeeds only when that declaration is hoisted.
  return (
    !parsesAsGuestJavaScript(source, `let ${name};\n`) &&
    parsesAsGuestJavaScript(source, `var ${name};\n`)
  );
}

function stripShellEnvAssignments(source: string): string {
  const name = /[A-Za-z_]\w*=/uy;
  if (!name.test(source)) {
    return source;
  }
  // Each state stores the first successful endpoint in regex alternative order;
  // zero means no match. Reverse evaluation visits each suffix once, including
  // quoted fallbacks, instead of backtracking over overlapping alternatives.
  const value = new Uint32Array(source.length + 3);
  const doubleQuoted = new Uint32Array(source.length + 3);
  const singleQuoted = new Uint32Array(source.length + 3);
  let blanksEnd = 0;
  let newlineEnd = 0;
  for (let index = source.length - 1; index >= name.lastIndex; index -= 1) {
    const character = source[index]!;
    const blank = character === " " || character === "\t";
    const whitespace = /\s/u.test(character);
    const separator = blank
      ? blanksEnd || newlineEnd
      : character === "\n"
        ? blanksEnd
        : character === "\r" && source[index + 1] === "\n"
          ? newlineEnd
          : 0;
    if (!blank) {
      blanksEnd = whitespace ? 0 : index;
      newlineEnd = separator;
    }
    // The original escape's dot consumes a Unicode point, excluding line breaks.
    const escaped =
      character === "\\" &&
      index + 1 < source.length &&
      !/[\r\n\u2028\u2029]/u.test(source[index + 1]!);
    const afterEscape = index + (escaped && source.codePointAt(index + 1)! > 0xffff ? 3 : 2);
    doubleQuoted[index] =
      (escaped ? doubleQuoted[afterEscape]! : 0) ||
      (character === '"' ? value[index + 1]! : doubleQuoted[index + 1]!);
    singleQuoted[index] = character === "'" ? value[index + 1]! : singleQuoted[index + 1]!;
    value[index] =
      (character === '"' ? doubleQuoted[index + 1]! : 0) ||
      (character === "'" ? singleQuoted[index + 1]! : 0) ||
      (escaped ? value[afterEscape]! : 0) ||
      (!whitespace && character !== ";" && character !== "&" && character !== "|"
        ? value[index + 1]!
        : 0) ||
      separator;
  }
  let commandStart = 0;
  // Reuse the suffix table across every leading assignment, rather than
  // scanning the remaining command again for each NAME=value prefix.
  do {
    const end = value[name.lastIndex]!;
    if (!end) {
      break;
    }
    commandStart = end;
    name.lastIndex = end;
  } while (name.test(source));
  return source.slice(commandStart);
}

/** Reject recognizable shell commands without guessing at JavaScript expressions. */
export function isShellLikeCodeModeSource(source: string, preparedSource = source): boolean {
  const trimmed = source.trim();
  if (trimmed.startsWith("#!")) {
    return true;
  }
  const uncommented = trimmed.replace(LEADING_SOURCE_COMMENTS, "");
  if (!uncommented || JAVASCRIPT_EXPORT.test(uncommented)) {
    return false;
  }
  if (SHELL_CONTROL.test(uncommented)) {
    return true;
  }
  // Shell environment prefixes cannot make a recognizable executable safe;
  // strip them before deciding whether the guest worker should start.
  const commandSource = stripShellEnvAssignments(uncommented);

  const knownCommand = SHELL_COMMAND.exec(commandSource);
  const unknownCommand = SHELL_IDENTIFIER.exec(commandSource);
  const command =
    knownCommand ??
    (unknownCommand &&
    !JAVASCRIPT_KEYWORD.test(unknownCommand[1] ?? "") &&
    !JAVASCRIPT_GLOBAL.test(unknownCommand[1] ?? "")
      ? unknownCommand
      : null);
  if (!command && !SHELL_EXECUTABLE_PATH.test(commandSource)) {
    return false;
  }

  const commandTail = command ? commandSource.slice(command[0].length) : "";
  const remainder = commandTail.trimStart();

  if (command && !remainder) {
    return knownCommand !== null;
  }

  // A binding only matters when the actual guest program parses. TypeScript
  // callers supply transformed JavaScript so shell text inside a comment,
  // string, or unrelated declaration cannot bypass source validation.
  if (!parsesAsGuestJavaScript(preparedSource)) {
    return true;
  }

  const commandName = command?.[1];
  if (commandName && hasHoistedGuestBinding(preparedSource, commandName)) {
    return false;
  }

  if (/^[\t ]*(?:[;\r\n]|&&?|\|{1,2})/u.test(commandTail)) {
    return knownCommand !== null;
  }

  if (
    !command ||
    (!SHELL_ARGUMENT.test(remainder) &&
      !(knownCommand !== null && SHELL_REDIRECTION.test(remainder)) &&
      !(commandName === "jq" && remainder.startsWith(".")))
  ) {
    return false;
  }

  // An unbound executable with flags or a path would only become a QuickJS
  // ReferenceError and trigger another model retry.
  return true;
}

export const CODE_MODE_SHELL_SOURCE_ERROR =
  "code-mode exec runs JavaScript or TypeScript, not shell commands. " +
  "Call an enabled async tool global from guest JavaScript; use " +
  "catalog.search(query) when the bounded quick index omits it. " +
  "Do not retry the same shell command as code.";
