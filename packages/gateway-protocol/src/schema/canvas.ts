import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";

export const CanvasDocumentViewParamsSchema = closedObject({
  docId: Type.String({ minLength: 1, maxLength: 256, pattern: "^(?!\\.{1,2}$)[A-Za-z0-9._-]+$" }),
});

export const CanvasDocumentViewResultSchema = closedObject({
  html: Type.String({ maxLength: 2 * 1024 * 1024 }),
  sandboxUrl: Type.String(),
  sandboxPort: Type.Integer({ minimum: 1, maximum: 65535 }),
  sandboxOrigin: Type.Optional(Type.String()),
});

export type CanvasDocumentViewParams = Static<typeof CanvasDocumentViewParamsSchema>;
export type CanvasDocumentViewResult = Static<typeof CanvasDocumentViewResultSchema>;
