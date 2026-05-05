import { test, expect } from 'vitest';

test('no-op', async () => {
  await expect(true).toEqual(true);
});
