import { describe, expect, it } from 'vitest';
import { mergeThreeWayText } from '../../../src/main/util/three-way-text';

describe('exact three-way text merge', () => {
  const base = '## Rules\nfirst\nseparator\nlast\n';
  it('preserves independent same-section changes in either device order', () => {
    const left = '## Rules\nlocal first\nseparator\nlast\n';
    const right = '## Rules\nfirst\nseparator\ncloud last\n';
    const expected = '## Rules\nlocal first\nseparator\ncloud last\n';
    expect(mergeThreeWayText(base, left, right)).toBe(expected);
    expect(mergeThreeWayText(base, right, left)).toBe(expected);
  });
  it.each([
    ['same-line phrases', 'Use logs; keep backups.\n', 'Use traces; keep backups.\n', 'Use logs; keep snapshots.\n', 'Use traces; keep snapshots.\n'],
    ['Chinese phrases', '排查日志；保留备份。\n', '排查链路；保留备份。\n', '排查日志；保留快照。\n', '排查链路；保留快照。\n'],
    ['shared insertion before replacement', 'a\nb\n', 'a\nx\nb\n', 'a\nx\nB\n', 'a\nx\nB\n'],
    ['shared insertion after replacement', 'a\nb\n', 'a\nx\nb\n', 'A\nx\nb\n', 'A\nx\nb\n'],
    ['shared insertion and deletion', 'a\nb\nc\n', 'a\nx\nb\nc\n', 'a\nx\nc\n', 'a\nx\nc\n'],
    ['Unicode and line endings', '👩‍💻 logs; backups\r\n', '👩‍💻 traces; backups\r\n', '👩‍💻 logs; snapshots\r\n', '👩‍💻 traces; snapshots\r\n'],
  ])('merges %s exactly in either device order', (_name, ancestor, left, right, expected) => {
    expect(mergeThreeWayText(ancestor, left, right)).toBe(expected);
    expect(mergeThreeWayText(ancestor, right, left)).toBe(expected);
  });
  it('preserves a deletion and an unrelated addition without resurrecting deleted text', () => {
    expect(mergeThreeWayText(base, '## Rules\nseparator\nlast\n', base + 'new\n'))
      .toBe('## Rules\nseparator\nlast\nnew\n');
  });
  it.each([
    ['opposite instructions', '## Rules\nALWAYS publish\n', '## Rules\nNEVER publish\n', '## Rules\npublish with approval\n'],
    ['delete versus edit', 'first\nlast\n', 'first\nchanged\nlast\n', 'first\nmiddle\nlast\n'],
    ['different insertions at one point', 'a\nleft\nb\n', 'a\nright\nb\n', 'a\nb\n'],
    ['opposite changes to one word', 'Use ALWAYS; keep backups.\n', 'Use NEVER; keep backups.\n', 'Use MAYBE; keep backups.\n'],
    ['different edits within one word', 'cat\n', 'bar\n', 'car\n'],
    ['insertion at a changed boundary', 'a\nx\nb\n', 'a\nB\n', 'a\nb\n'],
  ])('preserves ambiguity: %s', (_label, left, right, ancestor) => {
    expect(mergeThreeWayText(ancestor, left, right)).toBeNull();
    expect(mergeThreeWayText(ancestor, right, left)).toBeNull();
  });
  it('deduplicates identical concurrent edits while retaining another change', () => {
    expect(mergeThreeWayText('a\nb\nc\nd\n', 'A\nb\nc\nd\n', 'A\nb\nc\nD\n'))
      .toBe('A\nb\nc\nD\n');
  });
  it('handles empty origins, one-sided deletion and exact line endings', () => {
    expect(mergeThreeWayText('', '', 'new')).toBe('new');
    expect(mergeThreeWayText(base, '', base)).toBe('');
    expect(mergeThreeWayText('a\r\nb\r\nc', 'A\r\nb\r\nc', 'a\r\nb\r\nC'))
      .toBe('A\r\nb\r\nC');
  });
  it('rejects newline-heavy divergent documents within a bounded work budget', () => {
    const original = 'x\n'.repeat(2000);
    expect(mergeThreeWayText(original, 'left\n' + original, original + 'right\n')).toBeNull();
  });
  it('keeps same-line fallback bounded for punctuation-heavy notes', () => {
    const original = Array.from({ length: 1200 }, (_, index) => `w${index};`).join('');
    const left = original.replace('w0;', 'left0;').replace('w1199;', 'left1199;');
    const right = original.replace('w1;', 'right1;').replace('w1198;', 'right1198;');
    // These four word edits are independent, but their divergent spans exceed
    // the fine-diff budget. Keep both candidates rather than unbounded work.
    expect(mergeThreeWayText(original, left, right)).toBeNull();
  });
  it('gives both devices the same result with repeated lines and ambiguous alignments', () => {
    const documents = [''];
    for (let size = 1; size <= 4; size++) {
      for (let bits = 0; bits < 2 ** size; bits++) {
        documents.push(Array.from({ length: size }, (_, index) => bits & (1 << index) ? 'a\n' : 'b\n').join(''));
      }
    }
    for (const ancestor of documents.slice(0, 7)) {
      for (const left of documents) for (const right of documents) {
        expect(mergeThreeWayText(ancestor, left, right)).toBe(mergeThreeWayText(ancestor, right, left));
      }
    }
  });
});
