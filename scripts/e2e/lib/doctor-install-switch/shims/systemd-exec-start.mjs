export function parseSystemdExecStart(value) {
  const words = [];
  let word = "";
  let quote = "";
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      word += character;
      escaped = false;
    } else if (character === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (character === quote) {
        quote = "";
      } else {
        word += character;
      }
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (/\s/u.test(character)) {
      if (word) {
        words.push(word);
        word = "";
      }
    } else {
      word += character;
    }
  }
  if (quote || escaped) {
    throw new Error("Invalid systemd ExecStart quoting.");
  }
  if (word) {
    words.push(word);
  }
  return words;
}
