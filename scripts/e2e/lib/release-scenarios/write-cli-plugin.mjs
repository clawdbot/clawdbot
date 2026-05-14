import fs from "node:fs";
import path from "node:path";

const [dir, id, version, method, name, cliRoot, cliOutput] = process.argv.slice(2);

if (!dir || !id || !version || !method || !name || !cliRoot || !cliOutput) {
  throw new Error(
    "usage: write-cli-plugin.mjs <dir> <id> <version> <method> <name> <cliRoot> <cliOutput>",
  );
}

fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(
  path.join(dir, "package.json"),
  `${JSON.stringify(
    {
      name: `@openclaw/${id}`,
      version,
      openclaw: { extensions: ["./index.js"] },
    },
    null,
    2,
  )}\n`,
);
fs.writeFileSync(
  path.join(dir, "index.js"),
  `module.exports = { id: ${JSON.stringify(id)}, name: ${JSON.stringify(name)}, register(api) { api.registerGatewayMethod(${JSON.stringify(method)}, async () => ({ ok: true, version: ${JSON.stringify(version)} })); api.registerCli(({ program }) => { const root = program.command(${JSON.stringify(cliRoot)}).description(${JSON.stringify(`${name} fixture command`)}); root.command("ping").description("Print fixture ping output").action(() => { console.log(${JSON.stringify(cliOutput)}); }); }, { descriptors: [{ name: ${JSON.stringify(cliRoot)}, description: ${JSON.stringify(`${name} fixture command`)}, hasSubcommands: true }] }); }, };\n`,
);
fs.writeFileSync(
  path.join(dir, "openclaw.plugin.json"),
  `${JSON.stringify({ id, configSchema: { type: "object", properties: {} } }, null, 2)}\n`,
);
