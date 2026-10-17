export type InputReceipt = {
  ignored_fields: string[];
  ignored_field_count?: number;
  ignored_fields_truncated?: boolean;
};
export function projectToolInput<T>(input: T, fields?: readonly string[]): { input: T; receipt: InputReceipt | null };
export function appendInputReceipt(content: string, receipt: InputReceipt | null): string;
export function defaultNumericRange(value: unknown, fallback: unknown, min: number, max: number, integer?: boolean): unknown;
