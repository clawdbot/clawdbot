import { getLineInfo, parse } from "acorn";
import { decodeHTMLAttribute } from "entities";

type WidgetScriptSyntaxError = {
  message: string;
  /** Location in the supplied widget_code: 1-based line, 0-based UTF-16 column. */
  line: number;
  column: number;
  snippet: string;
  /** 1-based index among all scanned script elements, including skipped scripts. */
  scriptIndex: number;
};

/** JavaScript MIME type essences per https://mimesniff.spec.whatwg.org/#javascript-mime-type. */
const JAVASCRIPT_MIME_ESSENCES = new Set([
  "application/ecmascript",
  "application/javascript",
  "application/x-ecmascript",
  "application/x-javascript",
  "text/ecmascript",
  "text/javascript",
  "text/javascript1.0",
  "text/javascript1.1",
  "text/javascript1.2",
  "text/javascript1.3",
  "text/javascript1.4",
  "text/javascript1.5",
  "text/jscript",
  "text/livescript",
  "text/x-ecmascript",
  "text/x-javascript",
]);

function scriptSourceType(attributes: string): "script" | "module" | undefined {
  let type: string | undefined;
  const attributePattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const attribute of attributes.matchAll(attributePattern)) {
    const name = (attribute[1] ?? "").toLowerCase();
    if (name === "src") {
      return undefined;
    }
    if (name === "type") {
      type ??= decodeHTMLAttribute(attribute[2] ?? attribute[3] ?? attribute[4] ?? "")
        .trim()
        .toLowerCase();
    }
  }
  if (type === "module") {
    return "module";
  }
  return !type || JAVASCRIPT_MIME_ESSENCES.has(type) ? "script" : undefined;
}

/** Finds a tag's closing bracket without interpreting quoted attribute values as markup. */
function findTagEnd(html: string, offset: number): number {
  let quote = "";
  for (let index = offset; index < html.length; index++) {
    const char = html[index];
    if (quote) {
      if (char === quote) {
        quote = "";
      }
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return index;
    }
  }
  return html.length;
}

/**
 * Script-looking text in double-escaped data cannot close the script element, and inside
 * foreign (SVG) content a CDATA section keeps everything up to `]]>` as script text.
 */
function findRawTextEnd(html: string, start: number, name: string, foreign: boolean): number {
  const tokens =
    name === "script"
      ? foreign
        ? /<!\[CDATA\[|\]\]>|<!--|-->|<\/?script(?=[\t\n\f\r />])/gi
        : /<!--|-->|<\/?script(?=[\t\n\f\r />])/gi
      : new RegExp(`</${name}(?=[\\t\\n\\f\\r />])`, "gi");
  tokens.lastIndex = start;
  let state: "data" | "escaped" | "double-escaped" | "cdata" = "data";
  for (const match of html.matchAll(tokens)) {
    const token = match[0].toLowerCase();
    if (state === "cdata") {
      if (token === "]]>") {
        state = "data";
      }
    } else if (token === "<![cdata[") {
      state = "cdata";
    } else if (token === "<!--" && state === "data") {
      state = "escaped";
    } else if (token === "-->") {
      state = "data";
    } else if (token.startsWith("</")) {
      if (state !== "double-escaped") {
        return match.index;
      }
      state = "escaped";
    } else if (token === "<script" && state === "escaped") {
      state = "double-escaped";
    }
  }
  return html.length;
}

/**
 * Tracks HTML contexts over the original input so script offsets never need normalization.
 *
 * Scope: SVG support covers CDATA-wrapped scripts, opaque CDATA sections, self-closing foreign
 * elements, and foreignObject switching back to HTML rules. Character references inside foreign
 * script text, CDATA sections interleaved with script text, and SVG nested inside foreignObject
 * are intentionally not modeled; such input yields an explicit tool error, never a hosted widget
 * with a script that cannot run.
 */
