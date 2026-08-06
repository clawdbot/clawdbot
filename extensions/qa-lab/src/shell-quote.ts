// POSIX shell quoting for generated QA command previews and guest scripts.
export function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
