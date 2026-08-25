import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  prepareManagedMediaGrounding,
  prepareManagedMediaGroundingRoot,
  type ManagedMediaGrounding,
} from "../../media/media-reference.js";
import { invalidateUngroundedMediaPrefixes } from "./transcript-grounding.js";

const REDACTED = "[unverified media reference removed]";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function grounding(
  rootAliases: string[],
  authorizedAliases: string[] = [],
  caseInsensitivePaths = false,
): ManagedMediaGrounding {
  return { authorizedAliases, caseInsensitivePaths, rootAliases };
}

describe("invalidateUngroundedMediaPrefixes", () => {
  const root = "/managed/state/media";

  it("invalidates only the absolute managed prefix and preserves every suffix byte", () => {
    const input = `claim "${root}/invented name.jpg?x=1#preview" then ${root}/../secret`;
    expect(invalidateUngroundedMediaPrefixes(input, grounding([root]))).toBe(
      `claim "${REDACTED}/invented name.jpg?x=1#preview" then ${REDACTED}/../secret`,
    );
  });

  it("preserves only a longest authorized alias at an exact terminal boundary", () => {
    const real = `${root}/inbound/real photo(1).jpg`;
    const input = `real "${real}" suffix ${real}.fake ads ${real}:stream`;
    expect(invalidateUngroundedMediaPrefixes(input, grounding([root], [real]))).toBe(
      `real "${real}" suffix ${REDACTED}/inbound/real photo(1).jpg.fake ads ${REDACTED}/inbound/real photo(1).jpg:stream`,
    );
  });

  it.each([".", ",", ";", ":", "!", "?", "\u2014"])(
    "accepts a terminal punctuation run after an authorized alias: %s",
    (suffix) => {
      const real = `${root}/real.jpg`;
      expect(
        invalidateUngroundedMediaPrefixes(`${real}${suffix} next`, grounding([root], [real])),
      ).toBe(`${real}${suffix} next`);
    },
  );

  it("invalidates file URL roots, including relative, encoded, localhost, and double-slash forms", () => {
    const roots = [
      "file:managed/state%20dir/media",
      "file:/managed/state%20dir/media",
      "file:///managed/state%20dir/media",
      "file:////managed/state%20dir/media",
      "file://localhost/managed/state%20dir/media",
      "file://localhost//managed/state%20dir/media",
    ];
    for (const alias of roots) {
      expect(invalidateUngroundedMediaPrefixes(`${alias}/fake.png`, grounding(roots))).toBe(
        `${REDACTED}/fake.png`,
      );
    }
  });

  it.each(["MEDIA:", "IMAGE:", "custom:", "path=", "(", "..."])(
    "invalidates a managed root after directive or punctuation bytes: %s",
    (prefix) => {
      expect(
        invalidateUngroundedMediaPrefixes(`${prefix}${root}/fake.png`, grounding([root])),
      ).toBe(`${prefix}${REDACTED}/fake.png`);
    },
  );

  it.each(['claim "', "claim (`"])(
    "invalidates without consuming an unmatched opening wrapper: %s",
    (prefix) => {
      expect(
        invalidateUngroundedMediaPrefixes(`${prefix}${root}/fake.png`, grounding([root])),
      ).toBe(`${prefix}${REDACTED}/fake.png`);
    },
  );

  it("leaves non-file URI occurrences, remote file authorities, root siblings, and unrelated paths", () => {
    const roots = [root, `file:///${root}`];
    const inputs = [
      `https://example.test/?path=${root}/fake.png`,
      `custom://example.test/?path=${root}/fake.png`,
      "file://attacker/managed/state/media/fake.png",
      `${root}-backup/fake.png`,
      "/tmp/fake.png",
    ];
    for (const input of inputs) {
      expect(invalidateUngroundedMediaPrefixes(input, grounding(roots))).toBe(input);
    }
  });

  it("does not rescan prefixes when a bounded prompt has no managed root", () => {
    const input = "x".repeat(32 * 1_024);
    const slice = vi.spyOn(String.prototype, "slice");
    const result = invalidateUngroundedMediaPrefixes(input, grounding([root]));
    const sliceCalls = slice.mock.calls.length;
    slice.mockRestore();

    expect(result).toBe(input);
    expect(sliceCalls).toBe(0);
  });

  it.each([
    ["C:/Users/Bot/state/media", "c:/users/bot/STATE/media/fake.png"],
    ["//?/C:/Users/Bot/state/media", "//?/c:/users/bot/state/MEDIA/fake.png"],
    ["//server/share/media", "//SERVER/SHARE/MEDIA/fake.png"],
    ["//?/UNC/server/share/media", "//?/unc/SERVER/share/media/fake.png"],
    ["/private/var/state/media", "/private/VAR/state/media/fake.png"],
  ])(
    "supports exact foreign alias forms with owner-provided case semantics: %s",
    (alias, input) => {
      expect(invalidateUngroundedMediaPrefixes(input, grounding([alias], [], true))).toBe(
        `${REDACTED}/fake.png`,
      );
    },
  );

  it.each([" ", ")", "]", '"', "`", ",", ":", "\u2014"])(
    "treats every character in a configured root as literal: %j",
    (terminator) => {
      const unusualRoot = `/srv/openclaw${terminator}prod/media`;
      expect(
        invalidateUngroundedMediaPrefixes(
          `${unusualRoot}/generated/fake.png`,
          grounding([unusualRoot]),
        ),
      ).toBe(`${REDACTED}/generated/fake.png`);
    },
  );
});

