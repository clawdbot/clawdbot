// Classifies doctor repair and SQLite maintenance modes.
const HELP_OR_VERSION_FLAGS = new Set(["-h", "--help", "--version"]);
const MUTATION_FLAGS = new Set([
  "--fix",
  "--force",
  "--generate-gateway-token",
  "--non-interactive",
  "--repair",
]);
const OPTIONS_WITH_VALUE = new Set([
  "--only",
  "--session-sqlite",
  "--session-sqlite-agent",
  "--session-sqlite-store",
  "--severity-min",
  "--skip",
  "--state-sqlite",
]);

function optionName(token: string): string {
  return token.trim().toLowerCase().split("=", 1)[0] ?? "";
}

/** Return true when doctor argv enables repair or state migration behavior. */
export function classifyOpenClawDoctorArgv(argv: readonly string[], start: number): boolean {
  let lint = false;
  let postUpgrade = false;
  let mutation = false;
  let sessionSqlite = "";
  let stateSqlite = "";
  for (let index = start; index < argv.length; index += 1) {
    const token = argv[index]?.trim() ?? "";
    const name = optionName(token);
    if (HELP_OR_VERSION_FLAGS.has(token)) {
      return false;
    }
    mutation ||= MUTATION_FLAGS.has(name);
    lint ||= name === "--lint";
    postUpgrade ||= name === "--post-upgrade";
    if (OPTIONS_WITH_VALUE.has(name)) {
      const value = token.includes("=") ? token.slice(token.indexOf("=") + 1) : argv[++index];
      if (name === "--session-sqlite") {
        sessionSqlite = value?.trim().toLowerCase() ?? "";
      } else if (name === "--state-sqlite") {
        stateSqlite = value?.trim().toLowerCase() ?? "";
      }
    }
  }
  if (mutation) {
    return true;
  }
  if (lint || postUpgrade) {
    return false;
  }
  return (
    stateSqlite === "compact" || ["compact", "import", "recover", "restore"].includes(sessionSqlite)
  );
}
