/**
 * Wave 7 — OcPath parsing edges.
 *
 * Substrate guarantee: `parseOcPath(s)` is a pure function. Valid input
 * round-trips via `formatOcPath`; invalid input throws `OcPathError`
 * with a stable `code`.
 */
import { describe, expect, it } from 'vitest';
import {
  OcPathError,
  formatOcPath,
  getPathLayout,
  isPattern,
  isValidOcPath,
  parseOcPath,
} from '../../oc-path.js';

function expectErr(fn: () => unknown, code: string): void {
  try {
    fn();
    expect.fail(`expected OcPathError code ${code}`);
  } catch (err) {
    expect(err).toBeInstanceOf(OcPathError);
    expect((err as OcPathError).code).toBe(code);
  }
}

describe('wave-07 oc-path-parse-edges', () => {
  it('OP-01 file-only', () => {
    expect(parseOcPath('oc://SOUL.md')).toEqual({ file: 'SOUL.md' });
  });

  it('OP-02 file + section', () => {
    expect(parseOcPath('oc://SOUL.md/Boundaries').section).toBe('Boundaries');
  });

  it('OP-03 file + section + item', () => {
    expect(parseOcPath('oc://SOUL.md/Boundaries/deny-rule-1').item).toBe('deny-rule-1');
  });

  it('OP-04 file + section + item + field', () => {
    expect(parseOcPath('oc://SOUL.md/B/deny-1/risk').field).toBe('risk');
  });

  it('OP-05 session query parameter', () => {
    expect(parseOcPath('oc://X.md?session=daily').session).toBe('daily');
  });

  it('OP-06 session with full path', () => {
    const p = parseOcPath('oc://X.md/sec/item/field?session=cron');
    expect(p).toEqual({
      file: 'X.md',
      section: 'sec',
      item: 'item',
      field: 'field',
      session: 'cron',
    });
  });

  it('OP-07 unknown query parameters silently ignored', () => {
    const p = parseOcPath('oc://X.md?foo=bar&session=s&baz=qux');
    expect(p.session).toBe('s');
  });

  it('OP-08 session= with empty value drops session', () => {
    const p = parseOcPath('oc://X.md?session=');
    expect(p.session).toBeUndefined();
  });

  it('OP-09 query without `=` ignored', () => {
    const p = parseOcPath('oc://X.md?nokeyhere');
    expect(p.session).toBeUndefined();
  });

  it('OP-10 missing scheme throws', () => {
    expectErr(() => parseOcPath('SOUL.md'), 'OC_PATH_MISSING_SCHEME');
  });

  it('OP-11 wrong scheme throws', () => {
    expectErr(() => parseOcPath('https://x.com'), 'OC_PATH_MISSING_SCHEME');
  });

  it('OP-12 empty after scheme throws', () => {
    expectErr(() => parseOcPath('oc://'), 'OC_PATH_EMPTY');
  });

  it('OP-13 empty segment throws', () => {
    expectErr(() => parseOcPath('oc://X.md//item'), 'OC_PATH_EMPTY_SEGMENT');
  });

  it('OP-14 too-deep nesting throws', () => {
    expectErr(() => parseOcPath('oc://X.md/a/b/c/d/e'), 'OC_PATH_TOO_DEEP');
  });

  it('OP-15 non-string throws', () => {
    expectErr(() => parseOcPath(42 as unknown as string), 'OC_PATH_NOT_STRING');
  });

  it('OP-16 round-trip canonical forms', () => {
    const cases = [
      'oc://SOUL.md',
      'oc://SOUL.md/Boundaries',
      'oc://SOUL.md/Boundaries/deny-rule-1',
      'oc://SOUL.md/Boundaries/deny-rule-1/risk',
      'oc://SOUL.md?session=daily',
      'oc://X.md/a/b/c?session=s',
      'oc://skills/email-drafter/[frontmatter]/name',
      'oc://config/plugins.entries.foo.token',
    ];
    for (const c of cases) {
      expect(formatOcPath(parseOcPath(c)), `round-trip failed for ${c}`).toBe(c);
    }
  });

  it('OP-17 isValidOcPath true positives', () => {
    expect(isValidOcPath('oc://X.md')).toBe(true);
    expect(isValidOcPath('oc://X.md/sec/item/field')).toBe(true);
  });

  it('OP-18 isValidOcPath true negatives', () => {
    expect(isValidOcPath('')).toBe(false);
    expect(isValidOcPath('X.md')).toBe(false);
    expect(isValidOcPath('oc://')).toBe(false);
    expect(isValidOcPath('oc://x//y')).toBe(false);
    expect(isValidOcPath(null)).toBe(false);
    expect(isValidOcPath({})).toBe(false);
  });

  it('OP-19 file segment with special chars (file with dots/slashes)', () => {
    const p = parseOcPath('oc://config/plugins.entries.foo.token');
    expect(p.file).toBe('config');
    expect(p.section).toBe('plugins.entries.foo.token');
  });

  it('OP-20 section segment with hyphens / underscores / numbers', () => {
    const p = parseOcPath('oc://X.md/Multi-Tenant_Section_2');
    expect(p.section).toBe('Multi-Tenant_Section_2');
  });

  it('OP-21 [frontmatter] sentinel is just a section name', () => {
    const p = parseOcPath('oc://X.md/[frontmatter]/name');
    expect(p.section).toBe('[frontmatter]');
    expect(p.item).toBe('name');
  });

  it('OP-22 formatOcPath rejects empty file', () => {
    expectErr(() => formatOcPath({ file: '' }), 'OC_PATH_FILE_REQUIRED');
  });

  it('OP-23 formatOcPath rejects item without section', () => {
    expectErr(() => formatOcPath({ file: 'X.md', item: 'i' }), 'OC_PATH_NESTING');
  });

  it('OP-24 formatOcPath quotes raw slot values containing special chars', () => {
    // Closes ClawSweeper P2 on PR #78678: `formatOcPath` previously
    // concatenated raw slot values, so a programmatically-constructed
    // path with a `/` in the section/item slot would emit extra
    // segments and fail to parse back to the same address.
    // Use a slot value with `/` (and no internal `.`) — `.` inside
    // a slot is the dotted sub-segment delimiter; callers wanting a
    // literal `.` in a key should pre-quote that single sub-segment.
    const constructed = formatOcPath({
      file: 'config.jsonc',
      section: 'agents.defaults.models',
      item: 'github-copilot/claude-opus-4-7',
      field: 'alias',
    });
    expect(constructed).toBe(
      'oc://config.jsonc/agents.defaults.models/"github-copilot/claude-opus-4-7"/alias',
    );
    const parsed = parseOcPath(constructed);
    expect(parsed.item).toBe('"github-copilot/claude-opus-4-7"');
  });

  it('OP-25 parseOcPath finds query separator outside quoted keys', () => {
    // Closes ClawSweeper P2 on PR #78678: `parseOcPath` previously
    // used `indexOf('?')` which split a key like `"foo?bar"` at the
    // embedded `?`, breaking advertised quoted-segment support.
    const parsed = parseOcPath('oc://config.jsonc/"foo?bar"?session=daily');
    expect(parsed.section).toBe('"foo?bar"');
    expect(parsed.session).toBe('daily');
  });

  it('OP-26 file slot with `/` round-trips via quoting', () => {
    // Closes ClawSweeper P2 on PR #78678 (round 4): `parseOcPath` stored
    // `path.file` verbatim while `formatOcPath` prefixed it without
    // quote-wrapping, so a file like `skills/email-drafter` couldn't
    // round-trip — formatter output got re-parsed as file plus section,
    // and quoted input leaked the surrounding quotes into filesystem
    // resolution.
    const constructed = formatOcPath({
      file: 'skills/email-drafter',
      section: 'Tools',
      item: '-1',
    });
    expect(constructed).toBe('oc://"skills/email-drafter"/Tools/-1');
    const parsed = parseOcPath(constructed);
    expect(parsed.file).toBe('skills/email-drafter');
    expect(parsed.section).toBe('Tools');
    expect(parsed.item).toBe('-1');
  });

  it('OP-27 file slot with dot extension does NOT get quoted', () => {
    // The file slot's quoting trigger excludes `.` because filename
    // extensions (`AGENTS.md`, `gateway.jsonc`) are normal — quoting
    // them would make canonical form ugly without need.
    expect(formatOcPath({ file: 'AGENTS.md' })).toBe('oc://AGENTS.md');
    expect(formatOcPath({ file: 'gateway.jsonc', section: 'version' })).toBe(
      'oc://gateway.jsonc/version',
    );
  });

  it('OP-28 formatOcPath rejects field without item or section', () => {
    // Closes Galin P2 (round 8): the nesting guard caught
    // `field + section + no item` but missed `field + no section + no item`.
    // Such a struct emits `oc://FILE/FIELD` which silently re-parses as
    // `{ file, section: FIELD }` — different shape, breaking round-trip.
    expect(() => formatOcPath({ file: 'X', field: 'name' })).toThrow(OcPathError);
    try {
      formatOcPath({ file: 'X', field: 'name' });
    } catch (err) {
      expect(err).toBeInstanceOf(OcPathError);
      expect((err as OcPathError).code).toBe('OC_PATH_NESTING');
    }
  });

  it('OP-29 isPattern is quote-aware (literal `*` inside quoted segment)', () => {
    // Closes Galin P2 (round 8): `isPattern` previously used
    // `slot.split('.')` which shredded a quoted key like `"items.*.glob"`
    // and falsely detected the literal `*` as a wildcard, causing
    // single-match verbs to reject a concrete path.
    const concrete = parseOcPath('oc://config.jsonc/"items.*.glob"');
    expect(isPattern(concrete)).toBe(false);

    // Sanity: an unquoted `*` IS still a wildcard.
    const wildcard = parseOcPath('oc://config.jsonc/items/*');
    expect(isPattern(wildcard)).toBe(true);
  });

  it('OP-30 getPathLayout is quote-aware', () => {
    // Closes Galin P2 (round 8): `getPathLayout` used `slot.split('.')`
    // for all three slots, breaking the find-walker / repackPath layout
    // contract for quoted segments containing `.`.
    const path = parseOcPath('oc://config.jsonc/"github.com"/repos');
    const layout = getPathLayout(path);
    // Quoted segment is one sub-segment, not two.
    expect(layout.sectionLen).toBe(1);
    expect(layout.subs[0]).toBe('"github.com"');
    expect(layout.itemLen).toBe(1);
    expect(layout.subs[1]).toBe('repos');
  });
});
