'use strict';

process.on('disconnect', () => process.exit(0));
process.on('message', async ({ id, modulePath, input }) => {
  try {
    process.send({ id, ok: true, result: await require(modulePath)(input) });
  } catch (error) {
    process.send({ id, ok: false, message: error.message, code: error.code });
  }
});
