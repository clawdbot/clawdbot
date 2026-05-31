import type { ServerResponse } from "node:http";
import { lowercasePreservingWhitespace } from "@openclaw/normalization-core/string-coerce";

export function createMockServerResponse(): ServerResponse & { body?: string } {
  const headers: Record<string, string> = {};
  const res: {
    headersSent: boolean;
    statusCode: number;
    body?: string;
    setHeader: (key: string, value: string) => unknown;
    getHeader: (key: string) => string | undefined;
    end: (body?: string) => unknown;
  } = {
    headersSent: false,
    statusCode: 200,
    setHeader: (key: string, value: string) => {
      headers[lowercasePreservingWhitespace(key)] = value;
      return res;
    },
    getHeader: (key: string) => headers[lowercasePreservingWhitespace(key)],
    end: (body?: string) => {
      res.headersSent = true;
      res.body = body;
      return res;
    },
  };
  return res as unknown as ServerResponse & { body?: string };
}
