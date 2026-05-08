/**
 * Minimal JSONC parser — handles JSON + line comments and block
 * comments + trailing commas. Produces a structural tree for OcPath
 * resolution; full byte-fidelity emit relies on `raw` on the AST root.
 *
 * **Prototype scope**: this parser handles the input shapes openclaw
 * config files actually use. Production landing ports the full
 * comment-preserving parser from `openclaw-workspace` (1248 LoC).
 *
 * @module @openclaw/oc-path/jsonc/parse
 */

import type { Diagnostic } from '../ast.js';
import type { JsoncAst, JsoncEntry, JsoncValue } from './ast.js';

/**
 * Bound on parse-time recursion depth. Mirrors `MAX_TRAVERSAL_DEPTH`
 * from oc-path; real configs don't nest beyond ~10 levels, so 256 is
 * a safe ceiling. Pathological input like
 * `'['.repeat(20000) + '0' + ']'.repeat(20000)` would otherwise
 * trigger V8 RangeError before any structural diagnostic — the CLI
 * loads attacker-supplied workspace files via `loadAst`, so this
 * defense fires before raw stack overflow escapes to commander.
 */
export const MAX_PARSE_DEPTH = 256;

export interface JsoncParseResult {
  readonly ast: JsoncAst;
  readonly diagnostics: readonly Diagnostic[];
}

class ParseDepthError extends Error {
  readonly code = 'OC_JSONC_DEPTH_EXCEEDED';
  constructor(line: number) {
    super(`structural depth exceeded MAX_PARSE_DEPTH (${MAX_PARSE_DEPTH}) at line ${line}`);
    this.name = 'ParseDepthError';
  }
}

class ParseState {
  pos = 0;
  line = 1;

  constructor(public readonly src: string) {}

  peek(): string | undefined {
    return this.src[this.pos];
  }

  advance(): string | undefined {
    const c = this.src[this.pos];
    this.pos++;
    if (c === '\n') {this.line++;}
    return c;
  }

  eof(): boolean {
    return this.pos >= this.src.length;
  }
}

/**
 * Parse a JSONC string. Soft-error policy: doesn't throw; suspicious
 * inputs surface as diagnostics. An entirely unparseable input
 * produces an AST with `root: null` and an error diagnostic.
 */
export function parseJsonc(raw: string): JsoncParseResult {
  const diagnostics: Diagnostic[] = [];
  // Strip BOM for parsing convenience; raw is preserved on the AST.
  const withoutBom = raw.startsWith('﻿') ? raw.slice(1) : raw;
  const st = new ParseState(withoutBom);

  skipWs(st);
  if (st.eof()) {
    return { ast: { kind: 'jsonc', raw, root: null }, diagnostics };
  }

  let root: JsoncValue | null = null;
  try {
    root = parseValue(st, diagnostics, 0);
    skipWs(st);
    if (!st.eof()) {
      diagnostics.push({
        line: st.line,
        message: `unexpected trailing input at offset ${st.pos}`,
        severity: 'warning',
        code: 'OC_JSONC_TRAILING_INPUT',
      });
    }
  } catch (err) {
    diagnostics.push({
      line: st.line,
      message: err instanceof Error ? err.message : String(err),
      severity: 'error',
      code: err instanceof ParseDepthError ? err.code : 'OC_JSONC_PARSE_FAILED',
    });
  }

  return { ast: { kind: 'jsonc', raw, root }, diagnostics };
}

// ---------- internal --------------------------------------------------------

function skipWs(st: ParseState): void {
  while (!st.eof()) {
    const c = st.peek();
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      st.advance();
      continue;
    }
    if (c === '/') {
      const next = st.src[st.pos + 1];
      if (next === '/') {
        // Line comment — skip until newline.
        while (!st.eof() && st.peek() !== '\n') {st.advance();}
        continue;
      }
      if (next === '*') {
        // Block comment — skip until closing star-slash.
        st.advance();
        st.advance();
        while (!st.eof()) {
          if (st.peek() === '*' && st.src[st.pos + 1] === '/') {
            st.advance();
            st.advance();
            break;
          }
          st.advance();
        }
        continue;
      }
    }
    return;
  }
}

function parseValue(st: ParseState, diags: Diagnostic[], depth: number): JsoncValue {
  // Bound recursion. Without this guard, pathological input like
  // `'['.repeat(20000) + '0' + ']'.repeat(20000)` triggers V8
  // RangeError before any structural diagnostic — the CLI loads
  // attacker-supplied workspace files via `loadAst`, so unbounded
  // recursion would escape commander as a raw stack-overflow string.
  if (depth > MAX_PARSE_DEPTH) {throw new ParseDepthError(st.line);}
  skipWs(st);
  const startLine = st.line;
  const c = st.peek();
  if (c === '{') {return parseObject(st, diags, startLine, depth);}
  if (c === '[') {return parseArray(st, diags, startLine, depth);}
  if (c === '"') {return { kind: 'string', value: parseString(st), line: startLine };}
  if (c === 't' || c === 'f') {return parseBoolean(st, startLine);}
  if (c === 'n') {return parseNull(st, startLine);}
  if (c === '-' || (c !== undefined && c >= '0' && c <= '9')) {return parseNumber(st, startLine);}
  throw new Error(
    `unexpected character ${JSON.stringify(c)} at line ${st.line} (offset ${st.pos})`,
  );
}

