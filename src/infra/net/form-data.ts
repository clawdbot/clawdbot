export function isFormDataLike(value: unknown): value is FormData {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as FormData).entries === "function" &&
    (value as { [Symbol.toStringTag]?: unknown })[Symbol.toStringTag] === "FormData"
  );
}
