import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Ephemeral Node/Vitest resource handoff, not application persistence. Claims
// survive worker/module death; only the namespace's process owner deletes them.
const OWNER_DIRECTORY = ".vitest-resource-owner";
const ID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

function readReceipt(file: string): string {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(128);
    return buffer.subarray(0, fs.readSync(fd, buffer)).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function resourceOwner(root: string, identity: string) {
  const directory = path.join(root, OWNER_DIRECTORY);
  const ownerFile = path.join(directory, "owner");
  const claims = path.join(directory, "claims");
  const verifyOwner = () => {
    if (readReceipt(ownerFile) !== identity) {
      throw new Error(`Vitest resource owner changed: ${root}`);
    }
  };
  return {
    root,
    claim() {
      verifyOwner();
      const id = randomUUID();
      const claim = path.join(claims, id);
      // Atomic pending admission, before allocation/spawn. No shared JSON RMW
      // and no deletion-based release: a missing receipt never means success.
      fs.mkdirSync(claim);
      return () => {
        verifyOwner();
        fs.writeFileSync(path.join(claim, "released"), `${identity}:${id}`, { flag: "wx" });
      };
    },
    assertReleased() {
      verifyOwner();
      // The creator expects this registry. Missing/unreadable metadata is not
      // an empty set, including after all workers have exited successfully.
      for (const id of fs.readdirSync(claims)) {
        const receipt = path.join(claims, id, "released");
        try {
          if (ID_PATTERN.test(id) && readReceipt(receipt) === `${identity}:${id}`) {
            continue;
          }
        } catch {
          // Retain on missing, corrupt, or unreadable completion evidence.
        }
        throw new Error(`Unreleased Vitest resource claim: ${path.join(claims, id)}`);
      }
    },
  };
}

export function createVitestResourceOwner(root: string) {
  const identity = randomUUID();
  const directory = path.join(root, OWNER_DIRECTORY);
  fs.mkdirSync(directory);
  fs.mkdirSync(path.join(directory, "claims"));
  fs.writeFileSync(path.join(directory, "owner"), identity, { flag: "wx" });
  return resourceOwner(root, identity);
}

/** Discover only explicit containing owners, including canonical TMP symlinks. */
export function findVitestResourceOwner(root = tmpdir()) {
  let current = path.resolve(root);
  while (true) {
    try {
      // A command may create its own TMP leaf; find the existing containing
      // owner without making that directory or changing command admission.
      current = fs.realpathSync(current);
      fs.lstatSync(path.join(current, OWNER_DIRECTORY));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        return undefined;
      }
      current = parent;
      continue;
    }
    const identity = readReceipt(path.join(current, OWNER_DIRECTORY, "owner"));
    if (!ID_PATTERN.test(identity)) {
      throw new Error(`Invalid Vitest resource owner: ${current}`);
    }
    return resourceOwner(current, identity);
  }
}
