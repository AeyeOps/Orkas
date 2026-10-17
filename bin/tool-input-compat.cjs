'use strict';

// Opt-in numeric controls only. Callers supply their existing default/bounds;
// malformed values pass through to the owning validator, never get coerced.
exports.defaultNumericRange = (value, fallback, min, max, integer = true) =>
  typeof value === 'number' && Number.isFinite(value)
    && (!integer || Number.isInteger(value)) && (value < min || value > max)
    ? fallback : value;

// Shared by native execution and the MCP bridge. Only the tool argument
// envelope is projected: nested documents, provider args and maps belong to
// the owning validator. No field-name heuristics or value coercion.
exports.projectToolInput = (input, fields) => {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !fields) {
    return { input, receipt: null };
  }
  const allowed = new Set(fields);
  const keys = Object.keys(input);
  const ignored = [];
  let count = 0;
  let truncated = false;
  for (const key of keys) {
    if (!allowed.has(key)) {
      count++;
      if (ignored.length < 10) {
        ignored.push(key.length > 80 ? `${key.slice(0, 80)}…` : key);
        if (key.length > 80) truncated = true;
      } else truncated = true;
    }
  }
  if (!count) return { input, receipt: null };
  const effective = {};
  for (const key of keys) {
    if (allowed.has(key)) Object.defineProperty(effective, key, { value: input[key], enumerable: true, writable: true, configurable: true });
  }
  return { input: effective, receipt: {
    ignored_fields: ignored,
    ...(truncated ? { ignored_field_count: count, ignored_fields_truncated: true } : {}),
  } };
};

exports.appendInputReceipt = (content, receipt) => {
  if (!receipt) return content;
  try {
    const value = JSON.parse(content);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      // Keep an executor's action-specific receipt as well as envelope extras.
      const previous = Array.isArray(value.ignored_fields) ? value.ignored_fields : [];
      const names = [...new Set([...previous, ...receipt.ignored_fields])];
      const count = (value.ignored_field_count ?? previous.length)
        + (receipt.ignored_field_count ?? receipt.ignored_fields.length);
      return JSON.stringify({ ...value, ...receipt,
        ignored_fields: names.slice(0, 10).map(name => String(name).length > 80 ? `${String(name).slice(0, 80)}…` : String(name)),
        ...(count > 10 || names.some(name => String(name).length > 80) || value.ignored_fields_truncated || receipt.ignored_fields_truncated
          ? { ignored_field_count: count, ignored_fields_truncated: true } : {}),
      });
    }
    // JSON scalars/arrays have no metadata slot. Preserve their exact value
    // inside an explicit result envelope rather than produce invalid JSON.
    return JSON.stringify({ result: value, ...receipt });
  } catch {
    return `${content}\n${JSON.stringify(receipt)}`;
  }
};