describe("prepareManagedMediaGrounding", () => {
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;

  afterEach(() => {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
  });

  it("keeps path matching exact when the real managed root has no togglable letter", async () => {
    const stateDir = tempDirs.make("grounding-mount-root-");
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const mountRoot = path.parse(process.cwd()).root;
    fs.symlinkSync(
      mountRoot,
      path.join(stateDir, "media"),
      process.platform === "win32" ? "junction" : "dir",
    );

    expect(path.basename(mountRoot)).not.toMatch(/[a-z]/i);
    await expect(prepareManagedMediaGroundingRoot()).resolves.toMatchObject({
      caseInsensitivePaths: false,
    });
  });

  it("pins regular files and emits bounded raw, URL, encoded, and macOS root aliases", async () => {
    const stateDir = path.join(tempDirs.make("grounding-aliases-"), "state dir");
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const real = path.join(stateDir, "media", "generated", "real image.png");
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, "image");

    const fileUrl = pathToFileURL(real).href;
    const root = await prepareManagedMediaGroundingRoot();
    const prepared = await prepareManagedMediaGrounding(root, [
      fileUrl,
      `${fileUrl}?download=1`,
      `${fileUrl}#preview`,
      fileUrl.replace("real%20image", "real%2Fimage"),
      fileUrl.replace("file://", "file://attacker"),
    ]);

    expect(prepared.authorizedAliases).toContain(real);
    expect(prepared.authorizedAliases).toContain(fileUrl);
    expect(prepared.authorizedAliases).not.toEqual(
      expect.arrayContaining([
        `${fileUrl}?download=1`,
        `${fileUrl}#preview`,
        fileUrl.replace("real%20image", "real%2Fimage"),
        fileUrl.replace("file://", "file://attacker"),
      ]),
    );
    const mediaDir = path.join(stateDir, "media");
    const rootReal = fs.realpathSync(mediaDir);
    const rootBase = path.basename(rootReal);
    const letterIndex = rootBase.search(/[a-z]/i);
    const letter = rootBase.charAt(letterIndex);
    const toggledRoot = path.join(
      path.dirname(rootReal),
      `${rootBase.slice(0, letterIndex)}${letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase()}${rootBase.slice(letterIndex + 1)}`,
    );
    const actualCaseInsensitive = (() => {
      try {
        const original = fs.statSync(rootReal);
        const alias = fs.statSync(toggledRoot);
        return original.dev === alias.dev && original.ino === alias.ino;
      } catch {
        return false;
      }
    })();
    expect(prepared.caseInsensitivePaths).toBe(actualCaseInsensitive);
    const pathname = pathToFileURL(mediaDir).pathname;
    expect(prepared.rootAliases).toEqual(
      expect.arrayContaining([
        mediaDir,
        `file:${pathname.slice(1)}`,
        `file://${pathname}`,
        `file:///${pathname}`,
        `file://localhost${pathname}`,
        `file://localhost/${pathname}`,
      ]),
    );
    if (process.platform === "win32") {
      const slashRoot = rootReal.replaceAll("\\", "/");
      expect(prepared.rootAliases).toEqual(
        expect.arrayContaining([
          slashRoot,
          `//?/${slashRoot}`,
          `\\\\?\\${slashRoot.replaceAll("/", "\\")}`,
          pathToFileURL(rootReal).href,
        ]),
      );
      expect(prepared.rootAliases.some((alias) => alias.includes("C%3A"))).toBe(false);
    }
    const relativeFileUrl = `file:${pathToFileURL(real).pathname.slice(1)}`;
    expect(invalidateUngroundedMediaPrefixes(relativeFileUrl, prepared)).toBe(relativeFileUrl);
    expect(invalidateUngroundedMediaPrefixes(`file:${pathname.slice(1)}/fake.png`, prepared)).toBe(
      `${REDACTED}/fake.png`,
    );
    expect(prepared.authorizedAliases.length).toBeLessThanOrEqual(64);
    expect(prepared.rootAliases.length).toBeLessThanOrEqual(64);
    expect(
      [...prepared.authorizedAliases, ...prepared.rootAliases].every(
        (item) => item.length <= 4_096,
      ),
    ).toBe(true);
  });

  it("rejects missing files, directories, leaf symlinks, and intermediate symlink escapes", async () => {
    const stateDir = tempDirs.make("grounding-store-");
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const mediaDir = path.join(stateDir, "media");
    const real = path.join(mediaDir, "real.jpg");
    const directory = path.join(mediaDir, "directory");
    const leafLink = path.join(mediaDir, "leaf.jpg");
    const outside = tempDirs.make("grounding-outside-");
    const outsideFile = path.join(outside, "secret.jpg");
    const directoryLink = path.join(mediaDir, "outside");
    fs.mkdirSync(mediaDir, { recursive: true });
    fs.writeFileSync(real, "image");
    fs.mkdirSync(directory);
    fs.writeFileSync(outsideFile, "secret");
    fs.symlinkSync(real, leafLink);
    fs.symlinkSync(outside, directoryLink);

    const root = await prepareManagedMediaGroundingRoot();
    const prepared = await prepareManagedMediaGrounding(root, [
      real,
      path.join(mediaDir, "missing.jpg"),
      directory,
      leafLink,
      path.join(directoryLink, "secret.jpg"),
    ]);

    expect(prepared.authorizedAliases).toContain(real);
    expect(prepared.authorizedAliases).not.toContain(directory);
    expect(prepared.authorizedAliases).not.toContain(leafLink);
    expect(prepared.authorizedAliases).not.toContain(path.join(directoryLink, "secret.jpg"));
  });

  it("retains all 64 trusted paths independently of the derived alias cap", async () => {
    const stateDir = tempDirs.make("grounding-path-cap-");
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const mediaDir = path.join(stateDir, "media", "generated");
    fs.mkdirSync(mediaDir, { recursive: true });
    const paths = Array.from({ length: 64 }, (_, index) => path.join(mediaDir, `${index}.png`));
    for (const filePath of paths) {
      fs.writeFileSync(filePath, "image");
    }

    const root = await prepareManagedMediaGroundingRoot();
    const prepared = await prepareManagedMediaGrounding(root, paths);

    expect(prepared.authorizedAliases).toEqual(expect.arrayContaining(paths));
  });
});
