/** Compact sequential SDK ids without expiring replay protection. Legacy/custom
 * ids remain supported; out-of-order calls and cancel-before-call are remembered. */
export const REQUEST_HISTORY_CAPACITY = 8192;
export class RequestHistory {
  private units = 0;
  private exhausted = false;
  private documents = new Map<string, Array<[number, number]>>();
  private other = new Set<string>();
  private lowerBound(ranges:Array<[number,number]>, n:number):number {
    let low=0, high=ranges.length;
    while(low<high){const mid=(low+high)>>>1;if(ranges[mid][1]<n)low=mid+1;else high=mid;}
    return low;
  }
  private sequence(id: string): { document: string; n: number } | null {
    const match = /^((?:d[a-f0-9]{32})?q)([1-9][0-9]*)$/.exec(id);
    if (!match) return null;
    const n = Number(match[2]);
    return Number.isSafeInteger(n) ? { document: match[1], n } : null;
  }
  has(id: string): boolean {
    const sequence = this.sequence(id);
    if(sequence===null)return this.other.has(id);
    const ranges=this.documents.get(sequence.document)??[];
    const range=ranges[this.lowerBound(ranges,sequence.n)];
    return !!range&&range[0]<=sequence.n;
  }
  add(id: string): boolean {
    // Accepted work must remain cancellable even after saturation.
    if (this.has(id)) return true;
    if (this.exhausted) return false;
    const sequence = this.sequence(id);
    if (sequence === null) {
      if (!this.reserve(1)) return false;
      this.other.add(id); return true;
    }
    const { document, n } = sequence;
    const ranges = this.documents.get(document)??[];
    let i = this.lowerBound(ranges,n-1);
    let start = n, end = n;
    const first = i;
    while (i < ranges.length && ranges[i][0] <= end + 1) {
      start = Math.min(start, ranges[i][0]);
      end = Math.max(end, ranges[i][1]);
      i++;
    }
    if (!this.reserve(1 - (i - first) + (this.documents.has(document) ? 0 : 1))) return false;
    ranges.splice(first, i - first, [start, end]);
    this.documents.set(document,ranges);
    return true;
  }
  private reserve(delta: number): boolean {
    if (this.units + delta > REQUEST_HISTORY_CAPACITY) { this.exhausted = true; return false; }
    this.units += delta; return true;
  }
  clear(): void { this.documents.clear(); this.other.clear(); this.units = 0; this.exhausted = false; }
}
