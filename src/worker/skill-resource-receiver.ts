import path from "node:path";
import {
  parseWorkerSkillResourceOperation,
  WORKER_SKILL_RESOURCE_FILE_MAX_BYTES,
  WORKER_SKILL_RESOURCE_INPUT_MAX_BYTES,
  WORKER_SKILL_RESOURCE_PATH_MAX_DEPTH,
  type WorkerSkillResourceOperation,
} from "./skill-resource-protocol.js";

// Both transports use this receiver. Only their verified workspace owner supplies
// the parent; subsequent operations carry an opaque ID, never a caller-selected root.
const RESOURCE_SCRIPT = String.raw`
const fs=require('node:fs'), path=require('node:path'), crypto=require('node:crypto');
const [parent,generationText,encodedOperation]=process.argv.slice(1);
const identity=s=>String(s.dev)+':'+String(s.ino);
function enter(p,id){const s=fs.lstatSync(p,{bigint:true});if(!s.isDirectory()||s.isSymbolicLink()||(id&&identity(s)!==id))throw Error('resource directory changed');process.chdir(p);if(identity(fs.statSync('.',{bigint:true}))!==identity(s))throw Error('resource directory changed');}
function cleanup(directory,id){
 enter(directory,id);
 // Keep the artifact marker through partial payload cleanup so the next turn can recover it.
 for(const entry of fs.readdirSync('.'))if(entry!=='.gitignore')fs.rmSync(entry,{recursive:true});
 fs.rmSync('.gitignore');
 // Windows locks cwd against removal. Delete contents while pinned, then verify from its parent.
 enter(parent);if(identity(fs.lstatSync(directory,{bigint:true}))!==id)throw Error('resource directory changed');fs.rmdirSync(directory);
}
function discover(){
 // Names and markers classify artifacts; the verified owner authorizes later cleanup.
 // Return one identity without deleting: an old SSH request may arrive after a replacement turn.
 for(const directory of fs.readdirSync('.').sort()){
  const match=/^\.(0|[1-9]\d*)\.skill-resources-([a-f0-9]{32})$/.exec(directory);
  if(!match||match[0]!==directory||match[1]!==generationText)continue;
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
  enter(parent);if(owned)return JSON.stringify({resourceId:match[2],root:path.join(parent,directory),identity:id});
 }
 return '';
}
try {
 const generation=Number(generationText),op=JSON.parse(encodedOperation);
 if(!Number.isSafeInteger(generation)||generation<0||String(generation)!==generationText||!path.isAbsolute(parent)||fs.realpathSync.native(parent)!==parent)throw Error('invalid resource owner');
 enter(parent);
 if(op.operation==='discover'){process.stdout.write(discover());}
 else {
 const resourceId=op.operation==='init'?crypto.randomBytes(16).toString('hex'):op.resourceId;
 if(typeof resourceId!=='string'||!/^[a-f0-9]{32}$/.test(resourceId))throw Error('invalid resource ID');
 const name='.'+generation+'.skill-resources-'+resourceId,root=path.join(parent,name);
 if(op.operation==='init'){
  fs.mkdirSync(name,{mode:0o700});
  enter(name);fs.chmodSync('.',0o700);fs.writeFileSync('.gitignore','*\n',{mode:0o400,flag:'wx'});
  process.stdout.write(JSON.stringify({resourceId,root,identity:identity(fs.statSync('.',{bigint:true}))}));
 }else {
  if(op.operation==='cleanup'){cleanup(name,op.identity);}
  else if(op.operation==='write'){
   enter(name,op.identity);
   // Reject Windows streams, aliases and devices even when running on another OS.
   const parts=op.path.split('/');if(parts.some(p=>!p||p==='.'||p==='..'||/[\\:\x00]/.test(p)||/[ .]$/.test(p)||/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(p)||/^(conin|conout)\$$/i.test(p))||parts.length>${WORKER_SKILL_RESOURCE_PATH_MAX_DEPTH})throw Error('invalid resource path');
   for(const part of parts.slice(0,-1)){try{fs.mkdirSync(part,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}enter(part);}
   const offset=op.offset,size=op.sizeBytes,encoded=fs.readFileSync(0,'utf8'),bytes=Buffer.from(encoded,'base64');
   if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(size)||offset<0||size<0||size>${WORKER_SKILL_RESOURCE_FILE_MAX_BYTES}||offset+bytes.length>size||encoded.length>${WORKER_SKILL_RESOURCE_INPUT_MAX_BYTES}||bytes.toString('base64')!==encoded)throw Error('invalid resource chunk');
   const fd=fs.openSync(parts.at(-1),fs.constants.O_RDWR|(fs.constants.O_NOFOLLOW||0)|(offset===0?fs.constants.O_CREAT|fs.constants.O_EXCL:0),0o600);
   try{const s=fs.fstatSync(fd);if(!s.isFile()||s.nlink!==1||s.size!==offset)throw Error('resource file changed');let n=0;while(n<bytes.length){const written=fs.writeSync(fd,bytes,n,bytes.length-n,offset+n);if(!written)throw Error('resource write stalled');n+=written;}
    if(offset+bytes.length===size){if(crypto.createHash('sha256').update(fs.readFileSync(fd)).digest('hex')!==op.sha256)throw Error('resource digest mismatch');fs.fchmodSync(fd,op.executable?0o500:0o400);fs.fsyncSync(fd);}
   }finally{fs.closeSync(fd);}
  }else throw Error('invalid resource operation');
 }
 }
}catch(e){process.stderr.write(String(e.message));process.exitCode=1;}
`;

export function buildSkillResourceCommand(params: {
  parentDir: string;
  generation: number;
  operation: WorkerSkillResourceOperation;
}): string[] {
  if (
    (!path.posix.isAbsolute(params.parentDir) && !path.win32.isAbsolute(params.parentDir)) ||
    params.parentDir.includes("\0") ||
    !Number.isSafeInteger(params.generation) ||
    params.generation < 0
  ) {
    throw new Error("Invalid skill resource workspace owner");
  }
  return [
    "node",
    "-e",
    RESOURCE_SCRIPT,
    params.parentDir,
    String(params.generation),
    JSON.stringify(parseWorkerSkillResourceOperation(params.operation)),
  ];
}
