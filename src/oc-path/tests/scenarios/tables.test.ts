/**
 * Wave 5 — markdown tables.
 *
 * Substrate guarantee: GFM-style tables (`| h | h |\n|---|---|\n| r | r |`)
 * inside H2 blocks are extracted into `AstTable`. Tables inside fenced
 * code blocks are NOT extracted (handled at item-extraction layer too;
 * tables share the same code-block awareness when relevant).
 */
import { describe, expect, it } from 'vitest';
import { parseMd } from '../../parse.js';

describe('wave-05 tables', () => {
  it('T-01 standard 2-column table', () => {
    const raw = `## H

| tool | guidance |
| --- | --- |
| gh | use for GitHub |
| curl | HTTP client |
`;
    const { ast } = parseMd(raw);
    const table = ast.blocks[0]?.tables[0];
    expect(table?.headers).toEqual(['tool', 'guidance']);
    expect(table?.rows).toEqual([
      ['gh', 'use for GitHub'],
      ['curl', 'HTTP client'],
    ]);
  });

  it('T-02 3+ column table', () => {
    const raw = `## H

| a | b | c |
| - | - | - |
| 1 | 2 | 3 |
`;
    const { ast } = parseMd(raw);
    expect(ast.blocks[0]?.tables[0]?.headers).toEqual(['a', 'b', 'c']);
    expect(ast.blocks[0]?.tables[0]?.rows[0]).toEqual(['1', '2', '3']);
  });

  it('T-03 table with alignment colons in separator', () => {
    const raw = `## H

| left | center | right |
| :--- | :---: | ---: |
| a | b | c |
`;
    const { ast } = parseMd(raw);
    expect(ast.blocks[0]?.tables.length).toBe(1);
  });

  it('T-04 table with empty cells', () => {
    const raw = `## H

| a | b |
| - | - |
| 1 |   |
|   | 2 |
`;
    const { ast } = parseMd(raw);
    expect(ast.blocks[0]?.tables[0]?.rows).toEqual([
      ['1', ''],
      ['', '2'],
    ]);
  });

  it('T-05 table with no rows (header + sep only)', () => {
    const raw = `## H

| a | b |
| - | - |
`;
    const { ast } = parseMd(raw);
    expect(ast.blocks[0]?.tables[0]?.headers).toEqual(['a', 'b']);
    expect(ast.blocks[0]?.tables[0]?.rows).toEqual([]);
  });

  it('T-06 multiple tables in same section', () => {
    const raw = `## H

| a | b |
| - | - |
| 1 | 2 |

Some text.

| x | y |
| - | - |
| 3 | 4 |
`;
    const { ast } = parseMd(raw);
    expect(ast.blocks[0]?.tables.length).toBe(2);
  });

  it('T-07 table line numbers track to the header line', () => {
    const raw = `## Section
preamble line
| a | b |
| - | - |
`;
    const { ast } = parseMd(raw);
    expect(ast.blocks[0]?.tables[0]?.line).toBeGreaterThan(0);
  });

  it('T-08 invalid separator (no pipes) — no table extracted', () => {
    const raw = `## H

| a | b |
not a separator
| 1 | 2 |
`;
    const { ast } = parseMd(raw);
    expect(ast.blocks[0]?.tables).toEqual([]);
  });

  it('T-09 single-column table (just `| col |\\n|---|`)', () => {
    const raw = `## H

| col |
| --- |
| value1 |
| value2 |
`;
    const { ast } = parseMd(raw);
    expect(ast.blocks[0]?.tables[0]?.headers).toEqual(['col']);
    expect(ast.blocks[0]?.tables[0]?.rows).toEqual([['value1'], ['value2']]);
  });

  it('T-10 table at end of file with trailing newlines', () => {
    const raw = `## H

| a |
| - |
| 1 |


`;
    const { ast } = parseMd(raw);
    expect(ast.blocks[0]?.tables[0]?.rows).toEqual([['1']]);
  });

  it('T-11 table content with internal whitespace trimmed', () => {
    const raw = `## H

|   col1   |   col2   |
| --- | --- |
|   a   |   b   |
`;
    const { ast } = parseMd(raw);
    expect(ast.blocks[0]?.tables[0]?.headers).toEqual(['col1', 'col2']);
    expect(ast.blocks[0]?.tables[0]?.rows[0]).toEqual(['a', 'b']);
  });
});
