import fs from "node:fs";
import path from "node:path";

export const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
export const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

export const write = (file, contents) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
};
export const writeJson = (file, value) => write(file, json(value));

export const requireArg = (value, name) => {
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
};

export const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};
