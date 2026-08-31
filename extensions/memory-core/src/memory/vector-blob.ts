// Memory Core plugin module implements vector blob encoding.
export const vectorToBlob = (embedding: number[]): Buffer =>
  Buffer.from(new Float32Array(embedding).buffer);