function parseObject(st: ParseState, diags: Diagnostic[], startLine: number, depth: number): JsoncValue {
  if (st.advance() !== '{') {throw new Error('expected `{`');}
  const entries: JsoncEntry[] = [];
  skipWs(st);
  if (st.peek() === '}') {
    st.advance();
    return { kind: 'object', entries, line: startLine };
  }
  while (true) {
    skipWs(st);
    if (st.peek() !== '"') {
      throw new Error(`expected string key at line ${st.line} (offset ${st.pos})`);
    }
    const keyLine = st.line;
    const key = parseString(st);
    skipWs(st);
    if (st.advance() !== ':') {
      throw new Error(`expected \`:\` after key at line ${st.line}`);
    }
    skipWs(st);
    const value = parseValue(st, diags, depth + 1);
    entries.push({ key, value, line: keyLine });
    skipWs(st);
    const next = st.peek();
    if (next === ',') {
      st.advance();
      skipWs(st);
      // Trailing comma? Allow.
      if (st.peek() === '}') {
        st.advance();
        return { kind: 'object', entries, line: startLine };
      }
      continue;
    }
    if (next === '}') {
      st.advance();
      return { kind: 'object', entries, line: startLine };
    }
    throw new Error(
      `expected \`,\` or \`}\` after value at line ${st.line} (offset ${st.pos})`,
    );
  }
}

function parseArray(st: ParseState, diags: Diagnostic[], startLine: number, depth: number): JsoncValue {
  if (st.advance() !== '[') {throw new Error('expected `[`');}
  const items: JsoncValue[] = [];
  skipWs(st);
  if (st.peek() === ']') {
    st.advance();
    return { kind: 'array', items, line: startLine };
  }
  while (true) {
    skipWs(st);
    items.push(parseValue(st, diags, depth + 1));
    skipWs(st);
    const next = st.peek();
    if (next === ',') {
      st.advance();
      skipWs(st);
      if (st.peek() === ']') {
        st.advance();
        return { kind: 'array', items, line: startLine };
      }
      continue;
    }
    if (next === ']') {
      st.advance();
      return { kind: 'array', items, line: startLine };
    }
    throw new Error(
      `expected \`,\` or \`]\` after value at line ${st.line} (offset ${st.pos})`,
    );
  }
}

function parseString(st: ParseState): string {
  if (st.advance() !== '"') {throw new Error('expected `"`');}
  let out = '';
  while (!st.eof()) {
    const c = st.advance();
    if (c === '"') {return out;}
    if (c === '\\') {
      const esc = st.advance();
      switch (esc) {
        case '"': out += '"'; break;
        case '\\': out += '\\'; break;
        case '/': out += '/'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'n': out += '\n'; break;
        case 'r': out += '\r'; break;
        case 't': out += '\t'; break;
        case 'u': {
          const hex = st.src.slice(st.pos, st.pos + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            throw new Error(`invalid unicode escape at line ${st.line}`);
          }
          out += String.fromCharCode(Number.parseInt(hex, 16));
          st.pos += 4;
          break;
        }
        default:
          throw new Error(`invalid escape \\${esc} at line ${st.line}`);
      }
      continue;
    }
    out += c;
  }
  throw new Error(`unterminated string starting at line ${st.line}`);
}

function parseBoolean(st: ParseState, line: number): JsoncValue {
  if (st.src.slice(st.pos, st.pos + 4) === 'true') {
    st.pos += 4;
    return { kind: 'boolean', value: true, line };
  }
  if (st.src.slice(st.pos, st.pos + 5) === 'false') {
    st.pos += 5;
    return { kind: 'boolean', value: false, line };
  }
  throw new Error(`expected true/false at line ${st.line}`);
}

function parseNull(st: ParseState, line: number): JsoncValue {
  if (st.src.slice(st.pos, st.pos + 4) === 'null') {
    st.pos += 4;
    return { kind: 'null', line };
  }
  throw new Error(`expected null at line ${st.line}`);
}

function parseNumber(st: ParseState, line: number): JsoncValue {
  const start = st.pos;
  if (st.peek() === '-') {st.advance();}
  while (!st.eof() && /[0-9]/.test(st.peek() ?? '')) {st.advance();}
  if (st.peek() === '.') {
    st.advance();
    while (!st.eof() && /[0-9]/.test(st.peek() ?? '')) {st.advance();}
  }
  if (st.peek() === 'e' || st.peek() === 'E') {
    st.advance();
    if (st.peek() === '+' || st.peek() === '-') {st.advance();}
    while (!st.eof() && /[0-9]/.test(st.peek() ?? '')) {st.advance();}
  }
  const text = st.src.slice(start, st.pos);
  const value = Number(text);
  if (!Number.isFinite(value)) {
    throw new Error(`invalid number "${text}" at line ${st.line}`);
  }
  return { kind: 'number', value, line };
}

export type { Diagnostic };
