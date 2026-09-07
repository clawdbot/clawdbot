import { expect, it } from "vitest";
import { findMarkdownImageSpans } from "./image-spans.js";

it("keeps image offsets, references and output arrays local across successive documents", () => {
  const first =
    "A\r\n![one](a.png)\r\n\r\n![![nested](ignored.png)][shared]\r\n\r\n[shared]: a-ref.png";
  const second = "> ![![nested](b.png)][shared]";
  const expectedFirst = [{ start: 3, end: 16, destination: "a.png" }];
  const expectedSecond = [{ start: 4, end: 20, destination: "b.png" }];

  const firstImages = findMarkdownImageSpans(first);
  const secondImages = findMarkdownImageSpans(second);
  expect(firstImages).toEqual(expectedFirst);
  expect(secondImages).toEqual(expectedSecond);

  expect(findMarkdownImageSpans(first)).toEqual(expectedFirst);
  expect(secondImages).toEqual(expectedSecond);
});
