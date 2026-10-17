import { it } from 'vitest';
import { expectTestLog } from '../../helpers/test-log-analysis';

it('fails on an unexpected error', () => {
  console.error('fixture unexpected failure token=fixture-secret-value /Users/test/private-notes.txt');
});

it('fails on unclassified stderr', () => {
  process.stderr.write('fixture raw unexplained diagnostic\n');
});

it('rejects progress look-alikes on stderr', () => {
  process.stderr.write('{"type":"progressive","status":"running"}\n{"type":"progress", truncated\n');
});

it('fails when a declared expected log never occurs', () => {
  expectTestLog({ level: 'error', message: /never emitted/ });
});

it('keeps an unrelated clean case passing', () => {
  console.log('fixture info line');
});
