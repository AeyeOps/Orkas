'use strict';

const { projectToolInput } = require('./tool-input-compat.cjs');

/** Unknown envelope fields are ignored; declared fields retain Zod validation. */
exports.bridgeToolInput = (z, description, shape, handler, compatibilityFields = []) => {
  const fields = [...Object.keys(shape), ...compatibilityFields];
  const inputSchema = z.object(shape).passthrough();
  const jsonSchemaOptions = {
    target: 'draft-7',
    reused: 'inline',
    unrepresentable: ({ zodSchema }) => zodSchema instanceof z.ZodCatch ? 'any' : 'throw',
    override: ({ zodSchema, jsonSchema }) => {
      if (zodSchema === inputSchema) jsonSchema.additionalProperties = true;
    },
  };
  let inputJson;
  let outputJson;
  inputSchema['~standard'] = {
    ...inputSchema['~standard'],
    jsonSchema: {
      input: () => inputJson ||= z.toJSONSchema(inputSchema, { ...jsonSchemaOptions, io: 'input' }),
      output: () => outputJson ||= z.toJSONSchema(inputSchema, { ...jsonSchemaOptions, io: 'output' }),
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
