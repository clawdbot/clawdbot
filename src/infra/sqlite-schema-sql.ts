const TABLE_CONSTRAINT_KEYWORDS = new Set(["CHECK", "FOREIGN", "PRIMARY", "UNIQUE"]);

type SqlToken = {
  end: number;
  keyword: string | null;
  raw: string;
};

export function readTableConstraintKeyword(sql: string, first: SqlToken): string | null {
  let token: SqlToken | null = first;
  if (token.keyword === "CONSTRAINT") {
    const name = readSqlToken(sql, token.end);
    token = name ? readSqlToken(sql, name.end) : null;
  }
  return token?.keyword && TABLE_CONSTRAINT_KEYWORDS.has(token.keyword) ? token.keyword : null;
}

export function readSqlToken(sql: string, start: number): SqlToken | null {
  let index = start;
  while (index < sql.length && /\s/u.test(sql[index] ?? "")) {
    index += 1;
  }
  const char = sql[index];
  if (!char) {
    return null;
  }
  if (char === '"' || char === "`") {
    const end = skipSqlQuoted(sql, index, char);
    return { end, keyword: null, raw: sql.slice(index, end) };
  }
  if (char === "[") {
    const end = skipSqlQuoted(sql, index, char);
    return { end, keyword: null, raw: sql.slice(index, end) };
  }
  let end = index;
  while (end < sql.length && !/[\s(,]/u.test(sql[end] ?? "")) {
    end += 1;
  }
  const raw = sql.slice(index, end);
  return { end, keyword: raw.toUpperCase(), raw };
}

export function normalizeSqlIdentifier(identifier: string): string {
  if (identifier.startsWith('"') && identifier.endsWith('"')) {
    return identifier.slice(1, -1).replaceAll('""', '"').toLowerCase();
  }
  if (identifier.startsWith("`") && identifier.endsWith("`")) {
    return identifier.slice(1, -1).replaceAll("``", "`").toLowerCase();
  }
  if (identifier.startsWith("[") && identifier.endsWith("]")) {
    return identifier.slice(1, -1).toLowerCase();
  }
  return identifier.toLowerCase();
}

export function normalizeSchemaSql(sql: string | null): string | null {
  if (sql === null) {
    return null;
  }
  const normalized = normalizeSqlWhitespace(sql).replace(/;\s*$/u, "").trim();
  return normalized.replace(
    /^(CREATE (?:TABLE|VIRTUAL TABLE|UNIQUE INDEX|INDEX|TRIGGER)) IF NOT EXISTS /iu,
    "$1 ",
  );
}

export function splitSqlList(sql: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let start = 0;
  let index = 0;
  while (index < sql.length) {
    const next = skipSqlQuotedOrComment(sql, index);
    if (next !== index) {
      index = next;
      continue;
    }
    const char = sql[index];
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
    } else if (char === "," && depth === 0) {
      items.push(sql.slice(start, index));
      start = index + 1;
    }
    index += 1;
  }
  items.push(sql.slice(start));
  return items;
}

export function findSqlCharacter(sql: string, character: string): number {
  let index = 0;
  while (index < sql.length) {
    const next = skipSqlQuotedOrComment(sql, index);
    if (next !== index) {
      index = next;
      continue;
    }
    if (sql[index] === character) {
      return index;
    }
    index += 1;
  }
  return -1;
}

export function findSqlClosingParenthesis(sql: string, open: number): number {
  let depth = 0;
  let index = open;
  while (index < sql.length) {
    const next = skipSqlQuotedOrComment(sql, index);
    if (next !== index) {
      index = next;
      continue;
    }
    const char = sql[index];
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
    index += 1;
  }
  throw new Error("SQLite schema contains an unterminated table definition.");
}

export function normalizeSqlWhitespace(sql: string): string {
  let normalized = "";
  let pendingSpace = false;
  // Ordinary spans have no quote, comment opener or whitespace to interpret.
  const segments = /[^\s'"`[/-]+|\s+|./gsu;
  let segment: RegExpExecArray | null;
  while ((segment = segments.exec(sql))) {
    const index = segment.index;
    const char = segment[0][0] ?? "";
    const quoted = skipSqlQuoted(sql, index, char);
    if (quoted !== index) {
      if (pendingSpace && normalized.length > 0) {
        normalized += " ";
      }
      normalized += sql.slice(index, quoted);
      pendingSpace = false;
      segments.lastIndex = quoted;
      continue;
    }
    const comment = skipSqlComment(sql, index);
    if (comment !== index) {
      pendingSpace = true;
      segments.lastIndex = comment;
      continue;
    }
    if (/\s/u.test(char)) {
      pendingSpace = true;
    } else {
      if (pendingSpace && normalized.length > 0) {
        normalized += " ";
      }
      normalized += segment[0];
      pendingSpace = false;
    }
  }
  return normalized.trim();
}

export function quoteSqliteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function skipSqlQuotedOrComment(sql: string, index: number): number {
  const quoted = skipSqlQuoted(sql, index, sql[index] ?? "");
  return quoted !== index ? quoted : skipSqlComment(sql, index);
}

function skipSqlQuoted(sql: string, index: number, quote: string): number {
  if (quote !== "'" && quote !== '"' && quote !== "`" && quote !== "[") {
    return index;
  }
  const closingQuote = quote === "[" ? "]" : quote;
  let cursor = index + 1;
  while (cursor < sql.length) {
    if (sql[cursor] !== closingQuote) {
      cursor += 1;
      continue;
    }
    if (quote !== "[" && sql[cursor + 1] === closingQuote) {
      cursor += 2;
      continue;
    }
    return cursor + 1;
  }
  return sql.length;
}

function skipSqlComment(sql: string, index: number): number {
  if (sql.startsWith("--", index)) {
    const newline = sql.indexOf("\n", index + 2);
    return newline === -1 ? sql.length : newline + 1;
  }
  if (sql.startsWith("/*", index)) {
    const close = sql.indexOf("*/", index + 2);
    return close === -1 ? sql.length : close + 2;
  }
  return index;
}
