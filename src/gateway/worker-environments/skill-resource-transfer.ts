import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  prepareSkillBundle,
  SKILL_LIBRARY_MAX_PATH_COMPONENTS,
} from "../../skills/library/bundle.js";
import { formatSkillsForPromptBounded } from "../../skills/loading/skill-prompt-limits.js";
import { prepareSkillResourceDelivery } from "../../skills/runtime/resources.js";
import type { SkillSnapshot } from "../../skills/types.js";
import { NODE_WORKER_WORKSPACE_STDIN_MAX_BYTES } from "../../worker/node-workspace-protocol.js";
import type { WorkerWorkspaceTunnelHandle } from "./tunnel-contract.js";
import {
  WORKER_ATTACHMENT_DIRECTORY_PATTERN,
  WORKER_ATTACHMENT_DIRECTORY_PREFIX,
} from "./workspace-path-exclusions.js";

type ResourceLocation = { directory: string; identity: string };
type ResourceOperation =
  | { op: "discover" }
  | { op: "init"; directory: string }
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

// Only the canonical workspace crosses argv validation; resource-relative names stay in stdin.
// The next admitted turn reclaims uncertain copies; generation retention owns unused workspaces.
const RESOURCE_SCRIPT = String.raw`
const fs=require('node:fs'), crypto=require('node:crypto');
const workspace=process.argv[1];
const identity=s=>String(s.dev)+':'+String(s.ino);
function enter(p,id){const s=fs.lstatSync(p,{bigint:true});if(!s.isDirectory()||s.isSymbolicLink()||(id&&identity(s)!==id))throw Error('resource directory changed');process.chdir(p);if(identity(fs.statSync('.',{bigint:true}))!==identity(s))throw Error('resource directory changed');}
function cleanup(directory,id){
 enter(directory,id);
 // Keep the ignore marker until payload deletion succeeds, so partial cleanup cannot expose inputs to Git.
 for(const entry of fs.readdirSync('.'))if(entry!=='.gitignore')fs.rmSync(entry,{recursive:true});
 fs.rmSync('.gitignore');
 // Windows locks cwd against removal. Delete contents while pinned, then verify from its parent.
 enter(workspace);if(identity(fs.lstatSync(directory,{bigint:true}))!==id)throw Error('resource directory changed');fs.rmdirSync(directory);
}
function discover(){
 // Return one candidate to bound the reply. Discovery never deletes: an old SSH command can arrive late.
 for(const directory of fs.readdirSync('.').sort()){
  if(/^${WORKER_ATTACHMENT_DIRECTORY_PATTERN}$/.exec(directory)?.[0]!==directory)continue;
  const s=fs.lstatSync(directory,{bigint:true});if(!s.isDirectory()||s.isSymbolicLink())continue;
  const id=identity(s);enter(directory,id);
  const marker=fs.lstatSync('.gitignore',{bigint:true,throwIfNoEntry:false});let owned=false;
  if(marker?.isFile()&&marker.nlink===1n&&marker.size===2n){
   const fd=fs.openSync('.gitignore',fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
   try{
    const opened=fs.fstatSync(fd,{bigint:true});
    if(!opened.isFile()||opened.nlink!==1n||opened.size!==2n||identity(opened)!==identity(marker))throw Error('resource marker changed');
    const bytes=Buffer.alloc(3),length=fs.readSync(fd,bytes,0,bytes.length,0);
    const after=fs.lstatSync('.gitignore',{bigint:true});
    owned=after.isFile()&&after.nlink===1n&&identity(after)===identity(opened)&&after.mtimeNs===opened.mtimeNs&&after.ctimeNs===opened.ctimeNs&&length===2&&bytes.toString('utf8',0,length)==='*\n';
   }finally{fs.closeSync(fd);}
  }
  enter(workspace);if(owned)return directory+' '+id;
 }
 return '';
}
try {
 const input=fs.readFileSync(0);if(input.length>${NODE_WORKER_WORKSPACE_STDIN_MAX_BYTES})throw Error('resource request exceeds input limit');
 const request=JSON.parse(input.toString('utf8')),op=request?.op;
 const keys=op==='discover'?['op']:op==='init'?['op','directory']:op==='cleanup'?['op','directory','identity']:op==='write'?['op','directory','identity','name','offset','size','hash','executable','data']:[];
 if(!request||typeof request!=='object'||Array.isArray(request)||!keys.length||Object.keys(request).length!==keys.length||keys.some(key=>!Object.hasOwn(request,key)))throw Error('invalid resource operation');
 const directory=request.directory;
 if(op!=='discover'&&(typeof directory!=='string'||/^${WORKER_ATTACHMENT_DIRECTORY_PATTERN}$/.exec(directory)?.[0]!==directory))throw Error('invalid resource directory');
 enter(workspace);
 if(op==='discover')process.stdout.write(discover());
 else if(op==='init'){fs.mkdirSync(directory,{mode:0o700});enter(directory);fs.chmodSync('.',0o700);fs.writeFileSync('.gitignore','*\n',{mode:0o400,flag:'wx'});process.stdout.write(identity(fs.statSync('.',{bigint:true})));}
 else {
  if(typeof request.identity!=='string'||request.identity.match(/^\d+:\d+$/)?.[0]!==request.identity)throw Error('invalid resource identity');
  if(op==='cleanup')cleanup(directory,request.identity);
  else {
   enter(directory,request.identity);
   const {name,offset,size,hash,executable,data}=request;
   if(typeof name!=='string'||typeof data!=='string'||typeof executable!=='boolean'||typeof hash!=='string'||hash.length!==64||!/^[a-f0-9]{64}$/.test(hash))throw Error('invalid resource chunk');
   // Bundle components cannot select Windows streams, drive-relative paths, aliases or devices.
   const parts=name.split('/');if(parts.some(p=>!p||p==='.'||p==='..'||/[\\:\x00]/.test(p)||/[ .]$/.test(p)||/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(p)||/^(conin|conout)\$$/i.test(p))||parts.length>${SKILL_LIBRARY_MAX_PATH_COMPONENTS + 1})throw Error('invalid resource path');
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

/** Stages private turn inputs in the workspace generation, excluded from Git and reconciliation. */
export async function transferSkillResources(params: {
  snapshot?: SkillSnapshot;
  tunnel: Pick<WorkerWorkspaceTunnelHandle, "runWorkspaceCommand">;
  remoteWorkspaceDir: string;
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
  const execute = async (operation: ResourceOperation) => {
    const cleanup = operation.op === "cleanup";
    const assertDispatchCurrent = cleanup ? params.assertCurrent : check;
    assertDispatchCurrent();
    const result = await params.tunnel.runWorkspaceCommand({
      argv: ["node", "-e", RESOURCE_SCRIPT, params.remoteWorkspaceDir],
      input: JSON.stringify(operation),
      transportRetry: "never",
      assertCurrent: assertDispatchCurrent,
      signal: cleanup ? undefined : params.signal,
      timeoutMs: cleanup ? 5000 : 60000,
    });
    // Accept the returned identity before observing cancellation; cleanup still requires
    // exact placement authority. The next turn or generation retirement reclaims lost replies.
    if (operation.op !== "init") {
      assertDispatchCurrent();
    }
    if (result.termination !== "exit" || result.code !== 0) {
      throw new Error(
        `Skill resource ${cleanup ? "cleanup" : "transfer"} failed. Retry this turn after reconnecting the execution environment.`,
      );
    }
    return result.stdout;
  };
  // Recheck the claim after read-only discovery, then delete only that captured identity.
  // A delayed old request cannot enumerate and delete a newer turn's private inputs.
  const locationPattern = new RegExp(`^(${WORKER_ATTACHMENT_DIRECTORY_PATTERN}) (\\d+:\\d+)$`);
  for (;;) {
    const candidate = await execute({ op: "discover" });
    if (!candidate) {
      break;
    }
    const match = locationPattern.exec(candidate);
    if (!match || match[0] !== candidate) {
      throw new Error("Invalid skill resource location from execution environment.");
    }
    check();
    await execute({ op: "cleanup", directory: match[1]!, identity: match[2]! });
  }
  if (!delivery || !params.snapshot) {
    return undefined;
  }
  const directory = `${WORKER_ATTACHMENT_DIRECTORY_PREFIX}${randomUUID()}`;
  const identity = await execute({ op: "init", directory });
  if (identity.match(/^\d+:\d+$/)?.[0] !== identity) {
    throw new Error("Invalid skill resource location from execution environment.");
  }
  const location = { directory, identity };
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
      const remoteBase = `${params.remoteWorkspaceDir.replaceAll("\\", "/")}/${directory}/${index}`;
      mounts.push({ hostPath: sourceBase, containerPath: remoteBase });
      if (selected) {
        selected.filePath = `${remoteBase}/SKILL.md`;
        selected.baseDir = remoteBase;
        // Code Mode reads the same verified instructions even when the node has no filesystem bridge.
        selected.readContent = bundle.files
          .find((file) => file.path === "SKILL.md")!
          .bytes.toString("utf8");
        delete selected.locationNote;
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
