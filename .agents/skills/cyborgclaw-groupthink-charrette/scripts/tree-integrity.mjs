import {
  constants as fileConstants,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonicalJson, digestJson, sha256 } from "./json-utils.mjs";

function unsafe(message) {
  const error = new Error(message);
  error.code = "UNSAFE_TREE";
  throw error;
}

export async function lstatOptional(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export function isContained(parent, child) {
  const path = relative(resolve(parent), resolve(child));
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

export async function assertNoSymlinkAncestors(path) {
  const absolute = resolve(path);
  const parts = absolute.split(sep);
  let current = sep;
  for (const part of parts) {
    if (!part) {
      continue;
    }
    current = join(current, part);
    const status = await lstatOptional(current);
    if (status === null) {
      continue;
    }
    if (status.isSymbolicLink()) {
      unsafe(`Symlink ancestor is not allowed: ${current}`);
    }
    if (!status.isDirectory() && current !== absolute) {
      unsafe(`Non-directory ancestor is not allowed: ${current}`);
    }
  }
}

export async function inventoryTree(root) {
  const absolute = resolve(root);
  const rootStatus = await lstatOptional(absolute);
  if (rootStatus === null || !rootStatus.isDirectory() || rootStatus.isSymbolicLink()) {
    unsafe(`Tree root must be a real directory: ${absolute}`);
  }
  const entries = [];

  async function walk(directory, relativeDirectory) {
    const status = await lstat(directory);
    if (!status.isDirectory() || status.isSymbolicLink()) {
      unsafe(`Directory changed type during inventory: ${directory}`);
    }
    entries.push({
      path: relativeDirectory || ".",
      type: "directory",
      mode: status.mode & 0o7777,
    });
    const names = (await readdir(directory)).sort((left, right) =>
      Buffer.from(left).compare(Buffer.from(right)),
    );
    for (const name of names) {
      if (name === "." || name === ".." || name.includes(sep)) {
        unsafe(`Unsafe directory entry: ${name}`);
      }
      const child = join(directory, name);
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const childStatus = await lstat(child);
      if (childStatus.isSymbolicLink()) {
        unsafe(`Symlinks are not allowed in payloads: ${relativePath}`);
      }
      if (childStatus.isDirectory()) {
        await walk(child, relativePath);
        continue;
      }
      if (!childStatus.isFile()) {
        unsafe(`Special files are not allowed in payloads: ${relativePath}`);
      }
      if (childStatus.nlink !== 1) {
        unsafe(`Hard-linked files are not allowed in payloads: ${relativePath}`);
      }
      const handle = await open(child, fileConstants.O_RDONLY | (fileConstants.O_NOFOLLOW ?? 0));
      let bytes;
      try {
        const openedStatus = await handle.stat();
        if (
          !openedStatus.isFile() ||
          openedStatus.nlink !== 1 ||
          openedStatus.dev !== childStatus.dev ||
          openedStatus.ino !== childStatus.ino
        ) {
          unsafe(`File changed during inventory: ${relativePath}`);
        }
        bytes = await handle.readFile();
        const afterStatus = await handle.stat();
        if (
          afterStatus.size !== openedStatus.size ||
          afterStatus.mtimeNs !== openedStatus.mtimeNs
        ) {
          unsafe(`File changed while hashing: ${relativePath}`);
        }
      } finally {
        await handle.close();
      }
      entries.push({
        path: relativePath,
        type: "file",
        mode: childStatus.mode & 0o7777,
        size: bytes.length,
        sha256: sha256(bytes),
      });
    }
  }

  await walk(absolute, "");
  entries.sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
  const digest = digestJson(entries);
  return {
    schema_version: "cyborgclaw.logical-tree-inventory.v1",
    digest,
    entry_count: entries.length,
    file_count: entries.filter((entry) => entry.type === "file").length,
    directory_count: entries.filter((entry) => entry.type === "directory").length,
    entries,
  };
}

export function inventoriesEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

export async function copyInventory(source, destination, inventory) {
  const destinationStatus = await lstatOptional(destination);
  if (destinationStatus !== null) {
    unsafe(`Copy destination must be absent: ${destination}`);
  }
  const rootEntry = inventory.entries.find((entry) => entry.path === ".");
  await mkdir(destination, { mode: 0o700 });
  const directories = inventory.entries
    .filter((entry) => entry.type === "directory" && entry.path !== ".")
    .sort((left, right) => left.path.split("/").length - right.path.split("/").length);
  for (const entry of directories) {
    const target = join(destination, ...entry.path.split("/"));
    if (!isContained(destination, target)) {
      unsafe(`Copy path escaped destination: ${entry.path}`);
    }
    await mkdir(target, { mode: entry.mode });
  }
  for (const entry of inventory.entries.filter((candidate) => candidate.type === "file")) {
    const sourcePath = join(source, ...entry.path.split("/"));
    const targetPath = join(destination, ...entry.path.split("/"));
    if (!isContained(source, sourcePath) || !isContained(destination, targetPath)) {
      unsafe(`Copy path escaped a tree: ${entry.path}`);
    }
    const sourceHandle = await open(
      sourcePath,
      fileConstants.O_RDONLY | (fileConstants.O_NOFOLLOW ?? 0),
    );
    const targetHandle = await open(
      targetPath,
      fileConstants.O_CREAT |
        fileConstants.O_EXCL |
        fileConstants.O_WRONLY |
        (fileConstants.O_NOFOLLOW ?? 0),
      entry.mode,
    );
    try {
      const sourceStatus = await sourceHandle.stat();
      if (!sourceStatus.isFile() || sourceStatus.nlink !== 1) {
        unsafe(`Unsafe source file during copy: ${entry.path}`);
      }
      const bytes = await sourceHandle.readFile();
      if (bytes.length !== entry.size || sha256(bytes) !== entry.sha256) {
        unsafe(`Source changed before copy: ${entry.path}`);
      }
      await targetHandle.writeFile(bytes);
      await targetHandle.chmod(entry.mode);
      await targetHandle.sync();
    } finally {
      await sourceHandle.close();
      await targetHandle.close();
    }
  }
  for (const entry of [...directories].reverse()) {
    const target = join(destination, ...entry.path.split("/"));
    const handle = await open(target, fileConstants.O_RDONLY);
    try {
      await handle.sync();
      await handle.chmod(entry.mode);
    } finally {
      await handle.close();
    }
  }
  const rootHandle = await open(destination, fileConstants.O_RDONLY);
  try {
    await rootHandle.sync();
    await rootHandle.chmod(rootEntry.mode);
  } finally {
    await rootHandle.close();
  }
}

export async function realDirectory(path) {
  await assertNoSymlinkAncestors(path);
  const status = await lstatOptional(path);
  if (status === null || !status.isDirectory() || status.isSymbolicLink()) {
    unsafe(`Expected real directory: ${path}`);
  }
  return realpath(path);
}

export function inventoryLine(inventory) {
  return `${inventory.digest} ${inventory.entry_count} entries (${inventory.file_count} files, ${inventory.directory_count} directories)`;
}
