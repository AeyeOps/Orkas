/** Exact, bounded text merge. Try lines first, then words/punctuation when
 * line edits overlap. Never normalize bytes or interpret note semantics.
 * A shared insertion may border another edit; distinct insertions, overlapping
 * words and delete/edit conflicts stay ambiguous. Bound total DP work. */
type Edit = { start: number; end: number; lines: string[] };
const MAX_CHARS = 32_768;
const MAX_CELLS = 1_000_000;
type Budget = { remaining: number };

function edits(base: string[], next: string[], budget: Budget, trim: boolean): Edit[] | null {
  let offset = 0;
  if (trim) {
    while (offset < base.length && offset < next.length && base[offset] === next[offset]) offset++;
    let tail = 0;
    while (tail < base.length - offset && tail < next.length - offset
      && base[base.length - tail - 1] === next[next.length - tail - 1]) tail++;
    base = base.slice(offset, base.length - tail);
    next = next.slice(offset, next.length - tail);
  }
  const width = next.length + 1;
  const cells = (base.length + 1) * width;
  if (cells > MAX_CELLS || cells > budget.remaining) return null;
  budget.remaining -= cells;
  const table = new Uint32Array(cells);
  for (let i = base.length - 1; i >= 0; i--) {
    for (let j = next.length - 1; j >= 0; j--) {
      table[i * width + j] = base[i] === next[j]
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const out: Edit[] = [];
  let i = 0, j = 0;
  while (i < base.length || j < next.length) {
    if (i < base.length && j < next.length && base[i] === next[j]) { i++; j++; continue; }
    const edit: Edit = { start: i, end: i, lines: [] };
    while (i < base.length || j < next.length) {
      if (i < base.length && j < next.length && base[i] === next[j]) break;
      if (j < next.length && (i === base.length || table[i * width + j + 1] >= table[(i + 1) * width + j])) {
        edit.lines.push(next[j++]);
      } else { i++; }
    }
    edit.start += offset;
    edit.end = i + offset;
    out.push(edit);
  }
  return out;
}

function sameEdit(a: Edit, b: Edit): boolean {
  return a.start === b.start && a.end === b.end && a.lines.join('') === b.lines.join('');
}

/** LCS may combine a common insertion with an adjacent replacement. Split
 * only when the other side inserts those exact units at the same boundary. */
function splitSharedInsertions(source: Edit[], other: Edit[]): Edit[] {
  const insertions = new Map(other.filter(edit => edit.start === edit.end).map(edit => [edit.start, edit]));
  return source.flatMap(original => {
    if (original.start === original.end) return [original];
    let edit = original;
    const result: Edit[] = [];
    const before = insertions.get(edit.start);
    if (before && before.lines.length <= edit.lines.length
      && before.lines.every((unit, i) => unit === edit.lines[i])) {
      result.push(before);
      edit = { ...edit, lines: edit.lines.slice(before.lines.length) };
    }
    const after = insertions.get(edit.end);
    if (after && after.lines.length <= edit.lines.length
      && after.lines.every((unit, i) => unit === edit.lines[edit.lines.length - after.lines.length + i])) {
      result.push({ ...edit, lines: edit.lines.slice(0, -after.lines.length) }, after);
    } else result.push(edit);
    return result;
  });
}

function overlaps(a: Edit, b: Edit): boolean {
  if (a.start === a.end) return a.start >= b.start && a.start <= b.end;
  if (b.start === b.end) return b.start >= a.start && b.start <= a.end;
  return a.start < b.end && b.start < a.end;
}

function combine(base: string[], leftEdits: Edit[], rightEdits: Edit[]): string | null {
  const left = splitSharedInsertions(leftEdits, rightEdits);
  const right = splitSharedInsertions(rightEdits, left);
  const leftInsertions = new Map(left.filter(edit => edit.start === edit.end).map(edit => [edit.start, edit]));
  const sharedInsertions = new Set(right.filter(edit => edit.start === edit.end
    && leftInsertions.has(edit.start) && sameEdit(leftInsertions.get(edit.start)!, edit)).map(edit => edit.start));
  const combined = [...left];
  for (const edit of right) {
    let duplicate = false;
    for (const prior of left) {
      if (sameEdit(prior, edit)) {
        duplicate = true; break;
      }
      if (overlaps(prior, edit)) {
        const insertion = prior.start === prior.end ? prior : edit.start === edit.end ? edit : null;
        const replacement = insertion === prior ? edit : prior;
        if (!insertion || !sharedInsertions.has(insertion.start)
          || (insertion.start !== replacement.start && insertion.start !== replacement.end)) return null;
      }
    }
    if (!duplicate) combined.push(edit);
  }
  combined.sort((a, b) => a.start - b.start || a.end - b.end);
  const output: string[] = [];
  let position = 0;
  for (const edit of combined) {
    output.push(...base.slice(position, edit.start), ...edit.lines);
    position = edit.end;
  }
  output.push(...base.slice(position));
  return output.join('');
}

export function mergeThreeWayText(baseText: string, local: string, remote: string): string | null {
  if (local === remote) return local;
  if (baseText === local) return remote;
  if (baseText === remote) return local;
  if ([baseText, local, remote].some(text => text.length > MAX_CHARS)) return null;
  const budget = { remaining: MAX_CELLS * 2 };
  // Keep line terminators as content, including the final-newline distinction.
  const split = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) || [];
  const base = split(baseText);
  const left = edits(base, split(local), budget, false);
  const right = edits(base, split(remote), budget, false);
  if (!left || !right) return null;
  const merged = combine(base, left, right);
  if (merged !== null) return merged;
  // Whole words avoid manufacturing a third word from incompatible spelling
  // edits. Unicode code points keep surrogate pairs intact; whitespace and
  // punctuation remain exact units, never normalization or semantic anchors.
  const units = (text: string) => text.match(/[\p{L}\p{N}_]+|[^\p{L}\p{N}_]/gu) || [];
  const fineBase = units(baseText);
  const fineLeft = edits(fineBase, units(local), budget, true);
  const fineRight = edits(fineBase, units(remote), budget, true);
  return fineLeft && fineRight ? combine(fineBase, fineLeft, fineRight) : null;
}
