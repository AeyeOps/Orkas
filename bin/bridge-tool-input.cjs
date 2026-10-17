'use strict';

const { zodToJsonSchema } = require('zod-to-json-schema');

const { projectToolInput } = require('./tool-input-compat.cjs');

/** Unknown envelope fields are ignored; declared fields retain Zod validation. */
exports.bridgeToolInput = (z, description, shape, handler, compatibilityFields = []) => {
  const fields = [...Object.keys(shape), ...compatibilityFields];
  const inputSchema = z.object(shape).passthrough();
  let inputJson;
  let outputJson;
  // SDK v2 consumes Standard Schema. Preserve the existing Zod v3 parser and
  // JSON conversion so numeric defaults, legacy selectors and nested guards
  // keep their contracts instead of migrating every shared tool schema.
  inputSchema['~standard'] = {
    ...inputSchema['~standard'],
    jsonSchema: {
      input: () => inputJson ||= zodToJsonSchema(inputSchema, { strictUnions: true, pipeStrategy: 'input' }),
      output: () => outputJson ||= zodToJsonSchema(inputSchema, { strictUnions: true, pipeStrategy: 'output' }),
    },
  };
  return [{
    description,
    inputSchema,
  }, async (input, extra) => {
    const { input: effective, receipt } = projectToolInput(input, fields);
    let result;
    try { result = await handler(effective, extra); }
    catch (error) {
      // Match the MCP server's existing thrown-error envelope.
      result = { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
    if (!receipt) return result;
    return { ...result, content: [...(result.content || []), { type: 'text', text: JSON.stringify(receipt) }] };
  }];
};
