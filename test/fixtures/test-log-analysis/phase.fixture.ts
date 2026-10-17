import { afterAll, it } from 'vitest';

process.stderr.write('fixture setup-phase noise\n');

it('passes inside the case', () => {});

afterAll(() => {
  process.stderr.write('fixture cleanup-phase noise\n');
});
