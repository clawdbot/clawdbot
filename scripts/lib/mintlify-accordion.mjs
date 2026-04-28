export const MINTLIFY_ACCORDION_INDENT_MESSAGE =
  "Mintlify component closing tag is indented deeper than its opening tag; Mintlify can parse following markdown as nested content.";

const MINTLIFY_REPAIRED_COMPONENTS = new Set([
  "Accordion",
  "Warning",
  "Note",
  "Tip",
  "ParamField",
  "Steps",
  "Step",
]);

function visitMintlifyComponentIndentation(raw, onMisindentedClose, onMisindentedOpen) {
  const lines = raw.split(/\r?\n/u);
  const componentStack = [];
  let inCodeFence = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*(```|~~~)/u.test(line)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) {
      continue;
    }

    const openComponent = line.match(/^(\s*)<([A-Z][A-Za-z0-9]*)\b/u);
    if (openComponent && MINTLIFY_REPAIRED_COMPONENTS.has(openComponent[2])) {
      let indent = openComponent[1].length;
      if (componentStack.length === 0 && openComponent[2] === "ParamField" && indent > 0) {
        onMisindentedOpen?.({ openComponent, index, line, lines });
        indent = 0;
      }
      componentStack.push({
        indent,
        name: openComponent[2],
      });
      continue;
    }

    const closeComponent = line.match(/^(\s*)<\/([A-Z][A-Za-z0-9]*)>/u);
    if (!closeComponent || !MINTLIFY_REPAIRED_COMPONENTS.has(closeComponent[2])) {
      continue;
    }

    const opening = componentStack.pop();
    if (opening?.name === closeComponent[2] && closeComponent[1].length > opening.indent) {
      onMisindentedClose({ closeComponent, index, line, lines, opening });
    }
  }

  return lines;
}

export function checkMintlifyAccordionIndentation(raw) {
  const errors = [];
  visitMintlifyComponentIndentation(raw, ({ closeComponent, index }) => {
    errors.push({
      line: index + 1,
      column: closeComponent[1].length + 1,
      message: MINTLIFY_ACCORDION_INDENT_MESSAGE,
    });
  });
  return errors;
}

export function repairMintlifyAccordionIndentation(raw) {
  let changed = false;
  const lines = visitMintlifyComponentIndentation(
    raw,
    ({ closeComponent, index, line, lines, opening }) => {
      lines[index] = `${" ".repeat(opening.indent)}${line.slice(closeComponent[1].length)}`;
      changed = true;
    },
    ({ openComponent, index, line, lines }) => {
      lines[index] = line.slice(openComponent[1].length);
      changed = true;
    },
  );
  for (let index = lines.length - 1; index > 0; index--) {
    if (!/^\s*<\/[A-Z][A-Za-z0-9]*>/u.test(lines[index])) {
      continue;
    }
    if (!/^\s*[-*+]\s+/u.test(lines[index - 1])) {
      continue;
    }
    lines.splice(index, 0, "");
    changed = true;
  }
  return changed ? lines.join("\n") : raw;
}
