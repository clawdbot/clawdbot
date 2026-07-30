import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

type ContainerOption = {
  name: string;
  role: string;
};

type WriterOptions = {
  containers: ContainerOption[];
  details: Map<string, Record<string, string>>;
  image?: string;
  output?: string;
  package?: string;
  scenario?: string;
};

type RequiredWriterOptions = WriterOptions & {
  image: string;
  output: string;
  package: string;
  scenario: string;
};

type DockerInspect = {
  Id: string;
  Image?: string;
  Name?: string;
  RepoDigests?: string[];
  State?: { Status?: string };
};

type PackageManifest = {
  name?: unknown;
  version?: unknown;
};

function readValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function parseArgs(args: string[]): RequiredWriterOptions {
  const options: WriterOptions = { containers: [], details: new Map() };
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (!option) {
      continue;
    }
    const value = readValue(args, index, option);
    index += 1;
    if (option === "--scenario") {
      options.scenario = value;
    } else if (option === "--output") {
      options.output = value;
    } else if (option === "--image") {
      options.image = value;
    } else if (option === "--package") {
      options.package = value;
    } else if (option === "--container") {
      const separator = value.indexOf("=");
      if (separator < 1 || separator === value.length - 1) {
        throw new Error("--container must use role=name");
      }
      options.containers.push({
        role: value.slice(0, separator),
        name: value.slice(separator + 1),
      });
    } else if (option === "--detail") {
      const roleSeparator = value.indexOf(":");
      const valueSeparator = value.indexOf("=", roleSeparator + 1);
      if (roleSeparator < 1 || valueSeparator < roleSeparator + 2) {
        throw new Error("--detail must use role:key=value");
      }
      const role = value.slice(0, roleSeparator);
      const key = value.slice(roleSeparator + 1, valueSeparator);
      const detailValue = value.slice(valueSeparator + 1);
      const roleDetails = options.details.get(role) ?? {};
      roleDetails[key] = detailValue;
      options.details.set(role, roleDetails);
    } else {
      throw new Error(`unknown option: ${option}`);
    }
  }
  for (const required of ["scenario", "output", "image", "package"] as const) {
    if (!options[required]) {
      throw new Error(`--${required} is required`);
    }
  }
  if (options.containers.length === 0) {
    throw new Error("at least one --container is required");
  }
  return options as RequiredWriterOptions;
}

function run(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).trim();
}

function inspectDockerObject(reference: string): DockerInspect {
  const [result] = JSON.parse(run("docker", ["inspect", reference])) as DockerInspect[];
  if (!result) {
    throw new Error(`docker inspect returned no result for ${reference}`);
  }
  return result;
}

function readPackageIdentity(packagePath: string) {
  const packageJson = JSON.parse(
    run("tar", ["-xOf", packagePath, "package/package.json"]),
  ) as PackageManifest;
  if (typeof packageJson.name !== "string" || typeof packageJson.version !== "string") {
    throw new Error("package artifact manifest is missing name or version");
  }
  const bytes = fs.readFileSync(packagePath);
  return {
    fileName: path.basename(packagePath),
    name: packageJson.name,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.byteLength,
    version: packageJson.version,
  };
}

const options = parseArgs(process.argv.slice(2));
const image = inspectDockerObject(options.image);
const containers = options.containers.map(({ name, role }) => {
  const container = inspectDockerObject(name);
  return {
    details: options.details.get(role) ?? {},
    id: container.Id,
    imageId: container.Image,
    name: (container.Name ?? name).replace(/^\//u, ""),
    role,
    state: container.State?.Status,
  };
});
const identity = {
  containers,
  image: {
    id: image.Id,
    reference: options.image,
    repoDigests: image.RepoDigests ?? [],
  },
  package: readPackageIdentity(options.package),
  scenarioId: options.scenario,
};
fs.mkdirSync(path.dirname(options.output), { recursive: true });
fs.writeFileSync(options.output, `${JSON.stringify(identity, null, 2)}\n`);
console.log(
  `artifact identities: package=${identity.package.name}@${identity.package.version} sha256=${identity.package.sha256} image=${identity.image.id} containers=${containers.map((container) => `${container.role}:${container.id}`).join(",")}`,
);
