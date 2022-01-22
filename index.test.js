const process = require('process');
const cp = require('child_process');
const path = require('path');

test('no-op', async () => {
  await expect(true).toEqual(true);
});
