import path from "node:path";
import { prepareSkillBundle } from "../../skills/library/bundle.js";
import { formatSkillsForPromptBounded } from "../../skills/loading/skill-prompt-limits.js";
import { prepareSkillResourceDelivery } from "../../skills/runtime/resources.js";
import type { SkillSnapshot } from "../../skills/types.js";
import { NODE_WORKER_WORKSPACE_STDIN_MAX_BYTES } from "../../worker/node-workspace-protocol.js";
import type { WorkerWorkspaceTunnelHandle } from "./tunnel-contract.js";

const CHUNK_BYTES = Math.floor(NODE_WORKER_WORKSPACE_STDIN_MAX_BYTES / 4) * 3;
// The receiving process owns its temporary root; lossless IDs also fence large Windows file indexes.
const RESOURCE_SCRIPT = String.raw`
const fs=require('node:fs'), path=require('node:path'), os=require('node:os'), crypto=require('node:crypto');
const [op,root,rootId,name,offsetText,sizeText,hash,executable]=process.argv.slice(1);
const identity=s=>String(s.dev)+':'+String(s.ino);
function enter(p,id){const s=fs.lstatSync(p,{bigint:true});if(!s.isDirectory()||s.isSymbolicLink()||(id&&identity(s)!==id))throw Error('resource directory changed');process.chdir(p);if(identity(fs.statSync('.',{bigint:true}))!==identity(s))throw Error('resource directory changed');}
try {
 if(op==='init'){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'openclaw-skill-resources-'));fs.chmodSync(dir,0o700);process.stdout.write(JSON.stringify({root:dir,identity:identity(fs.lstatSync(dir,{bigint:true}))}));}
 else {
  enter(root,rootId);
  if(op==='cleanup'){fs.rmSync(root,{recursive:true});}
  else if(op==='write'){
   const parts=name.split('/');if(parts.some(p=>!p||p==='.'||p==='..'||/[\\\x00]/.test(p))||parts.length>17)throw Error('invalid resource path');
   for(const part of parts.slice(0,-1)){try{fs.mkdirSync(part,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}enter(part);}
   const offset=Number(offsetText),size=Number(sizeText),encoded=fs.readFileSync(0,'utf8'),bytes=Buffer.from(encoded,'base64');
   if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(size)||offset<0||size>1048576||offset+bytes.length>size||encoded.length>${NODE_WORKER_WORKSPACE_STDIN_MAX_BYTES}||bytes.toString('base64')!==encoded)throw Error('invalid resource chunk');
   const fd=fs.openSync(parts.at(-1),fs.constants.O_RDWR|(fs.constants.O_NOFOLLOW||0)|(offset===0?fs.constants.O_CREAT|fs.constants.O_EXCL:0),0o600);
   try{const s=fs.fstatSync(fd);if(!s.isFile()||s.nlink!==1||s.size!==offset)throw Error('resource file changed');let n=0;while(n<bytes.length){const written=fs.writeSync(fd,bytes,n,bytes.length-n,offset+n);if(!written)throw Error('resource write stalled');n+=written;}
    if(offset+bytes.length===size){if(crypto.createHash('sha256').update(fs.readFileSync(fd)).digest('hex')!==hash)throw Error('resource digest mismatch');fs.fchmodSync(fd,executable==='true'?0o500:0o400);fs.fsyncSync(fd);}
   }finally{fs.closeSync(fd);}
  }else throw Error('invalid resource operation');
 }
}catch(e){process.stderr.write(String(e.message));process.exitCode=1;}
`;

/** Transfers the prepared catalog through either SSH or node placement transport, outside Git state. */
export async function transferSkillResources(params: {
  snapshot?: SkillSnapshot;
  tunnel: Pick<WorkerWorkspaceTunnelHandle, "runWorkspaceCommand">;
  assertCurrent: () => void;
  signal?: AbortSignal;
  explicitSelections?: readonly import("../../skills/types.js").ExplicitSkillSelection[];
}) {
  const check = () => {
    params.signal?.throwIfAborted();
    params.assertCurrent();
  };
  const delivery = await prepareSkillResourceDelivery(
    params.snapshot,
    check,
    params.explicitSelections,
  );
  if (!delivery || !params.snapshot) {
    return undefined;
  }
  const execute = async (
    operation: "init" | "write" | "cleanup",
    args: string[] = [],
    input?: string,
  ) => {
    const cleanup = operation === "cleanup";
    const assertDispatchCurrent = cleanup ? params.assertCurrent : check;
    assertDispatchCurrent();
    const result = await params.tunnel.runWorkspaceCommand({
      argv: ["node", "-e", RESOURCE_SCRIPT, operation, ...args],
      input,
      transportRetry: "never",
      assertCurrent: assertDispatchCurrent,
      signal: cleanup ? undefined : params.signal,
      timeoutMs: cleanup ? 5000 : 60000,
    });
    // Preserve the accepted cleanup locator before observing turn cancellation.
    // The exact placement must still own every command, including cleanup.
    if (operation === "init") {
      params.assertCurrent();
    } else {
      assertDispatchCurrent();
    }
    if (result.termination !== "exit" || result.code !== 0) {
      throw new Error(
        "Skill resource transfer failed. Retry this turn after reconnecting the execution environment.",
      );
    }
    return result.stdout;
  };
  const initialized: { root: string; identity: string } = JSON.parse(await execute("init"));
  if (
    typeof initialized.root !== "string" ||
    initialized.root.length > 1024 ||
    (!path.posix.isAbsolute(initialized.root.replaceAll("\\", "/")) &&
      !path.win32.isAbsolute(initialized.root)) ||
    !/^\d+:\d+$/.test(initialized.identity)
  ) {
    throw new Error("Invalid skill resource location from execution environment.");
  }
  const cleanup = async () => {
    await execute("cleanup", [initialized.root, initialized.identity]);
  };
  try {
    check();
    const resolvedSkills = structuredClone(params.snapshot.resolvedSkills ?? []);
    const mounts: Array<{ hostPath: string; containerPath: string }> = [];
    for (const [index, skill] of delivery.skills.entries()) {
      const bundle = prepareSkillBundle(skill.files);
      for (const file of bundle.files) {
        for (let offset = 0; offset === 0 || offset < file.bytes.length; offset += CHUNK_BYTES) {
          await execute(
            "write",
            [
              initialized.root,
              initialized.identity,
              `${index}/${file.path}`,
              String(offset),
              String(file.sizeBytes),
              file.sha256,
              String(file.executable),
            ],
            file.bytes.subarray(offset, offset + CHUNK_BYTES).toString("base64"),
          );
        }
      }
      const selected = resolvedSkills.find((candidate) => candidate.name === skill.name);
      const sourceBase =
        selected?.baseDir ?? (skill.sourcePath ? path.dirname(skill.sourcePath) : undefined);
      if (!sourceBase) {
        throw new Error("Resource source path missing.");
      }
      const remoteBase = `${initialized.root.replaceAll("\\", "/")}/${index}`;
      mounts.push({ hostPath: sourceBase, containerPath: remoteBase });
      if (selected) {
        selected.locationNote = `Read instructions at the location above. For remote execution, this exact bundle's scripts and resources are at ${remoteBase}; resolve relative execution paths against that directory.`;
      }
    }
    check();
    return {
      source: params.snapshot,
      snapshot: {
        ...params.snapshot,
        resolvedSkills,
        prompt: formatSkillsForPromptBounded({ skills: resolvedSkills, preserveOrder: true }),
      },
      mounts,
      assertCurrent: check,
      cleanup,
    };
  } catch (error) {
    await cleanup().catch(() => undefined);
    throw error;
  }
}