export function findWidgetScriptSyntaxError(
  widgetCode: string,
): WidgetScriptSyntaxError | undefined {
  const tagPattern = /<\/?([a-z][^\t\n\f\r />]*)/iy;
  let position = 0;
  let scriptIndex = 0;
  let svgDepth = 0;
  let foreignObjectDepth = 0;
  while (position < widgetCode.length) {
    const start = widgetCode.indexOf("<", position);
    if (start < 0) {
      break;
    }
    position = start + 1;
    if (widgetCode.startsWith("<!--", start)) {
      const end = widgetCode.indexOf("-->", start + 4);
      position = end < 0 ? widgetCode.length : end + 3;
      continue;
    }
    // foreignObject is an HTML integration point, so its children follow HTML rules again.
    const foreign = svgDepth > 0 && foreignObjectDepth === 0;
    if (foreign && widgetCode.startsWith("<![CDATA[", start)) {
      const end = widgetCode.indexOf("]]>", start + 9);
      position = end < 0 ? widgetCode.length : end + 3;
      continue;
    }
    tagPattern.lastIndex = start;
    const tag = tagPattern.exec(widgetCode);
    if (!tag) {
      if (widgetCode[position] === "!" || widgetCode[position] === "/") {
        position = findTagEnd(widgetCode, position + 1) + 1;
      }
      continue;
    }
    const attributesStart = tagPattern.lastIndex;
    const tagEnd = findTagEnd(widgetCode, attributesStart);
    position = tagEnd + 1;
    if (tagEnd === widgetCode.length) {
      continue;
    }
    const name = (tag[1] ?? "").toLowerCase();
    const closing = widgetCode[start + 1] === "/";
    const selfClosing = widgetCode[tagEnd - 1] === "/";
    if (name === "svg") {
      svgDepth = closing ? Math.max(0, svgDepth - 1) : svgDepth + (selfClosing ? 0 : 1);
    } else if (name === "foreignobject" && svgDepth > 0) {
      foreignObjectDepth = closing
        ? Math.max(0, foreignObjectDepth - 1)
        : foreignObjectDepth + (selfClosing ? 0 : 1);
    }
    if (closing) {
      continue;
    }
    if (name === "plaintext") {
      break;
    }
    if (!/^(?:script|style|textarea|title|xmp|iframe|noembed|noframes|noscript)$/.test(name)) {
      continue;
    }
    // Foreign content honors self-closing start tags; HTML content ignores the slash.
    if (foreign && selfClosing) {
      continue;
    }
    let bodyStart = position;
    const bodyEnd = findRawTextEnd(widgetCode, bodyStart, name, foreign);
    const closingBracket = bodyEnd < widgetCode.length ? widgetCode.indexOf(">", bodyEnd) : -1;
    position = closingBracket < 0 ? widgetCode.length : closingBracket + 1;
    if (name !== "script") {
      continue;
    }
    scriptIndex++;
    const sourceType = scriptSourceType(widgetCode.slice(attributesStart, tagEnd));
    if (!sourceType) {
      continue;
    }
    let body = widgetCode.slice(bodyStart, bodyEnd);
    const trimmed = body.trim();
    if (foreign && trimmed.startsWith("<![CDATA[") && trimmed.endsWith("]]>")) {
      bodyStart += body.length - body.trimStart().length + "<![CDATA[".length;
      body = trimmed.slice("<![CDATA[".length, -"]]>".length);
    }
    try {
      parse(body, { ecmaVersion: "latest", sourceType });
    } catch (error) {
      if (!(error instanceof SyntaxError) || !("pos" in error) || typeof error.pos !== "number") {
        throw error;
      }
      const offset = bodyStart + error.pos;
      const { line, column } = getLineInfo(widgetCode, offset);
      const snippet = (widgetCode.slice(offset - column).split(/[\r\n\u2028\u2029]/u, 1)[0] ?? "")
        .trim()
        .slice(0, 160);
      return {
        message: error.message.replace(/ \(\d+:\d+\)$/u, "").slice(0, 200),
        line,
        column,
        snippet,
        scriptIndex,
      };
    }
  }
  return undefined;
}
