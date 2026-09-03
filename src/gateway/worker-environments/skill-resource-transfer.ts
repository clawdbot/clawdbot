import path from "node:path";
import { prepareSkillBundle } from "../../skills/library/bundle.js";
import { formatSkillsForPromptBounded } from "../../skills/loading/skill-prompt-limits.js";
import { prepareSkillResourceDelivery } from "../../skills/runtime/resources.js";
import type { SkillSnapshot } from "../../skills/types.js";
import { NODE_WORKER_WORKSPACE_STDIN_MAX_BYTES } from "../../worker/node-workspace-protocol.js";
import type { WorkerWorkspaceTunnelHandle } from "./tunnel-contract.js";

type ResourceLocation = { id: string; identity: string };
type ResourceOperation =
  | { op: "init" }
  | ({ op: "cleanup" } & ResourceLocation)
  | ({
      op: "write";
      name: string;
      offset: number;
      size: number;
      hash: string;
      executable: boolean;
      data: string;
    } & ResourceLocation);

// Resource names belong to this helper, not workspace argv. Only the receiver derives
// temporary paths; lossless identities fence replacement, including large Windows indexes.
const RESOURCE_SCRIPT = String.raw`
const fs=require('node:fs'), path=require('node:path'), os=require('node:os'), crypto=require('node:crypto');
const identity=s=>String(s.dev)+':'+String(s.ino);
function enter(p,id){const s=fs.lstatSync(p,{bigint:true});if(!s.isDirectory()||s.isSymbolicLink()||(id&&identity(s)!==id))throw Error('resource directory changed');process.chdir(p);if(identity(fs.statSync('.',{bigint:true}))!==identity(s))throw Error('resource directory changed');}
try {
 const input=fs.readFileSync(0);if(input.length>${NODE_WORKER_WORKSPACE_STDIN_MAX_BYTES})throw Error('resource request exceeds input limit');
 const request=JSON.parse(input.toString('utf8')),op=request?.op;
 const keys=op==='init'?['op']:op==='cleanup'?['op','id','identity']:op==='write'?['op','id','identity','name','offset','size','hash','executable','data']:[];
 if(!request||typeof request!=='object'||Array.isArray(request)||!keys.length||Object.keys(request).length!==keys.length||keys.some(key=>!Object.hasOwn(request,key)))throw Error('invalid resource operation');
 const id=op==='init'?crypto.randomUUID().replaceAll('-',''):request.id;
 if(typeof id!=='string'||id.length!==32||!/^[a-f0-9]{32}$/.test(id))throw Error('invalid resource id');
 const root=path.join(os.tmpdir(),'openclaw-skill-resources-'+id);
 if(op==='init'){fs.mkdirSync(root,{mode:0o700});fs.chmodSync(root,0o700);process.stdout.write(JSON.stringify({id,root,identity:identity(fs.lstatSync(root,{bigint:true}))}));}
 else {
  if(typeof request.identity!=='string'||request.identity.match(/^\d+:\d+$/)?.[0]!==request.identity)throw Error('invalid resource identity');
  enter(root,request.identity);
  if(op==='cleanup'){fs.rmSync(root,{recursive:true});}
  else {
   const {name,offset,size,hash,executable,data}=request;
   if(typeof name!=='string'||typeof data!=='string'||typeof executable!=='boolean'||typeof hash!=='string'||hash.length!==64||!/^[a-f0-9]{64}$/.test(hash))throw Error('invalid resource chunk');
   const parts=name.split('/');if(parts.some(p=>!p||p==='.'||p==='..'||/[\\\x00]/.test(p))||parts.length>17)throw Error('invalid resource path');
   for(const part of parts.slice(0,-1)){try{fs.mkdirSync(part,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}enter(part);}
   const bytes=Buffer.from(data,'base64');
   if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(size)||offset<0||size<0||size>1048576||offset+bytes.length>size||bytes.toString('base64')!==data)throw Error('invalid resource chunk');
   const fd=fs.openSync(parts.at(-1),fs.constants.O_RDWR|(fs.constants.O_NOFOLLOW||0)|(offset===0?fs.constants.O_CREAT|fs.constants.O_EXCL:0),0o600);
   try{const s=fs.fstatSync(fd);if(!s.isFile()||s.nlink!==1||s.size!==offset)throw Error('resource file changed');let n=0;while(n<bytes.length){const written=fs.writeSync(fd,bytes,n,bytes.length-n,offset+n);if(!written)throw Error('resource write stalled');n+=written;}
    if(offset+bytes.length===size){if(crypto.createHash('sha256').update(fs.readFileSync(fd)).digest('hex')!==hash)throw Error('resource digest mismatch');fs.fchmodSync(fd,executable?0o500:0o400);fs.fsyncSync(fd);}
   }finally{fs.closeSync(fd);}
  }
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
  const execute = async (operation: ResourceOperation) => {
    const cleanup = operation.op === "cleanup";
    const assertDispatchCurrent = cleanup ? params.assertCurrent : check;
    assertDispatchCurrent();
    const result = await params.tunnel.runWorkspaceCommand({
      argv: ["node", "-e", RESOURCE_SCRIPT],
      input: JSON.stringify(operation),
      transportRetry: "never",
      assertCurrent: assertDispatchCurrent,
      signal: cleanup ? undefined : params.signal,
      timeoutMs: cleanup ? 5000 : 60000,
    });
    // Preserve the accepted cleanup locator before observing turn cancellation.
    // The exact placement must still own every command, including cleanup.
    if (operation.op === "init") {
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
  const initialized: ResourceLocation & { root: string } = JSON.parse(
    await execute({ op: "init" }),
  );
  if (
    typeof initialized.root !== "string" ||
    initialized.root.length > 1024 ||
    (!path.posix.isAbsolute(initialized.root.replaceAll("\\", "/")) &&
      !path.win32.isAbsolute(initialized.root)) ||
    typeof initialized.id !== "string" ||
    initialized.id.length !== 32 ||
    !/^[a-f0-9]{32}$/.test(initialized.id) ||
    typeof initialized.identity !== "string" ||
    initialized.identity.match(/^\d+:\d+$/)?.[0] !== initialized.identity
  ) {
    throw new Error("Invalid skill resource location from execution environment.");
  }
  const location = { id: initialized.id, identity: initialized.identity };
  const cleanup = async () => {
    await execute({ op: "cleanup", ...location });
  };
  try {
    check();
    const deliveredSourcePaths = new Set(
      delivery.skills
        .map((skill) => skill.sourcePath)
        .filter((sourcePath): sourcePath is string => sourcePath !== undefined),
    );
    const resolvedSkills = structuredClone(params.snapshot.resolvedSkills ?? []).filter(
      (skill) => skill.filePath.startsWith("node://") || deliveredSourcePaths.has(skill.filePath),
    );
    const skippedSkillNames = new Set(
      (params.snapshot.resolvedSkills ?? [])
        .filter(
          (skill) =>
            !skill.filePath.startsWith("node://") && !deliveredSourcePaths.has(skill.filePath),
        )
        .map((skill) => skill.name),
    );
    const retainedSkillNames = new Set([
      ...resolvedSkills.map((skill) => skill.name),
      ...delivery.skills.map((skill) => skill.name),
    ]);
    const skills = structuredClone(params.snapshot.skills).filter(
      (skill) => !skippedSkillNames.has(skill.name) || retainedSkillNames.has(skill.name),
    );
    const mounts: Array<{ hostPath: string; containerPath: string }> = [];
    for (const [index, skill] of delivery.skills.entries()) {
      const bundle = prepareSkillBundle(skill.files);
      for (const file of bundle.files) {
        let offset = 0;
        do {
          const operation: Extract<ResourceOperation, { op: "write" }> = {
            op: "write",
            ...location,
            name: `${index}/${file.path}`,
            offset,
            size: file.sizeBytes,
            hash: file.sha256,
            executable: file.executable,
            data: "",
          };
          const available =
            NODE_WORKER_WORKSPACE_STDIN_MAX_BYTES - Buffer.byteLength(JSON.stringify(operation));
          const chunkBytes = Math.floor(available / 4) * 3;
          if (chunkBytes <= 0) {
            throw new Error("Skill resource metadata exceeds the transfer limit.");
          }
          const bytes = file.bytes.subarray(offset, offset + chunkBytes);
          operation.data = bytes.toString("base64");
          await execute(operation);
          offset += bytes.length;
        } while (offset < file.bytes.length);
      }
      const selected = resolvedSkills.find((candidate) => candidate.filePath === skill.sourcePath);
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
        skills,
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
