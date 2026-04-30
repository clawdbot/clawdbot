import fs from "node:fs";

const path = "dist/build-info.json";
if (!fs.existsSync(path)) {
  console.log("");
} else {
  const buildInfo = JSON.parse(fs.readFileSync(path, "utf8"));
  console.log(buildInfo.commit ?? "");
}
