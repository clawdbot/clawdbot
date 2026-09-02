import path from "node:path";
import type { Plugin } from "vite";
import type { Vitest } from "vitest/node";
import { isVitestWorkerMetadataRequest } from "../../scripts/lib/vitest-cli-mode.mts";
import {
  isVitestWorkerDeclaration,
  requestVitestWorkerArtifacts,
  resolveVitestWorkerDeclaration,
  verifyVitestWorkerArtifacts,
  vitestWorkerDeclarationEntries,
} from "../../scripts/lib/vitest-worker-artifacts.mts";
import { getVitestWorkerDescriptor } from "../../scripts/lib/vitest-worker-bootstrap.mts";

// Configs may be separately bundled per project. The Vitest instance, not a
// module singleton or project globalSetup, owns their one preparation request.
const declarationNames = new Set(
  Object.values(vitestWorkerDeclarationEntries).map((source) => path.basename(source, ".ts")),
);
const ownerKey = Symbol.for("openclaw.vitest.compiled-subprocess-owner");
const declarationPrefix = "\0openclaw:compiled-subprocess:";
type WorkerOwner = { acquire: () => Promise<string> };
type WorkerVitest = Vitest & { [ownerKey]?: WorkerOwner };

export function compiledSubprocessesPlugin(): Plugin {
  let owner: WorkerOwner | undefined;
  return {
    name: "openclaw:compiled-subprocesses",
    enforce: "pre",
    configureVitest({ vitest, experimental_defineCacheKeyGenerator }) {
      const supplied = getVitestWorkerDescriptor();
      // Only the repository runner can join all borrowers before deleting code.
      // Standalone Vitest, watch and metadata collection retain live source.
      if (
        !supplied ||
        vitest.config.watch ||
        isVitestWorkerMetadataRequest(process.argv.slice(2))
      ) {
        return;
      }
      const instance = vitest as WorkerVitest;
      if (!instance[ownerKey]) {
        // Source and compiled imports differ, but generations within this mode
        // share parent transforms. Keep Vitest's source/config hashing intact.
        experimental_defineCacheKeyGenerator(() => "openclaw:compiled-subprocesses");
        const directory = supplied.directory;
        let preparation: Promise<string> | undefined;
        let failure: unknown;
        const ownerDisconnected = () => {
          failure = new Error("Compiled subprocess owner disconnected before Vitest closed");
          process.exitCode = 1;
          console.error(failure);
          // An owner loss must not leave a detached Vitest pool using orphaned code.
          void vitest
            .cancelCurrentRun("keyboard-input")
            .catch((error: unknown) => console.error(error));
          void vitest.close();
        };
        process.once("disconnect", ownerDisconnected);
        process.channel?.unref();
        instance[ownerKey] = {
          acquire() {
            return (preparation ??= (async () => {
              await requestVitestWorkerArtifacts();
              verifyVitestWorkerArtifacts(directory);
              return directory;
            })());
          },
        };
        process.once("exit", () => {
          if (failure) {
            process.exitCode = 1;
          }
        });
        // Vitest closes its pool concurrently with this hook. Verification is
        // safe here; deletion belongs to the outer runner after actual child close.
        vitest.onClose(async () => {
          process.off("disconnect", ownerDisconnected);
          if (preparation) {
            try {
              verifyVitestWorkerArtifacts(await preparation);
            } catch (error) {
              failure = error;
              process.exitCode = 1;
              throw error;
            }
          }
        });
      }
      owner = instance[ownerKey];
    },
    async resolveId(source, importer, options) {
      if (owner && source.startsWith(declarationPrefix)) {
        return source;
      }
      if (
        !owner ||
        !importer ||
        !declarationNames.has(path.basename(source).replace(/\.[jt]s$/u, ""))
      ) {
        return null;
      }
      // Resolve only the real declarations. Runtime parents, SDKs, resolver
      // tests and direct imports of worker implementations remain source modules.
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved || !isVitestWorkerDeclaration(resolved.id)) {
        return null;
      }
      // Cached imports are replayed without their original importer. Give the
      // compiler's source declarations a distinct URL so replay cannot redirect them.
      if (
        importer.endsWith("/scripts/lib/runtime-process-build-entries.mts") ||
        importer.endsWith("/scripts/lib/runtime-process-core-build-entries.mts") ||
        importer.endsWith("/scripts/lib/vitest-worker-build-entries.mts")
      ) {
        return `${resolved.id}?openclaw-build-source`;
      }
      return declarationPrefix + resolved.id;
    },
    async load(id) {
      if (!owner || !id.startsWith(declarationPrefix)) {
        return null;
      }
      const declaration = id.slice(declarationPrefix.length);
      const compiled = resolveVitestWorkerDeclaration(declaration, await owner.acquire());
      // Vitest hashes virtual load content on every invocation. Only this tiny
      // bridge embeds the disposable path; cached parents retain a stable ID.
      return `export * from ${JSON.stringify(compiled)};`;
    },
  };
}
