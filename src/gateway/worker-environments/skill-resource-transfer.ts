import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import {
  prepareSkillBundle,
  SKILL_LIBRARY_MAX_PATH_COMPONENTS,
  SKILL_WINDOWS_RESERVED_BASENAME_PATTERN,
} from "../../skills/library/bundle.js";
import { formatSkillsForPromptBounded } from "../../skills/loading/skill-prompt-limits.js";
import { prepareSkillResourceDelivery } from "../../skills/runtime/resources.js";
import type { SkillSnapshot } from "../../skills/types.js";
import { NODE_WORKER_WORKSPACE_STDIN_MAX_BYTES } from "../../worker/node-workspace-protocol.js";
import { cleanupSkillResourceAllocation } from "./skill-resource-allocation-cleanup.js";
import type { SkillResourceAllocationCoordinator } from "./skill-resource-allocation-coordinator.js";
import {
  skillResourceAllocationAttestation,
  skillResourceAllocationDirectoryName,
  type SkillResourceLeaseLocation,
  type SkillResourceLocation,
  type SkillResourceRuntimeOperation,
} from "./skill-resource-transfer-contract.js";
import type { WorkerWorkspaceTunnelHandle } from "./tunnel-contract.js";
type ResourceOperation = SkillResourceRuntimeOperation;

const RESOURCE_LEASE_MS = 60_000;
const RESOURCE_LEASE_RENEW_MS = 20_000;
const RESOURCE_SWEEP_MS = 1_000;
const RESOURCE_ROOT_PREFIX = "openclaw-inbound-";
const RESOURCE_REGISTRY_PREFIX = ".openclaw-skill-resource-lease-";
const RESOURCE_PERMIT_PREFIX = ".openclaw-skill-resource-permit-";
const RESOURCE_ROOT_MARKER = ".openclaw-skill-resource-owner";
const RESOURCE_STAGE_ROOT_PREFIX = ".staged-root.";
const RESOURCE_STAGE_CLAIM = ".openclaw-skill-resource-stage";

const RESOURCE_REAPER_SCRIPT = String.raw`
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const mode=process.argv[1],placementArgument=process.argv[2],sweepMs=Number(process.argv[3]),leaseMs=Number(process.argv[4]),initialize=mode==='initialize';
const identity=s=>String(s.dev)+':'+String(s.ino);
const resourceDirectory=id=>${JSON.stringify(RESOURCE_ROOT_PREFIX)}+[id.slice(0,8),id.slice(8,12),id.slice(12,16),id.slice(16,20),id.slice(20)].join('-');
let registryFile=initialize?undefined:placementArgument,recordMatch=registryFile?/^([a-f0-9]{32})\.([0-9]+)\.([0-9]+)\.json$/.exec(path.basename(registryFile)):undefined;
let id=initialize?process.argv[6]:recordMatch?.[1],recordIdentity=recordMatch?recordMatch[2]+':'+recordMatch[3]:undefined;
const workspace=initialize?placementArgument:path.dirname(path.dirname(registryFile)),registry=initialize?path.join(workspace,${JSON.stringify(RESOURCE_REGISTRY_PREFIX)}+id):path.dirname(registryFile);
const permit=initialize?path.join(workspace,${JSON.stringify(RESOURCE_PERMIT_PREFIX)}+id):undefined,claimedPermit=permit?permit+'.claimed':undefined;
let expectedRegistryIdentity=initialize?undefined:process.argv[5];const expectedWorkspaceIdentity=initialize?process.argv[5]:process.argv[6];
const attestation=process.argv[7],creatorIncarnation=initialize?process.argv[8]:crypto.randomBytes(16).toString('hex'),processIncarnation=crypto.randomBytes(16).toString('hex');
let root=id?path.join(registry,resourceDirectory(id)):undefined,lockFile=registryFile?registryFile+'.lock':undefined;
let rootMarker;const registryMarker=id?path.join(registry,'.owner.'+id):undefined,stageClaim=id?path.join(registry,${JSON.stringify(RESOURCE_STAGE_CLAIM)}+'.'+id):undefined;
let markerIdentity,markerNonce,stagedRootName,claimedPermitIdentity,claimedPermitBytes;
const maxLeaseMs=${RESOURCE_LEASE_MS};let parentClosed=false,observedLeaseIdentity,authorityDeadline=performance.now()+Math.min(leaseMs,maxLeaseMs);const failureGraceMs=Math.max(sweepMs,Math.floor(Math.min(leaseMs,maxLeaseMs)/3));
function validatePlacement(){const workspaceStat=fs.lstatSync(workspace,{bigint:true}),registryStat=fs.lstatSync(registry,{bigint:true});if(!workspaceStat.isDirectory()||workspaceStat.isSymbolicLink()||identity(workspaceStat)!==expectedWorkspaceIdentity||!registryStat.isDirectory()||registryStat.isSymbolicLink()||identity(registryStat)!==expectedRegistryIdentity)throw Error('resource registry changed');}
function syncDirectory(directory){let fd;try{fd=fs.openSync(directory,fs.constants.O_RDONLY);fs.fsyncSync(fd);}catch(error){if(!['EINVAL','ENOTSUP','EPERM','EISDIR','EBADF','ENOENT'].includes(error.code))throw error;}finally{if(fd!==undefined)fs.closeSync(fd);}}
function syncRegistry(){syncDirectory(registry);}
function writePrivate(file,value){let fd;try{fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|(fs.constants.O_NOFOLLOW||0),0o600);fs.chmodSync(file,0o600);const bytes=Buffer.from(value);let offset=0;while(offset<bytes.length){const written=fs.writeSync(fd,bytes,offset,bytes.length-offset,offset);if(!written)throw Error('resource ownership write stalled');offset+=written;}fs.fsyncSync(fd);}finally{if(fd!==undefined)fs.closeSync(fd);}}
function publicationPrefix(file){return '.openclaw-private-publish.'+crypto.createHash('sha256').update(path.basename(file)).digest('hex')+'.';}
function publishPrivate(file,value){const parent=path.dirname(file),temporary=path.join(parent,publicationPrefix(file)+crypto.randomBytes(16).toString('hex')+'.tmp');try{writePrivate(temporary,value);const temporaryStat=fs.lstatSync(temporary,{bigint:true});fs.linkSync(temporary,file);syncDirectory(parent);fs.unlinkSync(temporary);syncDirectory(parent);const publishedStat=fs.lstatSync(file,{bigint:true});if(!publishedStat.isFile()||publishedStat.isSymbolicLink()||publishedStat.nlink!==1n||identity(publishedStat)!==identity(temporaryStat)||fs.readFileSync(file,'utf8')!==value)throw Error('resource ownership publication changed');}finally{try{fs.unlinkSync(temporary);syncDirectory(parent);}catch(error){if(error.code!=='ENOENT')throw error;}}}
function retiredRegistryFiles(kind){const pattern=new RegExp('^\\.retired-'+kind+'\\.'+id+'\\.[1-9][0-9]*\\.[a-f0-9]{32}$');return fs.readdirSync(registry).filter(name=>pattern.test(name)).map(name=>path.join(registry,name));}
function restoreRetiredRegistryFile(file,expectedIdentity,expectedBytes,kind){validatePlacement();const retired=retiredRegistryFiles(kind);if(retired.length>1||(retired.length===1&&fs.existsSync(file)))throw Error('resource '+kind+' changed');if(retired.length===0)return false;const retiredFile=retired[0],retiredStat=fs.lstatSync(retiredFile,{bigint:true});if(!retiredStat.isFile()||retiredStat.isSymbolicLink()||retiredStat.nlink!==1n||identity(retiredStat)!==expectedIdentity||fs.readFileSync(retiredFile,'utf8')!==expectedBytes)throw Error('resource '+kind+' changed');fs.renameSync(retiredFile,file);validatePlacement();const restoredStat=fs.lstatSync(file,{bigint:true});if(identity(restoredStat)!==expectedIdentity||fs.readFileSync(file,'utf8')!==expectedBytes)throw Error('resource '+kind+' changed');return true;}
function retireExactRegistryFile(file,expectedIdentity,expectedBytes,kind){restoreRetiredRegistryFile(file,expectedIdentity,expectedBytes,kind);let sourceStat;try{sourceStat=fs.lstatSync(file,{bigint:true});}catch(error){if(error.code==='ENOENT')return false;throw error;}if(!sourceStat.isFile()||sourceStat.isSymbolicLink()||sourceStat.nlink!==1n||identity(sourceStat)!==expectedIdentity||fs.readFileSync(file,'utf8')!==expectedBytes)throw Error('resource '+kind+' changed');validatePlacement();const retired=path.join(registry,'.retired-'+kind+'.'+id+'.'+process.pid+'.'+crypto.randomBytes(16).toString('hex'));fs.renameSync(file,retired);try{validatePlacement();const retiredStat=fs.lstatSync(retired,{bigint:true});if(!retiredStat.isFile()||retiredStat.isSymbolicLink()||retiredStat.nlink!==1n||identity(retiredStat)!==expectedIdentity||fs.readFileSync(retired,'utf8')!==expectedBytes)throw Error('resource '+kind+' changed');fs.unlinkSync(retired);syncRegistry();validatePlacement();return true;}catch(error){try{if(!fs.existsSync(file))fs.renameSync(retired,file);}catch{}throw error;}}
function readOwnedFile(file,label){let fileStat;try{fileStat=fs.lstatSync(file,{bigint:true});}catch(error){if(error.code==='ENOENT')return;throw error;}if(!fileStat.isFile()||fileStat.isSymbolicLink()||fileStat.nlink!==1n)throw Error('resource '+label+' changed');return {bytes:fs.readFileSync(file,'utf8'),fileStat};}
function retireExactPermit(file,current){if(!current)return false;const sourceStat=fs.lstatSync(file,{bigint:true});if(identity(sourceStat)!==identity(current.fileStat)||fs.readFileSync(file,'utf8')!==current.bytes)throw Error('resource permit changed');const workspaceStat=fs.lstatSync(workspace,{bigint:true});if(identity(workspaceStat)!==expectedWorkspaceIdentity)throw Error('resource workspace changed');const retired=path.join(workspace,'.retired-claimed-permit.'+id+'.'+crypto.randomBytes(16).toString('hex'));fs.renameSync(file,retired);try{const currentWorkspaceStat=fs.lstatSync(workspace,{bigint:true}),retiredStat=fs.lstatSync(retired,{bigint:true});if(identity(currentWorkspaceStat)!==expectedWorkspaceIdentity||identity(retiredStat)!==identity(current.fileStat)||fs.readFileSync(retired,'utf8')!==current.bytes)throw Error('resource permit changed');fs.unlinkSync(retired);syncDirectory(workspace);return true;}catch(error){try{if(!fs.existsSync(file))fs.renameSync(retired,file);}catch{}throw error;}}
function writeInitialLease(){const temporary=path.join(registry,'.'+id+'.'+process.pid+'.'+crypto.randomBytes(16).toString('hex')+'.tmp'),now=Date.now(),expiresAt=now+leaseMs;authorityDeadline=performance.now()+Math.min(leaseMs,maxLeaseMs);try{writePrivate(temporary,JSON.stringify({id,identity:recordIdentity,root,workspace,attestation,markerIdentity,markerNonce,stagedRootName,creatorPid:process.pid,creatorIncarnation,expiresAt,commitDeadline:expiresAt,committed:false,cleanupPrepared:false}));fs.renameSync(temporary,registryFile);syncRegistry();}finally{try{fs.unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}}}
function processExists(pid){try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}}
function readLockOwner(fileStat){try{if(!fileStat.isFile()||fileStat.isSymbolicLink()||fileStat.nlink!==1n)return;const owner=JSON.parse(fs.readFileSync(lockFile,'utf8'));if(!owner||typeof owner!=='object'||Array.isArray(owner)||Object.keys(owner).sort().join(',')!=='attestation,expiresAt,id,identity,pid,processIncarnation')return;if(owner.id!==id||owner.identity!==recordIdentity||owner.attestation!==attestation||!Number.isSafeInteger(owner.pid)||owner.pid<=0||!Number.isSafeInteger(owner.expiresAt)||owner.expiresAt<0||typeof owner.processIncarnation!=='string'||!/^[a-f0-9]{32}$/.test(owner.processIncarnation))return;return owner;}catch{return;}}
function clearOwnerDeadLock(){
 let lockStat;try{lockStat=fs.lstatSync(lockFile,{bigint:true});}catch(error){return error.code==='ENOENT';}
 const owner=readLockOwner(lockStat);if(!owner||(owner.expiresAt>Date.now()&&processExists(owner.pid)))return false;
 const retired=path.join(registry,'.retired-lock.'+id+'.'+process.pid+'.'+crypto.randomBytes(16).toString('hex'));
 try{fs.renameSync(lockFile,retired);}catch(error){return error.code==='ENOENT';}
 const retiredStat=fs.lstatSync(retired,{bigint:true});if(identity(retiredStat)!==identity(lockStat)){try{if(!fs.existsSync(lockFile))fs.renameSync(retired,lockFile);}catch{}return false;}
 fs.unlinkSync(retired);syncRegistry();return true;
}
function acquireLock(){
 if(!recordMatch)return;
 for(let attempt=0;attempt<2;attempt++){
  const nonce=crypto.randomBytes(16).toString('hex'),temporary=path.join(registry,'.'+id+'.'+process.pid+'.'+nonce+'.tmp');let linked=false;
  try{writePrivate(temporary,JSON.stringify({id,identity:recordIdentity,attestation,pid:process.pid,processIncarnation,expiresAt:Date.now()+leaseMs}));const temporaryStat=fs.lstatSync(temporary,{bigint:true});try{fs.linkSync(temporary,lockFile);linked=true;}catch(error){if(error.code!=='EEXIST')throw error;}if(linked){const lockStat=fs.lstatSync(lockFile,{bigint:true});if(identity(lockStat)!==identity(temporaryStat))throw Error('resource ownership lock changed');fs.unlinkSync(temporary);syncRegistry();return identity(lockStat);}}
  finally{try{fs.unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}}
  if(!clearOwnerDeadLock())return;
 }
}
function releaseLock(lockIdentity){try{const lockStat=fs.lstatSync(lockFile,{bigint:true});if(identity(lockStat)!==lockIdentity)throw Error('resource ownership lock changed');validatePlacement();const retired=path.join(registry,'.retired-lock.'+id+'.'+process.pid+'.'+crypto.randomBytes(16).toString('hex'));fs.renameSync(lockFile,retired);validatePlacement();const retiredStat=fs.lstatSync(retired,{bigint:true});if(identity(retiredStat)!==lockIdentity){try{if(!fs.existsSync(lockFile))fs.renameSync(retired,lockFile);}catch{}throw Error('resource ownership lock changed');}fs.unlinkSync(retired);syncRegistry();validatePlacement();}catch(error){if(error.code!=='ENOENT')throw error;}try{const registryStat=fs.lstatSync(registry,{bigint:true});if(identity(registryStat)!==expectedRegistryIdentity)throw Error('resource registry changed');fs.rmdirSync(registry);syncDirectory(workspace);}catch(error){if(error.code!=='ENOENT'&&error.code!=='ENOTEMPTY'&&error.code!=='EEXIST')throw error;}}
function withLeaseFile(lease,fileStat,fileBytes){Object.defineProperties(lease,{_fileIdentity:{value:identity(fileStat)},_fileBytes:{value:fileBytes}});return lease;}
function quarantinedLease(fileStat,fileBytes){const lease={id,identity:recordIdentity,root,workspace,attestation,expiresAt:Number(fileStat.mtimeMs)+leaseMs,quarantined:true};try{const markerStat=fs.lstatSync(registryMarker,{bigint:true}),marker=JSON.parse(fs.readFileSync(registryMarker,'utf8'));if(!markerStat.isFile()||markerStat.isSymbolicLink()||!marker||typeof marker!=='object'||Array.isArray(marker)||Object.keys(marker).sort().join(',')!=='attestation,id,markerNonce,rootIdentity,stagedRootName'||marker.id!==id||marker.attestation!==attestation||marker.rootIdentity!==recordIdentity||typeof marker.markerNonce!=='string'||!/^[a-f0-9]{64}$/.test(marker.markerNonce)||typeof marker.stagedRootName!=='string'||!new RegExp('^'+${JSON.stringify(RESOURCE_STAGE_ROOT_PREFIX)}+marker.id+'\\.[1-9][0-9]*\\.[a-f0-9]{32}$').test(marker.stagedRootName))return withLeaseFile(lease,fileStat,fileBytes);return withLeaseFile({...lease,markerIdentity:identity(markerStat),markerNonce:marker.markerNonce,stagedRootName:marker.stagedRootName},fileStat,fileBytes);}catch{return withLeaseFile(lease,fileStat,fileBytes);}}
function readLease(){
 try{
  const fileStat=fs.lstatSync(registryFile,{bigint:true});
  let fileBytes;try{fileBytes=fs.readFileSync(registryFile,'utf8');}catch{return undefined;}const quarantined=quarantinedLease(fileStat,fileBytes);
  if(!fileStat.isFile()||fileStat.isSymbolicLink()||fileStat.nlink!==1n)return quarantined;
  let lease;try{lease=JSON.parse(fileBytes);}catch{return quarantined;}
  if(!lease||typeof lease!=='object'||Array.isArray(lease))return quarantined;
  if(lease.id!==id||lease.identity!==recordIdentity||lease.root!==root||lease.workspace!==workspace||lease.attestation!==attestation)return quarantined;
  const cleanupReceipt=lease.quarantined===true&&lease.cleanupPrepared===true;
  if(typeof lease.markerIdentity!=='string'||lease.markerIdentity.match(/^\d+:\d+$/)?.[0]!==lease.markerIdentity||typeof lease.markerNonce!=='string'||!/^[a-f0-9]{64}$/.test(lease.markerNonce)||typeof lease.stagedRootName!=='string'||!new RegExp('^'+${JSON.stringify(RESOURCE_STAGE_ROOT_PREFIX)}+lease.id+'\\.[1-9][0-9]*\\.[a-f0-9]{32}$').test(lease.stagedRootName)||!Number.isSafeInteger(lease.expiresAt)||lease.expiresAt<0||typeof lease.cleanupPrepared!=='boolean'||(!cleanupReceipt&&(!Number.isSafeInteger(lease.creatorPid)||lease.creatorPid<=0||typeof lease.creatorIncarnation!=='string'||!/^[a-f0-9]{32}$/.test(lease.creatorIncarnation)||!Number.isSafeInteger(lease.commitDeadline)||lease.commitDeadline<0||typeof lease.committed!=='boolean')))return quarantined;
  return withLeaseFile(lease,fileStat,fileBytes);
 }catch(error){return error.code==='ENOENT'?null:undefined;}
}
function markerValue(lease){return JSON.stringify({attestation:lease.attestation,id:lease.id,markerNonce:lease.markerNonce,rootIdentity:lease.identity,stagedRootName:lease.stagedRootName});}
function restoreRetiredLease(){validatePlacement();const retired=retiredRegistryFiles('lease');if(retired.length>1||(retired.length===1&&fs.existsSync(registryFile)))throw Error('resource lease changed');if(retired.length===0)return;const file=retired[0],fileStat=fs.lstatSync(file,{bigint:true}),bytes=fs.readFileSync(file,'utf8'),lease=JSON.parse(bytes),cleanupReceipt=lease?.quarantined===true&&lease?.cleanupPrepared===true;if(!fileStat.isFile()||fileStat.isSymbolicLink()||fileStat.nlink!==1n||lease.id!==id||lease.identity!==recordIdentity||lease.root!==root||lease.workspace!==workspace||lease.attestation!==attestation||typeof lease.markerIdentity!=='string'||lease.markerIdentity.match(/^\d+:\d+$/)?.[0]!==lease.markerIdentity||typeof lease.markerNonce!=='string'||!/^[a-f0-9]{64}$/.test(lease.markerNonce)||typeof lease.stagedRootName!=='string'||!new RegExp('^'+${JSON.stringify(RESOURCE_STAGE_ROOT_PREFIX)}+lease.id+'\\.[1-9][0-9]*\\.[a-f0-9]{32}$').test(lease.stagedRootName)||!Number.isSafeInteger(lease.expiresAt)||lease.expiresAt<0||typeof lease.cleanupPrepared!=='boolean'||(!cleanupReceipt&&(!Number.isSafeInteger(lease.creatorPid)||lease.creatorPid<=0||typeof lease.creatorIncarnation!=='string'||!/^[a-f0-9]{32}$/.test(lease.creatorIncarnation)||!Number.isSafeInteger(lease.commitDeadline)||lease.commitDeadline<0||typeof lease.committed!=='boolean')))throw Error('resource lease changed');restoreRetiredRegistryFile(registryFile,identity(fileStat),bytes,'lease');}
function replaceLease(lease,next){validatePlacement();const currentStat=fs.lstatSync(registryFile,{bigint:true});if(identity(currentStat)!==lease._fileIdentity||fs.readFileSync(registryFile,'utf8')!==lease._fileBytes)throw Error('resource lease changed');const temporary=path.join(registry,'.'+id+'.'+process.pid+'.'+crypto.randomBytes(16).toString('hex')+'.tmp'),bytes=JSON.stringify(next);try{writePrivate(temporary,bytes);validatePlacement();const unchanged=fs.lstatSync(registryFile,{bigint:true});if(identity(unchanged)!==lease._fileIdentity||fs.readFileSync(registryFile,'utf8')!==lease._fileBytes)throw Error('resource lease changed');fs.renameSync(temporary,registryFile);syncRegistry();validatePlacement();const replaced=fs.lstatSync(registryFile,{bigint:true});if(!replaced.isFile()||replaced.isSymbolicLink()||replaced.nlink!==1n||fs.readFileSync(registryFile,'utf8')!==bytes)throw Error('resource lease changed');}finally{try{fs.unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}}}
function validateRegistryMarker(lease,links){const markerStat=fs.lstatSync(registryMarker,{bigint:true});if(!markerStat.isFile()||markerStat.isSymbolicLink()||markerStat.nlink!==links||identity(markerStat)!==lease.markerIdentity||fs.readFileSync(registryMarker,'utf8')!==markerValue(lease))throw Error('resource ownership marker changed');}
function validateMarkerAt(lease,rootPath){const rootMarkerPath=path.join(rootPath,${JSON.stringify(RESOURCE_ROOT_MARKER)}),rootMarkerStat=fs.lstatSync(rootMarkerPath,{bigint:true}),registryMarkerStat=fs.lstatSync(registryMarker,{bigint:true});if(!rootMarkerStat.isFile()||rootMarkerStat.isSymbolicLink()||rootMarkerStat.nlink!==2n||!registryMarkerStat.isFile()||registryMarkerStat.isSymbolicLink()||registryMarkerStat.nlink!==2n||identity(rootMarkerStat)!==lease.markerIdentity||identity(registryMarkerStat)!==lease.markerIdentity||fs.readFileSync(rootMarkerPath,'utf8')!==markerValue(lease)||fs.readFileSync(registryMarker,'utf8')!==markerValue(lease))throw Error('resource ownership marker changed');}
function validateRetiredRoot(lease,retired){const retiredStat=fs.lstatSync(retired,{bigint:true});if(!retiredStat.isDirectory()||retiredStat.isSymbolicLink()||identity(retiredStat)!==lease.identity)throw Error('resource directory changed');const rootMarkerPath=path.join(retired,${JSON.stringify(RESOURCE_ROOT_MARKER)});try{fs.lstatSync(rootMarkerPath,{bigint:true});validateMarkerAt(lease,retired);}catch(error){if(error.code!=='ENOENT')throw error;if(fs.readdirSync(retired).length!==0)throw Error('resource ownership marker changed');validateRegistryMarker(lease,1n);}return retiredStat;}
function removeRetiredRoot(lease,retired){validateRetiredRoot(lease,retired);const rootMarkerPath=path.join(retired,${JSON.stringify(RESOURCE_ROOT_MARKER)});let markerPresent=true;try{fs.lstatSync(rootMarkerPath,{bigint:true});}catch(error){if(error.code==='ENOENT')markerPresent=false;else throw error;}if(markerPresent){for(const name of fs.readdirSync(retired)){if(name===${JSON.stringify(RESOURCE_ROOT_MARKER)})continue;validatePlacement();validateMarkerAt(lease,retired);fs.rmSync(path.join(retired,name),{recursive:true,force:true});}validatePlacement();validateMarkerAt(lease,retired);if(fs.readdirSync(retired).some(name=>name!==${JSON.stringify(RESOURCE_ROOT_MARKER)}))throw Error('resource cleanup incomplete');fs.unlinkSync(rootMarkerPath);syncDirectory(retired);}validatePlacement();validateRetiredRoot(lease,retired);if(fs.readdirSync(retired).length!==0)throw Error('resource cleanup incomplete');fs.rmdirSync(retired);syncRegistry();validatePlacement();try{fs.lstatSync(retired);throw Error('resource cleanup incomplete');}catch(error){if(error.code!=='ENOENT')throw error;}}
function retireRoot(lease){
 let rootStat;try{rootStat=fs.lstatSync(lease.root,{bigint:true});}catch(error){if(error.code==='ENOENT')return false;throw error;}
 if(lease.quarantined){if(!lease.markerIdentity)return false;try{validateMarkerAt(lease,lease.root);}catch{return false;}}
 if(!rootStat.isDirectory()||rootStat.isSymbolicLink()||identity(rootStat)!==lease.identity)throw Error('resource directory changed');validateMarkerAt(lease,lease.root);
 validatePlacement();const retired=path.join(registry,'.retired-root.'+lease.id+'.'+process.pid+'.'+crypto.randomBytes(16).toString('hex'));
 fs.renameSync(lease.root,retired);try{syncDirectory(workspace);syncRegistry();validatePlacement();const retiredStat=fs.lstatSync(retired,{bigint:true});if(!retiredStat.isDirectory()||retiredStat.isSymbolicLink()||identity(retiredStat)!==lease.identity)throw Error('resource directory changed');validateMarkerAt(lease,retired);}catch(error){try{const retiredStat=fs.lstatSync(retired,{bigint:true});if(!fs.existsSync(lease.root))fs.renameSync(retired,lease.root);}catch{}throw error;}
 removeRetiredRoot(lease,retired);return true;
}
function recoverRetiredRoots(lease){validatePlacement();for(const name of fs.readdirSync(registry)){if(!new RegExp('^\\.retired-root\\.'+lease.id+'\\.[1-9][0-9]*\\.[a-f0-9]{32}$').test(name))continue;const retired=path.join(registry,name);validateRetiredRoot(lease,retired);validatePlacement();const recovery=path.join(registry,'.retired-root.'+lease.id+'.'+process.pid+'.'+crypto.randomBytes(16).toString('hex'));fs.renameSync(retired,recovery);try{validatePlacement();validateRetiredRoot(lease,recovery);}catch(error){try{if(!fs.existsSync(retired))fs.renameSync(recovery,retired);}catch{}throw error;}removeRetiredRoot(lease,recovery);}}
function recoverStagedRoot(lease){if(typeof lease.stagedRootName!=='string')return;const staged=path.join(registry,lease.stagedRootName);let stagedStat;try{stagedStat=fs.lstatSync(staged,{bigint:true});}catch(error){if(error.code==='ENOENT')return;throw error;}if(fs.existsSync(lease.root))throw Error('resource directory changed');if(!stagedStat.isDirectory()||stagedStat.isSymbolicLink()||identity(stagedStat)!==lease.identity)throw Error('resource directory changed');validateMarkerAt(lease,staged);validatePlacement();const retired=path.join(registry,'.retired-root.'+lease.id+'.'+process.pid+'.'+crypto.randomBytes(16).toString('hex'));fs.renameSync(staged,retired);try{syncRegistry();validatePlacement();validateRetiredRoot(lease,retired);}catch(error){try{if(!fs.existsSync(staged))fs.renameSync(retired,staged);}catch{}throw error;}removeRetiredRoot(lease,retired);}
function hasRetiredRoot(lease){const pattern=new RegExp('^\\.retired-root\\.'+lease.id+'\\.[1-9][0-9]*\\.[a-f0-9]{32}$');return fs.readdirSync(registry).some(name=>pattern.test(name));}
function hasStagedRoot(lease){const pattern=new RegExp('^'+${JSON.stringify(RESOURCE_STAGE_ROOT_PREFIX)}+lease.id+'\\.[1-9][0-9]*\\.[a-f0-9]{32}$');return fs.readdirSync(registry).some(name=>pattern.test(name));}
function hasRetiredFile(){const pattern=new RegExp('^\\.retired-(?:marker|stage|lease)\\.'+id+'\\.[1-9][0-9]*\\.[a-f0-9]{32}$');return fs.readdirSync(registry).some(name=>pattern.test(name));}
function prepareCleanup(lease){
 const workspaceStat=fs.lstatSync(workspace,{bigint:true});if(!workspaceStat.isDirectory()||workspaceStat.isSymbolicLink())throw Error('resource workspace changed');
 process.chdir(workspace);if(identity(fs.statSync('.',{bigint:true}))!==identity(workspaceStat))throw Error('resource workspace changed');
 recoverRetiredRoots(lease);recoverStagedRoot(lease);retireRoot(lease);
 if(fs.existsSync(lease.root))throw Error('resource directory changed');
 retireExactRegistryFile(registryMarker,lease.markerIdentity,markerValue(lease),'marker');
 if(claimedPermit){const claimed=readOwnedFile(claimedPermit,'permit');if(claimed){const owner=JSON.parse(claimed.bytes);if(!owner||typeof owner!=='object'||Array.isArray(owner)||owner.id!==lease.id||owner.attestation!==lease.attestation||owner.pid!==lease.creatorPid||owner.processIncarnation!==lease.creatorIncarnation)throw Error('resource permit changed');retireExactPermit(claimedPermit,claimed);}}
 if(stageClaim){const stage=readOwnedFile(stageClaim,'stage');if(stage){const claim=JSON.parse(stage.bytes);if(!claim||typeof claim!=='object'||Array.isArray(claim)||Object.keys(claim).sort().join(',')!=='attestation,id,markerNonce,stagedRootName'||claim.id!==lease.id||claim.attestation!==lease.attestation||claim.markerNonce!==lease.markerNonce||claim.stagedRootName!==lease.stagedRootName)throw Error('resource stage changed');retireExactRegistryFile(stageClaim,identity(stage.fileStat),stage.bytes,'stage');}}
 for(const target of [lease.root,registryMarker,claimedPermit,stageClaim,lease.stagedRootName?path.join(registry,lease.stagedRootName):undefined])if(target)try{fs.lstatSync(target);throw Error('resource cleanup incomplete');}catch(error){if(error.code!=='ENOENT')throw error;}
 if(hasRetiredRoot(lease)||hasStagedRoot(lease)||hasRetiredFile())throw Error('resource cleanup incomplete');
 for(const target of [lease.root,registryMarker,claimedPermit,stageClaim])if(target)try{fs.lstatSync(target);throw Error('resource cleanup incomplete');}catch(error){if(error.code!=='ENOENT')throw error;}
 if(hasRetiredRoot(lease)||hasStagedRoot(lease)||hasRetiredFile())throw Error('resource cleanup incomplete');
 if(!lease.cleanupPrepared)replaceLease(lease,{...lease,cleanupPrepared:true});
}
function sweep(){
 const failed=()=>performance.now()>=authorityDeadline+failureGraceMs?'blocked':'active';
 try{validatePlacement();}catch(error){if(error.code==='ENOENT'&&!fs.existsSync(registry)&&!fs.existsSync(root))return 'retired';return failed();}const lockIdentity=acquireLock();if(!lockIdentity)return failed();
 try{validatePlacement();restoreRetiredLease();const lease=readLease();if(lease===null)return fs.existsSync(root)||hasRetiredRoot({id})||hasStagedRoot({id})||hasRetiredFile()?failed():'retired';if(!lease)return failed();if(lease._fileIdentity!==observedLeaseIdentity){observedLeaseIdentity=lease._fileIdentity;authorityDeadline=performance.now()+maxLeaseMs;}if(lease.cleanupPrepared)return 'retired';const uncommittedClosed=!lease.committed&&parentClosed&&lease.commitDeadline<=Date.now();if(!uncommittedClosed&&lease.expiresAt>Date.now()&&performance.now()<authorityDeadline&&!hasRetiredRoot(lease)&&!hasStagedRoot(lease))return 'active';prepareCleanup(lease);return 'retired';}catch{return failed();}finally{try{releaseLock(lockIdentity);}catch{}}
}
async function awaitPermit(){let input='';await new Promise((resolve,reject)=>{process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{input+=chunk;if(input.length>16)reject(Error('invalid resource permit'));if(input==='permit')resolve();});process.stdin.once('error',reject);process.stdin.once('end',()=>{parentClosed=true;if(input!=='permit')reject(Error('resource permit closed'));});process.stdin.resume();});if(input!=='permit')throw Error('invalid resource permit');}
function assertClaimedPermit(){const workspaceStat=fs.lstatSync(workspace,{bigint:true}),claimedStat=fs.lstatSync(claimedPermit,{bigint:true}),bytes=fs.readFileSync(claimedPermit,'utf8');if(!workspaceStat.isDirectory()||workspaceStat.isSymbolicLink()||identity(workspaceStat)!==expectedWorkspaceIdentity||!claimedStat.isFile()||claimedStat.isSymbolicLink()||claimedStat.nlink!==1n||identity(claimedStat)!==claimedPermitIdentity||bytes!==claimedPermitBytes)throw Error('resource permit changed');const owner=JSON.parse(bytes);if(!owner||typeof owner!=='object'||Array.isArray(owner)||Object.keys(owner).sort().join(',')!=='attestation,expiresAt,id,pid,processIncarnation'||owner.id!==id||owner.pid!==process.pid||owner.attestation!==attestation||owner.processIncarnation!==creatorIncarnation||!Number.isSafeInteger(owner.expiresAt)||owner.expiresAt<Date.now())throw Error('resource permit changed');}
async function initializeAllocation(){
 try{
  if(typeof id!=='string'||!/^[a-f0-9]{32}$/.test(id)||typeof attestation!=='string'||!/^[a-f0-9]{64}$/.test(attestation)||typeof creatorIncarnation!=='string'||!/^[a-f0-9]{32}$/.test(creatorIncarnation))throw Error('invalid resource initialization');
  const workspaceStat=fs.lstatSync(workspace,{bigint:true});if(!workspaceStat.isDirectory()||workspaceStat.isSymbolicLink()||identity(workspaceStat)!==expectedWorkspaceIdentity)throw Error('resource workspace changed');
  await awaitPermit();
  const permitStat=fs.lstatSync(permit,{bigint:true});if(!permitStat.isFile()||permitStat.isSymbolicLink()||permitStat.nlink!==1n)throw Error('resource permit changed');const permitRecord=JSON.parse(fs.readFileSync(permit,'utf8'));if(!permitRecord||typeof permitRecord!=='object'||Array.isArray(permitRecord)||Object.keys(permitRecord).sort().join(',')!=='attestation,expiresAt,id,pid,processIncarnation'||permitRecord.id!==id||permitRecord.pid!==process.pid||permitRecord.attestation!==attestation||permitRecord.processIncarnation!==creatorIncarnation||!Number.isSafeInteger(permitRecord.expiresAt)||permitRecord.expiresAt<Date.now())throw Error('resource permit changed');fs.renameSync(permit,claimedPermit);syncDirectory(workspace);const claimedStat=fs.lstatSync(claimedPermit,{bigint:true});if(identity(claimedStat)!==identity(permitStat))throw Error('resource permit changed');claimedPermitIdentity=identity(claimedStat);claimedPermitBytes=fs.readFileSync(claimedPermit,'utf8');assertClaimedPermit();
  fs.mkdirSync(registry,{mode:0o700});assertClaimedPermit();fs.chmodSync(registry,0o700);syncDirectory(workspace);const registryStat=fs.lstatSync(registry,{bigint:true});if(!registryStat.isDirectory()||registryStat.isSymbolicLink())throw Error('resource registry changed');expectedRegistryIdentity=identity(registryStat);validatePlacement();
  markerNonce=crypto.randomBytes(32).toString('hex');stagedRootName=${JSON.stringify(RESOURCE_STAGE_ROOT_PREFIX)}+id+'.'+process.pid+'.'+crypto.randomBytes(16).toString('hex');const stagedRoot=path.join(registry,stagedRootName);assertClaimedPermit();publishPrivate(stageClaim,JSON.stringify({attestation,id,markerNonce,stagedRootName}));assertClaimedPermit();fs.mkdirSync(stagedRoot,{mode:0o700});assertClaimedPermit();fs.chmodSync(stagedRoot,0o700);syncRegistry();const stagedRootStat=fs.lstatSync(stagedRoot,{bigint:true});if(!stagedRootStat.isDirectory()||stagedRootStat.isSymbolicLink())throw Error('resource directory changed');
  recordIdentity=identity(stagedRootStat);rootMarker=path.join(stagedRoot,${JSON.stringify(RESOURCE_ROOT_MARKER)});assertClaimedPermit();publishPrivate(rootMarker,markerValue({attestation,id,markerNonce,identity:recordIdentity,stagedRootName}));assertClaimedPermit();fs.linkSync(rootMarker,registryMarker);syncDirectory(stagedRoot);syncRegistry();const stagedMarkerStat=fs.lstatSync(rootMarker,{bigint:true}),registryMarkerStat=fs.lstatSync(registryMarker,{bigint:true});if(identity(stagedMarkerStat)!==identity(registryMarkerStat)||stagedMarkerStat.nlink!==2n||registryMarkerStat.nlink!==2n)throw Error('resource ownership marker changed');markerIdentity=identity(stagedMarkerStat);assertClaimedPermit();fs.renameSync(stagedRoot,root);syncRegistry();const rootStat=fs.lstatSync(root,{bigint:true});rootMarker=path.join(root,${JSON.stringify(RESOURCE_ROOT_MARKER)});if(!rootStat.isDirectory()||rootStat.isSymbolicLink()||identity(rootStat)!==recordIdentity)throw Error('resource directory changed');recordIdentity=identity(rootStat);registryFile=path.join(registry,id+'.'+recordIdentity.replace(':','.')+'.json');recordMatch=/^([a-f0-9]{32})\.([0-9]+)\.([0-9]+)\.json$/.exec(path.basename(registryFile));lockFile=registryFile+'.lock';assertClaimedPermit();writeInitialLease();validateMarkerAt({id,identity:recordIdentity,attestation,markerIdentity,markerNonce,stagedRootName},root);assertClaimedPermit();fs.unlinkSync(stageClaim);syncRegistry();assertClaimedPermit();
  process.stdout.write(JSON.stringify({identity:recordIdentity,registryIdentity:expectedRegistryIdentity,workspaceIdentity:expectedWorkspaceIdentity}),()=>process.stdout.end());
 }catch(error){throw error;}
}
async function main(){if(initialize)await initializeAllocation();if(mode==='once'){sweep();}
else{
 const timer=setInterval(()=>{if(sweep()!=='active')clearInterval(timer);},sweepMs);
 if(sweep()!=='active')clearInterval(timer);
}}
void main().catch(error=>{process.stdin.destroy();process.stdout.end();process.stderr.write(String(error.message));process.exitCode=1;});
`;

const compressedSkillResourceReaper = deflateRawSync(RESOURCE_REAPER_SCRIPT).toString("base64");
const SKILL_RESOURCE_REAPER_RUNTIME_SCRIPT =
  `const s=${JSON.stringify(compressedSkillResourceReaper)};` +
  `(0,eval)(require('node:zlib').inflateRawSync(Buffer.from(s,'base64')).toString())`;

// Resource names belong to this helper, not workspace argv. Host and receiver derive the same
// private path from canonical placement state; lossless identities fence replacement.
const SKILL_RESOURCE_RUNTIME_SOURCE = String.raw`
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const identity=s=>String(s.dev)+':'+String(s.ino);
const resourceDirectory=id=>${JSON.stringify(RESOURCE_ROOT_PREFIX)}+[id.slice(0,8),id.slice(8,12),id.slice(12,16),id.slice(16,20),id.slice(20)].join('-');
function enter(p,id){const s=fs.lstatSync(p,{bigint:true});if(!s.isDirectory()||s.isSymbolicLink()||(id&&identity(s)!==id))throw Error('resource directory changed');process.chdir(p);if(identity(fs.statSync('.',{bigint:true}))!==identity(s))throw Error('resource directory changed');}
const registryPrefix=${JSON.stringify(RESOURCE_REGISTRY_PREFIX)},permitPrefix=${JSON.stringify(RESOURCE_PERMIT_PREFIX)},rootMarkerName=${JSON.stringify(RESOURCE_ROOT_MARKER)},stageRootPrefix=${JSON.stringify(RESOURCE_STAGE_ROOT_PREFIX)},stageClaimName=${JSON.stringify(RESOURCE_STAGE_CLAIM)},leaseMs=${RESOURCE_LEASE_MS},sweepMs=${RESOURCE_SWEEP_MS},processIncarnation=crypto.randomBytes(16).toString('hex');
const reaperScript=${JSON.stringify(SKILL_RESOURCE_REAPER_RUNTIME_SCRIPT)};
const workspace=fs.realpathSync('.');let registry;
function validatePlacement(location){const workspaceStat=fs.lstatSync(workspace,{bigint:true}),registryStat=fs.lstatSync(location.registry,{bigint:true});if(!workspaceStat.isDirectory()||workspaceStat.isSymbolicLink()||identity(workspaceStat)!==location.workspaceIdentity||!registryStat.isDirectory()||registryStat.isSymbolicLink()||identity(registryStat)!==location.registryIdentity)throw Error('resource registry changed');registry=location.registry;}
function buildLocation(request){
 if(typeof request.workspace!=='string'||request.workspace!==workspace)throw Error('resource workspace changed');
 if(typeof request.id!=='string'||!/^[a-f0-9]{32}$/.test(request.id))throw Error('invalid resource id');
 if(typeof request.attestation!=='string'||!/^[a-f0-9]{64}$/.test(request.attestation))throw Error('invalid resource attestation');
 if(typeof request.identity!=='string'||request.identity.match(/^\d+:\d+$/)?.[0]!==request.identity)throw Error('invalid resource identity');
 if(typeof request.workspaceIdentity!=='string'||request.workspaceIdentity.match(/^\d+:\d+$/)?.[0]!==request.workspaceIdentity)throw Error('invalid workspace identity');
 if(typeof request.registryIdentity!=='string'||request.registryIdentity.match(/^\d+:\d+$/)?.[0]!==request.registryIdentity)throw Error('invalid registry identity');
 const registryPath=path.join(workspace,registryPrefix+request.id),root=path.join(registryPath,resourceDirectory(request.id));
 return {id:request.id,identity:request.identity,attestation:request.attestation,root,workspace,workspaceIdentity:request.workspaceIdentity,registryIdentity:request.registryIdentity,registry:registryPath,registryFile:path.join(registryPath,request.id+'.'+request.identity.replace(':','.')+'.json'),registryMarker:path.join(registryPath,'.owner.'+request.id)};
}
function validateLocation(request){const location=buildLocation(request);validatePlacement(location);return location;}
function readLeaseAt(location,file){
 const s=fs.lstatSync(file,{bigint:true});if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1n)throw Error('resource lease changed');
 const bytes=fs.readFileSync(file,'utf8'),lease=JSON.parse(bytes);
 for(const field of ['id','identity','attestation','root','workspace'])if(lease[field]!==location[field])throw Error('resource lease changed');
 const cleanupReceipt=lease.quarantined===true&&lease.cleanupPrepared===true;
 if(typeof lease.markerIdentity!=='string'||lease.markerIdentity.match(/^\d+:\d+$/)?.[0]!==lease.markerIdentity||typeof lease.markerNonce!=='string'||!/^[a-f0-9]{64}$/.test(lease.markerNonce)||typeof lease.stagedRootName!=='string'||!new RegExp('^'+stageRootPrefix+lease.id+'\\.[1-9][0-9]*\\.[a-f0-9]{32}$').test(lease.stagedRootName)||!Number.isSafeInteger(lease.expiresAt)||lease.expiresAt<0||typeof lease.cleanupPrepared!=='boolean'||(!cleanupReceipt&&(!Number.isSafeInteger(lease.creatorPid)||lease.creatorPid<=0||typeof lease.creatorIncarnation!=='string'||!/^[a-f0-9]{32}$/.test(lease.creatorIncarnation)||!Number.isSafeInteger(lease.commitDeadline)||lease.commitDeadline<0||typeof lease.committed!=='boolean')))throw Error('resource lease changed');
 Object.defineProperties(lease,{_fileIdentity:{value:identity(s)},_fileBytes:{value:bytes}});return lease;
}
function readLease(location){return readLeaseAt(location,location.registryFile);}
function markerValue(lease){return JSON.stringify({attestation:lease.attestation,id:lease.id,markerNonce:lease.markerNonce,rootIdentity:lease.identity,stagedRootName:lease.stagedRootName});}
function validateRegistryMarker(location,lease,links){const markerStat=fs.lstatSync(location.registryMarker,{bigint:true});if(!markerStat.isFile()||markerStat.isSymbolicLink()||markerStat.nlink!==links||identity(markerStat)!==lease.markerIdentity||fs.readFileSync(location.registryMarker,'utf8')!==markerValue(lease))throw Error('resource ownership marker changed');}
function validateMarkerAt(location,lease,rootPath){const rootMarker=path.join(rootPath,rootMarkerName),rootMarkerStat=fs.lstatSync(rootMarker,{bigint:true}),registryMarkerStat=fs.lstatSync(location.registryMarker,{bigint:true});if(!rootMarkerStat.isFile()||rootMarkerStat.isSymbolicLink()||rootMarkerStat.nlink!==2n||!registryMarkerStat.isFile()||registryMarkerStat.isSymbolicLink()||registryMarkerStat.nlink!==2n||identity(rootMarkerStat)!==lease.markerIdentity||identity(registryMarkerStat)!==lease.markerIdentity||fs.readFileSync(rootMarker,'utf8')!==markerValue(lease)||fs.readFileSync(location.registryMarker,'utf8')!==markerValue(lease))throw Error('resource ownership marker changed');}
function syncDirectory(directory){let fd;try{fd=fs.openSync(directory,fs.constants.O_RDONLY);fs.fsyncSync(fd);}catch(error){if(!['EINVAL','ENOTSUP','EPERM','EISDIR','EBADF'].includes(error.code))throw error;}finally{if(fd!==undefined)fs.closeSync(fd);}}
function syncRegistry(){syncDirectory(registry);}
function writePrivate(file,value){let fd;try{fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|(fs.constants.O_NOFOLLOW||0),0o600);fs.chmodSync(file,0o600);const bytes=Buffer.from(value);let offset=0;while(offset<bytes.length){const written=fs.writeSync(fd,bytes,offset,bytes.length-offset,offset);if(!written)throw Error('resource ownership write stalled');offset+=written;}fs.fsyncSync(fd);}finally{if(fd!==undefined)fs.closeSync(fd);}}
function publicationPrefix(file){return '.openclaw-private-publish.'+crypto.createHash('sha256').update(path.basename(file)).digest('hex')+'.';}
function discardPrivatePublicationTemps(file){const parent=path.dirname(file),prefix=publicationPrefix(file),suffix=/^[a-f0-9]{32}\.tmp$/;let parentStat;try{parentStat=fs.lstatSync(parent,{bigint:true});}catch(error){if(error.code==='ENOENT')return;throw error;}if(!parentStat.isDirectory()||parentStat.isSymbolicLink())throw Error('resource ownership directory changed');const parentIdentity=identity(parentStat);let publishedStat;try{publishedStat=fs.lstatSync(file,{bigint:true});}catch(error){if(error.code!=='ENOENT')throw error;}for(const name of fs.readdirSync(parent)){if(!name.startsWith(prefix)||!suffix.test(name.slice(prefix.length)))continue;const temporary=path.join(parent,name),temporaryStat=fs.lstatSync(temporary,{bigint:true});if(!temporaryStat.isFile()||temporaryStat.isSymbolicLink()||temporaryStat.uid!==parentStat.uid||(temporaryStat.mode&0o777n)!==0o600n||(temporaryStat.nlink!==1n&&temporaryStat.nlink!==2n))throw Error('resource ownership publication changed');if(temporaryStat.nlink===2n&&(!publishedStat||!publishedStat.isFile()||publishedStat.isSymbolicLink()||publishedStat.nlink!==2n||identity(publishedStat)!==identity(temporaryStat)))throw Error('resource ownership publication changed');fs.unlinkSync(temporary);syncDirectory(parent);if(temporaryStat.nlink===2n){const settled=fs.lstatSync(file,{bigint:true});if(!settled.isFile()||settled.isSymbolicLink()||settled.nlink!==1n||identity(settled)!==identity(temporaryStat))throw Error('resource ownership publication changed');publishedStat=settled;}}const currentParent=fs.lstatSync(parent,{bigint:true});if(identity(currentParent)!==parentIdentity)throw Error('resource ownership directory changed');}
function publishPrivate(file,value){const parent=path.dirname(file),temporary=path.join(parent,publicationPrefix(file)+crypto.randomBytes(16).toString('hex')+'.tmp');try{writePrivate(temporary,value);const temporaryStat=fs.lstatSync(temporary,{bigint:true});fs.linkSync(temporary,file);syncDirectory(parent);fs.unlinkSync(temporary);syncDirectory(parent);const publishedStat=fs.lstatSync(file,{bigint:true});if(!publishedStat.isFile()||publishedStat.isSymbolicLink()||publishedStat.nlink!==1n||identity(publishedStat)!==identity(temporaryStat)||fs.readFileSync(file,'utf8')!==value)throw Error('resource ownership publication changed');}finally{try{fs.unlinkSync(temporary);syncDirectory(parent);}catch(error){if(error.code!=='ENOENT')throw error;}}}
function retiredRegistryFiles(location,kind){const pattern=new RegExp('^\\.retired-'+kind+'\\.'+location.id+'\\.[1-9][0-9]*\\.[a-f0-9]{32}$');return fs.readdirSync(registry).filter(name=>pattern.test(name)).map(name=>path.join(registry,name));}
function restoreRetiredRegistryFile(location,file,expectedIdentity,expectedBytes,kind){validatePlacement(location);const retired=retiredRegistryFiles(location,kind);if(retired.length>1||(retired.length===1&&fs.existsSync(file)))throw Error('resource '+kind+' changed');if(retired.length===0)return false;const retiredFile=retired[0],retiredStat=fs.lstatSync(retiredFile,{bigint:true});if(!retiredStat.isFile()||retiredStat.isSymbolicLink()||retiredStat.nlink!==1n||identity(retiredStat)!==expectedIdentity||fs.readFileSync(retiredFile,'utf8')!==expectedBytes)throw Error('resource '+kind+' changed');validatePlacement(location);fs.renameSync(retiredFile,file);validatePlacement(location);const restoredStat=fs.lstatSync(file,{bigint:true});if(identity(restoredStat)!==expectedIdentity||fs.readFileSync(file,'utf8')!==expectedBytes)throw Error('resource '+kind+' changed');return true;}
function retireExactFile(location,file,expectedIdentity,expectedBytes,kind){restoreRetiredRegistryFile(location,file,expectedIdentity,expectedBytes,kind);let sourceStat;try{sourceStat=fs.lstatSync(file,{bigint:true});}catch(error){if(error.code==='ENOENT')return false;throw error;}if(!sourceStat.isFile()||sourceStat.isSymbolicLink()||sourceStat.nlink!==1n||identity(sourceStat)!==expectedIdentity||fs.readFileSync(file,'utf8')!==expectedBytes)throw Error('resource '+kind+' changed');validatePlacement(location);const retired=path.join(registry,'.retired-'+kind+'.'+location.id+'.'+process.pid+'.'+crypto.randomBytes(16).toString('hex'));fs.renameSync(file,retired);try{validatePlacement(location);const retiredStat=fs.lstatSync(retired,{bigint:true});if(!retiredStat.isFile()||retiredStat.isSymbolicLink()||retiredStat.nlink!==1n||identity(retiredStat)!==expectedIdentity||fs.readFileSync(retired,'utf8')!==expectedBytes)throw Error('resource '+kind+' changed');fs.unlinkSync(retired);syncRegistry();validatePlacement(location);return true;}catch(error){try{if(!fs.existsSync(file))fs.renameSync(retired,file);}catch{}throw error;}}
function hasRetiredFile(location){const pattern=new RegExp('^\\.retired-(?:marker|stage|lease)\\.'+location.id+'\\.[1-9][0-9]*\\.[a-f0-9]{32}$');return fs.readdirSync(registry).some(name=>pattern.test(name));}
function restoreRetiredLease(location){validatePlacement(location);const retired=retiredRegistryFiles(location,'lease');if(retired.length>1||(retired.length===1&&fs.existsSync(location.registryFile)))throw Error('resource lease changed');if(retired.length===0)return;const file=retired[0],fileStat=fs.lstatSync(file,{bigint:true}),bytes=fs.readFileSync(file,'utf8'),lease=JSON.parse(bytes),cleanupReceipt=lease?.quarantined===true&&lease?.cleanupPrepared===true;for(const field of ['id','identity','attestation','root','workspace'])if(lease[field]!==location[field])throw Error('resource lease changed');if(!fileStat.isFile()||fileStat.isSymbolicLink()||fileStat.nlink!==1n||typeof lease.markerIdentity!=='string'||lease.markerIdentity.match(/^\d+:\d+$/)?.[0]!==lease.markerIdentity||typeof lease.markerNonce!=='string'||!/^[a-f0-9]{64}$/.test(lease.markerNonce)||typeof lease.stagedRootName!=='string'||!new RegExp('^'+stageRootPrefix+lease.id+'\\.[1-9][0-9]*\\.[a-f0-9]{32}$').test(lease.stagedRootName)||!Number.isSafeInteger(lease.expiresAt)||lease.expiresAt<0||typeof lease.cleanupPrepared!=='boolean'||(!cleanupReceipt&&(!Number.isSafeInteger(lease.creatorPid)||lease.creatorPid<=0||typeof lease.creatorIncarnation!=='string'||!/^[a-f0-9]{32}$/.test(lease.creatorIncarnation)||!Number.isSafeInteger(lease.commitDeadline)||lease.commitDeadline<0||typeof lease.committed!=='boolean')))throw Error('resource lease changed');restoreRetiredRegistryFile(location,location.registryFile,identity(fileStat),bytes,'lease');}
function processExists(pid){try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}}
function readLockOwner(location,lockStat){try{if(!lockStat.isFile()||lockStat.isSymbolicLink()||lockStat.nlink!==1n)return;const owner=JSON.parse(fs.readFileSync(location.registryFile+'.lock','utf8'));if(!owner||typeof owner!=='object'||Array.isArray(owner)||Object.keys(owner).sort().join(',')!=='attestation,expiresAt,id,identity,pid,processIncarnation')return;if(owner.id!==location.id||owner.identity!==location.identity||owner.attestation!==location.attestation||!Number.isSafeInteger(owner.pid)||owner.pid<=0||!Number.isSafeInteger(owner.expiresAt)||owner.expiresAt<0||typeof owner.processIncarnation!=='string'||!/^[a-f0-9]{32}$/.test(owner.processIncarnation))return;return owner;}catch{return;}}
function clearOwnerDeadLock(location){
 const lockFile=location.registryFile+'.lock';let lockStat;try{lockStat=fs.lstatSync(lockFile,{bigint:true});}catch(error){return error.code==='ENOENT';}
 const owner=readLockOwner(location,lockStat);if(!owner||(owner.expiresAt>Date.now()&&processExists(owner.pid)))return false;
 const retired=path.join(registry,'.retired-lock.'+location.id+'.'+process.pid+'.'+crypto.randomBytes(16).toString('hex'));
 try{fs.renameSync(lockFile,retired);}catch(error){return error.code==='ENOENT';}
 const retiredStat=fs.lstatSync(retired,{bigint:true});if(identity(retiredStat)!==identity(lockStat)){try{if(!fs.existsSync(lockFile))fs.renameSync(retired,lockFile);}catch{}return false;}
 fs.unlinkSync(retired);syncRegistry();return true;
}
function acquireLock(location){
 const lockFile=location.registryFile+'.lock',deadline=Date.now()+4000,waitArray=new Int32Array(new SharedArrayBuffer(4));
 do{
  validatePlacement(location);const nonce=crypto.randomBytes(16).toString('hex'),temporary=path.join(registry,'.'+location.id+'.'+process.pid+'.'+nonce+'.tmp');let linked=false;
  try{writePrivate(temporary,JSON.stringify({id:location.id,identity:location.identity,attestation:location.attestation,pid:process.pid,processIncarnation,expiresAt:Date.now()+leaseMs}));const temporaryStat=fs.lstatSync(temporary,{bigint:true});try{fs.linkSync(temporary,lockFile);linked=true;}catch(error){if(error.code!=='EEXIST')throw error;}if(linked){const lockStat=fs.lstatSync(lockFile,{bigint:true});if(identity(lockStat)!==identity(temporaryStat))throw Error('resource ownership lock changed');fs.unlinkSync(temporary);syncRegistry();return identity(lockStat);}}
  finally{try{fs.unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}}
  if(clearOwnerDeadLock(location))continue;
  Atomics.wait(waitArray,0,0,Math.min(25,Math.max(0,deadline-Date.now())));
 }while(Date.now()<deadline);
 throw Error('resource ownership is busy');
}
function releaseLock(location,lockIdentity){const lockFile=location.registryFile+'.lock';try{const lockStat=fs.lstatSync(lockFile,{bigint:true});if(identity(lockStat)!==lockIdentity)throw Error('resource ownership lock changed');validatePlacement(location);const retired=path.join(registry,'.retired-lock.'+location.id+'.'+process.pid+'.'+crypto.randomBytes(16).toString('hex'));fs.renameSync(lockFile,retired);validatePlacement(location);const retiredStat=fs.lstatSync(retired,{bigint:true});if(identity(retiredStat)!==lockIdentity){try{if(!fs.existsSync(lockFile))fs.renameSync(retired,lockFile);}catch{}throw Error('resource ownership lock changed');}fs.unlinkSync(retired);syncRegistry();validatePlacement(location);}catch(error){if(error.code!=='ENOENT')throw error;}try{const registryStat=fs.lstatSync(registry,{bigint:true});if(identity(registryStat)!==location.registryIdentity)throw Error('resource registry changed');fs.rmdirSync(registry);syncDirectory(workspace);}catch(error){if(error.code!=='ENOENT'&&error.code!=='ENOTEMPTY'&&error.code!=='EEXIST')throw error;}}
function replaceLease(location,prior,next){
 const temporary=path.join(registry,'.'+location.id+'.'+process.pid+'.'+crypto.randomBytes(16).toString('hex')+'.tmp');
 const bytes=JSON.stringify(next);try{writePrivate(temporary,bytes);validatePlacement(location);const current=fs.lstatSync(location.registryFile,{bigint:true});if(identity(current)!==prior._fileIdentity||fs.readFileSync(location.registryFile,'utf8')!==prior._fileBytes)throw Error('resource lease changed');fs.renameSync(temporary,location.registryFile);syncRegistry();validatePlacement(location);const replaced=fs.lstatSync(location.registryFile,{bigint:true});if(!replaced.isFile()||replaced.isSymbolicLink()||replaced.nlink!==1n||fs.readFileSync(location.registryFile,'utf8')!==bytes)throw Error('resource lease changed');}finally{try{fs.unlinkSync(temporary)}catch(error){if(error.code!=='ENOENT')throw error;}}
}
function writeLease(location,expiresAt){const prior=readLease(location);if(prior.cleanupPrepared)throw Error('resource cleanup already prepared');replaceLease(location,prior,{...prior,expiresAt,...(!prior.committed?{commitDeadline:expiresAt}:{})});}
function validateRetiredRoot(location,lease,retired){const retiredStat=fs.lstatSync(retired,{bigint:true});if(!retiredStat.isDirectory()||retiredStat.isSymbolicLink()||identity(retiredStat)!==location.identity)throw Error('resource directory changed');const rootMarker=path.join(retired,rootMarkerName);try{fs.lstatSync(rootMarker,{bigint:true});validateMarkerAt(location,lease,retired);}catch(error){if(error.code!=='ENOENT')throw error;if(fs.readdirSync(retired).length!==0)throw Error('resource ownership marker changed');validateRegistryMarker(location,lease,1n);}return retiredStat;}
function removeRetiredRoot(location,lease,retired){validateRetiredRoot(location,lease,retired);const rootMarker=path.join(retired,rootMarkerName);let markerPresent=true;try{fs.lstatSync(rootMarker,{bigint:true});}catch(error){if(error.code==='ENOENT')markerPresent=false;else throw error;}if(markerPresent){for(const name of fs.readdirSync(retired)){if(name===rootMarkerName)continue;validatePlacement(location);validateMarkerAt(location,lease,retired);fs.rmSync(path.join(retired,name),{recursive:true,force:true});}validatePlacement(location);validateMarkerAt(location,lease,retired);if(fs.readdirSync(retired).some(name=>name!==rootMarkerName))throw Error('resource cleanup incomplete');fs.unlinkSync(rootMarker);syncDirectory(retired);}validatePlacement(location);validateRetiredRoot(location,lease,retired);if(fs.readdirSync(retired).length!==0)throw Error('resource cleanup incomplete');fs.rmdirSync(retired);syncRegistry();validatePlacement(location);try{fs.lstatSync(retired);throw Error('resource cleanup incomplete');}catch(error){if(error.code!=='ENOENT')throw error;}}
function retireRoot(location,lease=readLease(location)){
 let rootStat;try{rootStat=fs.lstatSync(location.root,{bigint:true});}catch(error){if(error.code==='ENOENT')return false;throw error;}
 if(!rootStat.isDirectory()||rootStat.isSymbolicLink()||identity(rootStat)!==location.identity)throw Error('resource directory changed');validateMarkerAt(location,lease,location.root);
 validatePlacement(location);const retired=path.join(registry,'.retired-root.'+location.id+'.'+process.pid+'.'+crypto.randomBytes(16).toString('hex'));
 fs.renameSync(location.root,retired);try{syncDirectory(workspace);syncRegistry();validatePlacement(location);const retiredStat=fs.lstatSync(retired,{bigint:true});if(!retiredStat.isDirectory()||retiredStat.isSymbolicLink()||identity(retiredStat)!==location.identity)throw Error('resource directory changed');validateMarkerAt(location,lease,retired);}catch(error){try{const retiredStat=fs.lstatSync(retired,{bigint:true});if(!fs.existsSync(location.root))fs.renameSync(retired,location.root);}catch{}throw error;}
 removeRetiredRoot(location,lease,retired);return true;
}
function recoverRetiredRoots(location,lease=readLease(location)){validatePlacement(location);for(const name of fs.readdirSync(registry)){if(!new RegExp('^\\.retired-root\\.'+location.id+'\\.[1-9][0-9]*\\.[a-f0-9]{32}$').test(name))continue;const retired=path.join(registry,name);validateRetiredRoot(location,lease,retired);validatePlacement(location);const recovery=path.join(registry,'.retired-root.'+location.id+'.'+process.pid+'.'+crypto.randomBytes(16).toString('hex'));fs.renameSync(retired,recovery);try{validatePlacement(location);validateRetiredRoot(location,lease,recovery);}catch(error){try{if(!fs.existsSync(retired))fs.renameSync(recovery,retired);}catch{}throw error;}removeRetiredRoot(location,lease,recovery);}}
function recoverStagedRoot(location,lease=readLease(location)){const staged=path.join(registry,lease.stagedRootName);let stagedStat;try{stagedStat=fs.lstatSync(staged,{bigint:true});}catch(error){if(error.code==='ENOENT')return;throw error;}if(fs.existsSync(location.root))throw Error('resource directory changed');if(!stagedStat.isDirectory()||stagedStat.isSymbolicLink()||identity(stagedStat)!==location.identity)throw Error('resource directory changed');validateMarkerAt(location,lease,staged);validatePlacement(location);const retired=path.join(registry,'.retired-root.'+location.id+'.'+process.pid+'.'+crypto.randomBytes(16).toString('hex'));fs.renameSync(staged,retired);try{syncRegistry();validatePlacement(location);validateRetiredRoot(location,lease,retired);}catch(error){try{if(!fs.existsSync(staged))fs.renameSync(retired,staged);}catch{}throw error;}removeRetiredRoot(location,lease,retired);}
function hasRetiredRoot(location){const pattern=new RegExp('^\\.retired-root\\.'+location.id+'\\.[1-9][0-9]*\\.[a-f0-9]{32}$');return fs.readdirSync(registry).some(name=>pattern.test(name));}
function hasStagedRoot(location){const pattern=new RegExp('^'+stageRootPrefix+location.id+'\\.[1-9][0-9]*\\.[a-f0-9]{32}$');return fs.readdirSync(registry).some(name=>pattern.test(name));}
function renew(location){const lockIdentity=acquireLock(location);try{validatePlacement(location);const lease=readLease(location);if(lease.cleanupPrepared)throw Error('resource cleanup already prepared');if(lease.expiresAt<=Date.now())throw Error('resource lease expired');validateMarkerAt(location,lease,location.root);enter(location.root,location.identity);writeLease(location,Date.now()+leaseMs);}finally{releaseLock(location,lockIdentity);}}
function commit(location){const lockIdentity=acquireLock(location);try{validatePlacement(location);const lease=readLease(location);if(lease.cleanupPrepared)throw Error('resource cleanup already prepared');if(lease.expiresAt<=Date.now())throw Error('resource lease expired');validateMarkerAt(location,lease,location.root);enter(location.root,location.identity);replaceLease(location,lease,{...lease,expiresAt:Date.now()+leaseMs,committed:true});const claimed=path.join(workspace,permitPrefix+location.id+'.claimed');try{fs.unlinkSync(claimed);syncDirectory(workspace);}catch(error){if(error.code!=='ENOENT')throw error;}}finally{releaseLock(location,lockIdentity);}}
function cleanupLocked(location){restoreRetiredLease(location);let lease;try{lease=readLease(location);}catch(error){if(error.code!=='ENOENT')throw error;const claimed=path.join(workspace,permitPrefix+location.id+'.claimed'),stageClaim=path.join(registry,stageClaimName+'.'+location.id);for(const target of [location.root,location.registryMarker,claimed,stageClaim])try{fs.lstatSync(target);throw Error('resource cleanup incomplete');}catch(absenceError){if(absenceError.code!=='ENOENT')throw absenceError;}if(hasRetiredRoot(location)||hasStagedRoot(location)||hasRetiredFile(location))throw Error('resource cleanup incomplete');return;}const workspaceStat=fs.lstatSync(location.workspace,{bigint:true});if(!workspaceStat.isDirectory()||workspaceStat.isSymbolicLink())throw Error('resource workspace changed');process.chdir(location.workspace);if(identity(fs.statSync('.',{bigint:true}))!==identity(workspaceStat))throw Error('resource workspace changed');recoverRetiredRoots(location,lease);recoverStagedRoot(location,lease);retireRoot(location,lease);if(fs.existsSync(location.root))throw Error('resource directory changed');retireExactFile(location,location.registryMarker,lease.markerIdentity,markerValue(lease),'marker');const claimed=path.join(workspace,permitPrefix+location.id+'.claimed');restoreRetiredPermit(claimed,location,{pid:lease.creatorPid,processIncarnation:lease.creatorIncarnation});const claimedOwner=readPermitOwner(claimed,location);if(claimedOwner&&(claimedOwner.owner.pid!==lease.creatorPid||claimedOwner.owner.processIncarnation!==lease.creatorIncarnation))throw Error('resource permit changed');retirePermit(claimed,location,claimedOwner);const stageClaim=path.join(registry,stageClaimName+'.'+location.id),stage=readStageClaim(registry,location);if(stage&&(stage.claim.markerNonce!==lease.markerNonce||stage.claim.stagedRootName!==lease.stagedRootName))throw Error('resource stage claim changed');if(stage)retireExactFile(location,stage.file,identity(stage.fileStat),stage.bytes,'stage');for(const target of [location.root,location.registryMarker,claimed,stageClaim,path.join(registry,lease.stagedRootName)])try{fs.lstatSync(target);throw Error('resource cleanup incomplete');}catch(error){if(error.code!=='ENOENT')throw error;}if(hasRetiredRoot(location)||hasStagedRoot(location)||hasRetiredFile(location))throw Error('resource cleanup incomplete');for(const target of [location.root,location.registryMarker,claimed,stageClaim])try{fs.lstatSync(target);throw Error('resource cleanup incomplete');}catch(error){if(error.code!=='ENOENT')throw error;}if(hasRetiredRoot(location)||hasStagedRoot(location)||hasRetiredFile(location))throw Error('resource cleanup incomplete');if(!lease.cleanupPrepared)replaceLease(location,lease,{...lease,cleanupPrepared:true});}
function cleanup(location){const lockIdentity=acquireLock(location);try{validatePlacement(location);cleanupLocked(location);}finally{releaseLock(location,lockIdentity);}}
function retiredRegistryDirectories(location){const identityHash=crypto.createHash('sha256').update(location.registryIdentity).digest('hex'),pattern=new RegExp('^\\.retired-registry\\.'+location.id+'\\.'+identityHash+'\\.[a-f0-9]{32}$');return fs.readdirSync(workspace).filter(name=>pattern.test(name)).map(name=>path.join(workspace,name));}
function validateRetiredRegistry(location,retired){const workspaceStat=fs.lstatSync(workspace,{bigint:true}),retiredStat=fs.lstatSync(retired,{bigint:true});if(!workspaceStat.isDirectory()||workspaceStat.isSymbolicLink()||identity(workspaceStat)!==location.workspaceIdentity||!retiredStat.isDirectory()||retiredStat.isSymbolicLink()||identity(retiredStat)!==location.registryIdentity)throw Error('resource registry changed');return retiredStat;}
function finishRetiredRegistry(location,retired){validateRetiredRegistry(location,retired);const leaseFile=path.join(retired,path.basename(location.registryFile)),lockFile=leaseFile+'.lock',allowed=new Set([path.basename(leaseFile),path.basename(lockFile)]);for(const name of fs.readdirSync(retired))if(!allowed.has(name))throw Error('resource registry changed');let lease;try{lease=readLeaseAt(location,leaseFile);if(!lease.cleanupPrepared)throw Error('resource cleanup is not prepared');}catch(error){if(error.code!=='ENOENT')throw error;}for(const file of [lockFile,leaseFile]){let stat;try{stat=fs.lstatSync(file,{bigint:true});}catch(error){if(error.code==='ENOENT')continue;throw error;}if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1n)throw Error('resource registry changed');validateRetiredRegistry(location,retired);fs.unlinkSync(file);syncDirectory(retired);validateRetiredRegistry(location,retired);}validateRetiredRegistry(location,retired);if(fs.readdirSync(retired).length!==0)throw Error('resource registry changed');fs.rmdirSync(retired);syncDirectory(workspace);try{fs.lstatSync(retired);throw Error('resource cleanup incomplete');}catch(error){if(error.code!=='ENOENT')throw error;}}
function finalizeCleanup(location){const retired=retiredRegistryDirectories(location);let liveStat;try{liveStat=fs.lstatSync(location.registry,{bigint:true});}catch(error){if(error.code!=='ENOENT')throw error;}if(retired.length>1||(retired.length===1&&liveStat))throw Error('resource registry changed');if(retired.length===1){validateRetiredRegistry(location,retired[0]);finishRetiredRegistry(location,retired[0]);return;}if(!liveStat){const workspaceStat=fs.lstatSync(workspace,{bigint:true});if(!workspaceStat.isDirectory()||workspaceStat.isSymbolicLink()||identity(workspaceStat)!==location.workspaceIdentity)throw Error('resource workspace changed');for(const target of [location.root,path.join(workspace,permitPrefix+location.id),path.join(workspace,permitPrefix+location.id+'.claimed')])try{fs.lstatSync(target);throw Error('resource cleanup incomplete');}catch(error){if(error.code!=='ENOENT')throw error;}return;}validatePlacement(location);const lockIdentity=acquireLock(location);let moved=false;try{validatePlacement(location);const lease=readLease(location);if(!lease.cleanupPrepared)throw Error('resource cleanup is not prepared');const claimed=path.join(workspace,permitPrefix+location.id+'.claimed'),stageClaim=path.join(location.registry,stageClaimName+'.'+location.id);for(const target of [location.root,location.registryMarker,claimed,stageClaim,path.join(location.registry,lease.stagedRootName)])try{fs.lstatSync(target);throw Error('resource cleanup incomplete');}catch(error){if(error.code!=='ENOENT')throw error;}if(hasRetiredRoot(location)||hasStagedRoot(location)||hasRetiredFile(location))throw Error('resource cleanup incomplete');const entries=fs.readdirSync(location.registry),allowed=new Set([path.basename(location.registryFile),path.basename(location.registryFile)+'.lock']);for(const name of entries)if(!allowed.has(name))throw Error('resource registry changed');const identityHash=crypto.createHash('sha256').update(location.registryIdentity).digest('hex'),target=path.join(workspace,'.retired-registry.'+location.id+'.'+identityHash+'.'+crypto.randomBytes(16).toString('hex'));validatePlacement(location);fs.renameSync(location.registry,target);moved=true;syncDirectory(workspace);validateRetiredRegistry(location,target);try{fs.lstatSync(location.registry);throw Error('resource registry changed');}catch(error){if(error.code!=='ENOENT')throw error;}finishRetiredRegistry(location,target);}finally{if(!moved)releaseLock(location,lockIdentity);}}
function processExists(pid){try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}}
function sweepTemporaries(location){
 validatePlacement(location);const registryStat=fs.lstatSync(registry,{bigint:true}),now=Date.now();
 for(const name of fs.readdirSync(registry)){
  const temporary=/^\.[a-f0-9]{32}\.([1-9][0-9]*)\.[a-f0-9]{32}\.tmp$/.exec(name);if(!temporary)continue;
  const temporaryPath=path.join(registry,name);let temporaryStat;try{temporaryStat=fs.lstatSync(temporaryPath,{bigint:true});}catch(error){if(error.code==='ENOENT')continue;throw error;}
  if(!temporaryStat.isFile()||temporaryStat.isSymbolicLink()||temporaryStat.nlink!==1n||temporaryStat.uid!==registryStat.uid||(temporaryStat.mode&0o777n)!==0o600n)continue;
  if(Number(temporaryStat.mtimeMs)+leaseMs>now)continue;
  try{fs.unlinkSync(temporaryPath);}catch(error){if(error.code!=='ENOENT')throw error;}
 }
}
function readPermitOwner(file,request){let fileStat;try{fileStat=fs.lstatSync(file,{bigint:true});}catch(error){if(error.code==='ENOENT')return;throw error;}if(!fileStat.isFile()||fileStat.isSymbolicLink()||fileStat.nlink!==1n)throw Error('resource permit changed');const bytes=fs.readFileSync(file,'utf8'),owner=JSON.parse(bytes);if(!owner||typeof owner!=='object'||Array.isArray(owner)||Object.keys(owner).sort().join(',')!=='attestation,expiresAt,id,pid,processIncarnation'||owner.id!==request.id||owner.attestation!==request.attestation||!Number.isSafeInteger(owner.pid)||owner.pid<=0||typeof owner.processIncarnation!=='string'||!/^[a-f0-9]{32}$/.test(owner.processIncarnation)||!Number.isSafeInteger(owner.expiresAt)||owner.expiresAt<0)throw Error('resource permit changed');return {bytes,fileStat,owner};}
function retiredPermitFiles(file,request){const kind=file.endsWith('.claimed')?'claimed-permit':'permit',pattern=new RegExp('^\\.retired-'+kind+'\\.'+request.id+'\\.[a-f0-9]{32}$');return fs.readdirSync(workspace).filter(name=>pattern.test(name)).map(name=>path.join(workspace,name));}
function restoreRetiredPermit(file,request,expectedOwner){const retired=retiredPermitFiles(file,request);if(retired.length>1||(retired.length===1&&fs.existsSync(file)))throw Error('resource permit changed');if(retired.length===0)return false;const current=readPermitOwner(retired[0],request);if(!current||(expectedOwner&&(current.owner.pid!==expectedOwner.pid||current.owner.processIncarnation!==expectedOwner.processIncarnation)))throw Error('resource permit changed');const workspaceStat=fs.lstatSync(workspace,{bigint:true});fs.renameSync(retired[0],file);const currentWorkspaceStat=fs.lstatSync(workspace,{bigint:true}),restoredStat=fs.lstatSync(file,{bigint:true});if(identity(currentWorkspaceStat)!==identity(workspaceStat)||identity(restoredStat)!==identity(current.fileStat)||fs.readFileSync(file,'utf8')!==current.bytes)throw Error('resource permit changed');return true;}
function retirePermit(file,request,current){if(!current)return false;if(current.owner.expiresAt>Date.now()&&processExists(current.owner.pid))throw Error('resource allocation permit is still active');const sourceStat=fs.lstatSync(file,{bigint:true});if(identity(sourceStat)!==identity(current.fileStat)||fs.readFileSync(file,'utf8')!==current.bytes)throw Error('resource permit changed');const workspaceStat=fs.lstatSync(workspace,{bigint:true});if(!workspaceStat.isDirectory()||workspaceStat.isSymbolicLink())throw Error('resource workspace changed');const kind=file.endsWith('.claimed')?'claimed-permit':'permit',retired=path.join(workspace,'.retired-'+kind+'.'+request.id+'.'+crypto.randomBytes(16).toString('hex'));fs.renameSync(file,retired);try{const currentWorkspaceStat=fs.lstatSync(workspace,{bigint:true}),retiredStat=fs.lstatSync(retired,{bigint:true});if(identity(currentWorkspaceStat)!==identity(workspaceStat)||identity(retiredStat)!==identity(current.fileStat)||fs.readFileSync(retired,'utf8')!==current.bytes)throw Error('resource permit changed');fs.unlinkSync(retired);syncDirectory(workspace);return true;}catch(error){try{if(!fs.existsSync(file))fs.renameSync(retired,file);}catch{}throw error;}}
function readStageClaim(registryPath,request){const file=path.join(registryPath,stageClaimName+'.'+request.id);discardPrivatePublicationTemps(file);let fileStat;try{fileStat=fs.lstatSync(file,{bigint:true});}catch(error){if(error.code==='ENOENT')return;throw error;}if(!fileStat.isFile()||fileStat.isSymbolicLink()||fileStat.nlink!==1n)throw Error('resource stage claim changed');const bytes=fs.readFileSync(file,'utf8'),claim=JSON.parse(bytes);if(!claim||typeof claim!=='object'||Array.isArray(claim)||Object.keys(claim).sort().join(',')!=='attestation,id,markerNonce,stagedRootName'||claim.id!==request.id||claim.attestation!==request.attestation||typeof claim.markerNonce!=='string'||!/^[a-f0-9]{64}$/.test(claim.markerNonce)||typeof claim.stagedRootName!=='string'||!new RegExp('^'+stageRootPrefix+request.id+'\\.[1-9][0-9]*\\.[a-f0-9]{32}$').test(claim.stagedRootName))throw Error('resource stage claim changed');return {bytes,claim,file,fileStat};}
function cleanupClaimedStage(location,request,stage){const staged=path.join(location.registry,stage.claim.stagedRootName);let stagedStat;try{stagedStat=fs.lstatSync(staged,{bigint:true});}catch(error){if(error.code!=='ENOENT')throw error;}if(stagedStat){if(!stagedStat.isDirectory()||stagedStat.isSymbolicLink())throw Error('resource directory changed');const stagedIdentity=identity(stagedStat),markerPath=path.join(staged,rootMarkerName);discardPrivatePublicationTemps(markerPath);let markerStat;try{markerStat=fs.lstatSync(markerPath,{bigint:true});}catch(error){if(error.code!=='ENOENT')throw error;}if(markerStat){const markerBytes=fs.readFileSync(markerPath,'utf8'),marker=JSON.parse(markerBytes),expectedMarker=JSON.stringify({attestation:request.attestation,id:request.id,markerNonce:stage.claim.markerNonce,rootIdentity:stagedIdentity,stagedRootName:stage.claim.stagedRootName});if(!markerStat.isFile()||markerStat.isSymbolicLink()||markerStat.nlink!==1n||!marker||typeof marker!=='object'||Array.isArray(marker)||Object.keys(marker).sort().join(',')!=='attestation,id,markerNonce,rootIdentity,stagedRootName'||marker.id!==request.id||marker.attestation!==request.attestation||marker.markerNonce!==stage.claim.markerNonce||marker.rootIdentity!==stagedIdentity||marker.stagedRootName!==stage.claim.stagedRootName||markerBytes!==expectedMarker)throw Error('resource ownership marker changed');validatePlacement(location);fs.linkSync(markerPath,location.registryMarker);syncRegistry();const linkedMarker=fs.lstatSync(markerPath,{bigint:true}),registryMarker=fs.lstatSync(location.registryMarker,{bigint:true});if(linkedMarker.nlink!==2n||registryMarker.nlink!==2n||identity(linkedMarker)!==identity(markerStat)||identity(registryMarker)!==identity(markerStat)||fs.readFileSync(location.registryMarker,'utf8')!==markerBytes)throw Error('resource ownership marker changed');const ownedLocation={...location,identity:stagedIdentity},lease={...ownedLocation,markerIdentity:identity(markerStat),markerNonce:stage.claim.markerNonce,stagedRootName:stage.claim.stagedRootName};const retired=path.join(location.registry,'.retired-root.'+request.id+'.'+process.pid+'.'+crypto.randomBytes(16).toString('hex'));fs.renameSync(staged,retired);syncRegistry();validatePlacement(location);validateRetiredRoot(ownedLocation,lease,retired);removeRetiredRoot(ownedLocation,lease,retired);retireExactFile(location,location.registryMarker,lease.markerIdentity,markerBytes,'marker');}else{if(fs.readdirSync(staged).length!==0)throw Error('resource directory changed');validatePlacement(location);fs.rmdirSync(staged);syncRegistry();validatePlacement(location);}}retireExactFile(location,stage.file,identity(stage.fileStat),stage.bytes,'stage');}
function cleanupIntent(request){
 const registryPath=path.join(workspace,registryPrefix+request.id),root=path.join(registryPath,resourceDirectory(request.id)),permit=path.join(workspace,permitPrefix+request.id),claimed=permit+'.claimed';
 discardPrivatePublicationTemps(permit);
 restoreRetiredPermit(permit,request);restoreRetiredPermit(claimed,request);const permitOwner=readPermitOwner(permit,request),claimedOwner=readPermitOwner(claimed,request);
 for(const current of [permitOwner,claimedOwner])if(current&&current.owner.expiresAt>Date.now()&&processExists(current.owner.pid))throw Error('resource allocation permit is still active');
 retirePermit(claimed,request,claimedOwner);retirePermit(permit,request,permitOwner);
 let registryStat;try{registryStat=fs.lstatSync(registryPath,{bigint:true});}catch(error){if(error.code!=='ENOENT')throw error;}
 if(registryStat){
  if(!registryStat.isDirectory()||registryStat.isSymbolicLink())throw Error('resource registry changed');registry=registryPath;
  const recordPattern=new RegExp('^'+request.id+'\\.([0-9]+)\\.([0-9]+)\\.json$'),records=fs.readdirSync(registryPath).map(name=>({name,match:recordPattern.exec(name)})).filter(entry=>entry.match);
  if(records.length>1)throw Error('resource registry changed');
  if(records.length===1){const entry=records[0],rootIdentity=entry.match[1]+':'+entry.match[2],location={id:request.id,identity:rootIdentity,attestation:request.attestation,root,workspace,workspaceIdentity:identity(fs.lstatSync(workspace,{bigint:true})),registryIdentity:identity(registryStat),registry:registryPath,registryFile:path.join(registryPath,entry.name),registryMarker:path.join(registryPath,'.owner.'+request.id)};validatePlacement(location);cleanup(location);finalizeCleanup(location);}
  else {
   const registryMarker=path.join(registryPath,'.owner.'+request.id);let markerStat;try{markerStat=fs.lstatSync(registryMarker,{bigint:true});}catch(error){if(error.code!=='ENOENT')throw error;}
   if(markerStat){if(!markerStat.isFile()||markerStat.isSymbolicLink())throw Error('resource ownership marker changed');const markerBytes=fs.readFileSync(registryMarker,'utf8'),marker=JSON.parse(markerBytes);if(!marker||typeof marker!=='object'||Array.isArray(marker)||Object.keys(marker).sort().join(',')!=='attestation,id,markerNonce,rootIdentity,stagedRootName'||marker.id!==request.id||marker.attestation!==request.attestation||typeof marker.markerNonce!=='string'||!/^[a-f0-9]{64}$/.test(marker.markerNonce)||typeof marker.rootIdentity!=='string'||marker.rootIdentity.match(/^\d+:\d+$/)?.[0]!==marker.rootIdentity||typeof marker.stagedRootName!=='string'||!new RegExp('^'+stageRootPrefix+request.id+'\\.[1-9][0-9]*\\.[a-f0-9]{32}$').test(marker.stagedRootName))throw Error('resource ownership marker changed');const location={id:request.id,identity:marker.rootIdentity,attestation:request.attestation,root,workspace,workspaceIdentity:identity(fs.lstatSync(workspace,{bigint:true})),registryIdentity:identity(registryStat),registry:registryPath,registryFile:path.join(registryPath,request.id+'.'+marker.rootIdentity.replace(':','.')+'.json'),registryMarker};const lease={...location,markerIdentity:identity(markerStat),markerNonce:marker.markerNonce,stagedRootName:marker.stagedRootName};const stage=readStageClaim(registryPath,request);if(stage&&(stage.claim.markerNonce!==marker.markerNonce||stage.claim.stagedRootName!==marker.stagedRootName))throw Error('resource stage claim changed');const lockIdentity=acquireLock(location);try{validatePlacement(location);recoverRetiredRoots(location,lease);recoverStagedRoot(location,lease);retireRoot(location,lease);if(fs.existsSync(root))throw Error('resource directory changed');retireExactFile(location,registryMarker,lease.markerIdentity,markerBytes,'marker');if(stage)retireExactFile(location,stage.file,identity(stage.fileStat),stage.bytes,'stage');for(const target of [root,registryMarker,stage?.file,path.join(registryPath,marker.stagedRootName)])if(target)try{fs.lstatSync(target);throw Error('resource allocation cleanup incomplete');}catch(error){if(error.code!=='ENOENT')throw error;}if(hasRetiredRoot(location)||hasStagedRoot(location))throw Error('resource allocation cleanup incomplete');}finally{releaseLock(location,lockIdentity);}}
   else {const stage=readStageClaim(registryPath,request),intentLocation={id:request.id,identity:'0:0',attestation:request.attestation,root,workspace,workspaceIdentity:identity(fs.lstatSync(workspace,{bigint:true})),registryIdentity:identity(registryStat),registry:registryPath,registryFile:path.join(registryPath,request.id+'.0.0.json'),registryMarker};if(stage){if(fs.existsSync(root))throw Error('resource directory changed');cleanupClaimedStage(intentLocation,request,stage);}else if(fs.existsSync(root))throw Error('resource directory changed');try{validatePlacement(intentLocation);fs.rmdirSync(registryPath);syncDirectory(workspace);}catch(error){if(error.code!=='ENOENT')throw error;}}
  }
 }
 else if(fs.existsSync(root))throw Error('resource directory changed');
 for(const target of [root,registryPath,claimed,permit])try{fs.lstatSync(target);throw Error('resource allocation cleanup incomplete');}catch(error){if(error.code!=='ENOENT')throw error;}
}
(async()=>{try {
 const input=fs.readFileSync(0);if(input.length>${NODE_WORKER_WORKSPACE_STDIN_MAX_BYTES})throw Error('resource request exceeds input limit');
 const request=JSON.parse(input.toString('utf8')),op=request?.op;
 const locationKeys=['attestation','id','identity','workspace','workspaceIdentity','registryIdentity'];
 const keys=op==='init'?['op','attestation','id','workspace']:op==='cleanup-intent'?['op','attestation','id','workspace']:op==='cleanup'||op==='cleanup-finalize'||op==='renew'||op==='commit'?['op',...locationKeys]:op==='write'?['op',...locationKeys,'name','offset','size','hash','executable','data']:[];
 if(!request||typeof request!=='object'||Array.isArray(request)||!keys.length||Object.keys(request).length!==keys.length||keys.some(key=>!Object.hasOwn(request,key)))throw Error('invalid resource operation');
 if(typeof request.workspace!=='string'||request.workspace!==workspace)throw Error('resource workspace changed');
 if(op==='cleanup-intent'){
  if(typeof request.id!=='string'||!/^[a-f0-9]{32}$/.test(request.id)||typeof request.attestation!=='string'||!/^[a-f0-9]{64}$/.test(request.attestation))throw Error('invalid resource intent');cleanupIntent(request);
 }
 else if(op==='init'){
  if(typeof request.id!=='string'||!/^[a-f0-9]{32}$/.test(request.id)||typeof request.attestation!=='string'||!/^[a-f0-9]{64}$/.test(request.attestation))throw Error('invalid resource initialization');
  const id=request.id,workspaceIdentity=identity(fs.lstatSync(workspace,{bigint:true})),permit=path.join(workspace,permitPrefix+id),creatorIncarnation=crypto.randomBytes(16).toString('hex');
  const child=spawn(process.execPath,['-e',reaperScript,'initialize',workspace,String(sweepMs),String(leaseMs),workspaceIdentity,id,request.attestation,creatorIncarnation],{detached:true,stdio:['pipe','pipe','ignore'],windowsHide:true});if(!child.pid||!child.stdin||!child.stdout)throw Error('resource reaper failed to start');child.unref();
  let ready;try{publishPrivate(permit,JSON.stringify({id,pid:child.pid,attestation:request.attestation,processIncarnation:creatorIncarnation,expiresAt:Date.now()+leaseMs}));child.stdin.write('permit');ready=await new Promise((resolve,reject)=>{let output='';const timeout=setTimeout(()=>reject(Error('resource reaper did not acknowledge allocation')),5000);timeout.unref?.();child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{output+=chunk;if(Buffer.byteLength(output)>1024)reject(Error('resource readiness output exceeded limit'));});child.stdout.once('error',reject);child.stdout.once('end',()=>{clearTimeout(timeout);try{resolve(JSON.parse(output));}catch(error){reject(error);}});child.once('error',reject);});}finally{child.stdin.end();}
  process.stdout.write(JSON.stringify(ready));
 }
 else {
  const allocationAbsent=op==='cleanup'&&(()=>{const registryPath=path.join(workspace,registryPrefix+request.id),root=path.join(registryPath,resourceDirectory(request.id));try{fs.lstatSync(root);return false;}catch(error){if(error.code!=='ENOENT')throw error;}try{fs.lstatSync(registryPath);return false;}catch(error){if(error.code!=='ENOENT')throw error;}return true;})();
  if(allocationAbsent){}
  else {const location=op==='cleanup-finalize'?buildLocation(request):validateLocation(request);
  if(op==='cleanup-finalize'){finalizeCleanup(location);}
  else {
  sweepTemporaries(location);
  if(op==='cleanup'){cleanup(location);}
  else if(op==='commit'){commit(location);}
  else if(op==='renew'){renew(location);}
  else {
   renew(location);
   const {name,offset,size,hash,executable,data}=request;
   if(typeof name!=='string'||typeof data!=='string'||typeof executable!=='boolean'||typeof hash!=='string'||hash.length!==64||!/^[a-f0-9]{64}$/.test(hash))throw Error('invalid resource chunk');
   // Bundle components cannot select Windows streams, drive-relative paths, aliases or devices.
   const reserved=new RegExp(${JSON.stringify(SKILL_WINDOWS_RESERVED_BASENAME_PATTERN)},'iu');
   const parts=name.split('/');if(parts.some(p=>!p||p==='.'||p==='..'||/[\\:\x00]/.test(p)||/[ .]$/.test(p)||reserved.test(p))||parts.length>${SKILL_LIBRARY_MAX_PATH_COMPONENTS + 1})throw Error('invalid resource path');
   enter(location.root,location.identity);
   for(const part of parts.slice(0,-1)){try{fs.mkdirSync(part,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}enter(part);}
   const bytes=Buffer.from(data,'base64');
   if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(size)||offset<0||size<0||size>1048576||offset+bytes.length>size||bytes.toString('base64')!==data)throw Error('invalid resource chunk');
   const fd=fs.openSync(parts.at(-1),fs.constants.O_RDWR|(fs.constants.O_NOFOLLOW||0)|(offset===0?fs.constants.O_CREAT|fs.constants.O_EXCL:0),0o600);
   try{const s=fs.fstatSync(fd);if(!s.isFile()||s.nlink!==1||s.size!==offset)throw Error('resource file changed');let n=0;while(n<bytes.length){const written=fs.writeSync(fd,bytes,n,bytes.length-n,offset+n);if(!written)throw Error('resource write stalled');n+=written;}
    if(offset+bytes.length===size){if(crypto.createHash('sha256').update(fs.readFileSync(fd)).digest('hex')!==hash)throw Error('resource digest mismatch');fs.fchmodSync(fd,executable?0o500:0o400);fs.fsyncSync(fd);}
   }finally{fs.closeSync(fd);}
  }}
  }
 }
}catch(e){process.stderr.write(String(e.message));process.exitCode=1;}})();
`;

const compressedSkillResourceRuntime = deflateRawSync(SKILL_RESOURCE_RUNTIME_SOURCE).toString(
  "base64",
);
export const SKILL_RESOURCE_RUNTIME_SCRIPT = `const z=require('node:zlib');(0,eval)(z.inflateRawSync(Buffer.from(${JSON.stringify(compressedSkillResourceRuntime)},'base64')).toString())`;

/** Transfers the prepared catalog through either SSH or node transport into private placement storage. */
export async function transferSkillResources(params: {
  snapshot?: SkillSnapshot;
  remoteWorkspaceDir: string;
  tunnel: Pick<WorkerWorkspaceTunnelHandle, "runWorkspaceCommand">;
  assertCurrent: () => void;
  allocationOwner?: {
    coordinator: SkillResourceAllocationCoordinator;
    environmentId: string;
    ownerEpoch: number;
  };
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
  if (!params.allocationOwner) {
    throw new Error("Skill resource allocation owner is unavailable.");
  }
  const allocationOwner = params.allocationOwner;
  const assertAllocationCurrent = () => {
    check();
    allocationOwner.coordinator.assertOwned();
  };
  const execute = async (operation: ResourceOperation, signal = params.signal) => {
    const cleanup =
      operation.op === "cleanup" ||
      operation.op === "cleanup-finalize" ||
      operation.op === "cleanup-intent";
    const assertDispatchCurrent = cleanup ? params.assertCurrent : assertAllocationCurrent;
    assertDispatchCurrent();
    const result = await params.tunnel.runWorkspaceCommand({
      argv: ["node", "-e", SKILL_RESOURCE_RUNTIME_SCRIPT],
      input: JSON.stringify(operation),
      transportRetry: "never",
      assertCurrent: assertDispatchCurrent,
      signal: cleanup ? undefined : signal,
      timeoutMs: cleanup ? 5000 : 60000,
    });
    // Preserve the accepted cleanup locator before observing turn cancellation.
    // The exact placement must still own every command, including cleanup.
    if (operation.op === "init") {
      allocationOwner.coordinator.assertOwned();
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
  const remotePath = path.posix.isAbsolute(params.remoteWorkspaceDir) ? path.posix : path.win32;
  if (!remotePath.isAbsolute(params.remoteWorkspaceDir)) {
    throw new Error("Remote workspace directory must be absolute.");
  }
  const id = randomUUID().replaceAll("-", "");
  const leaseToken = randomBytes(32).toString("hex");
  const attestation = skillResourceAllocationAttestation(leaseToken);
  const workspace = remotePath.normalize(params.remoteWorkspaceDir);
  if (workspace !== params.remoteWorkspaceDir) {
    throw new Error("Remote workspace directory must be canonical.");
  }
  const root = remotePath.join(
    workspace,
    `${RESOURCE_REGISTRY_PREFIX}${id}`,
    skillResourceAllocationDirectoryName(id),
  );
  let ledgerRecord = await allocationOwner.coordinator.createIntent({
    allocationId: id,
    environmentId: params.allocationOwner.environmentId,
    ownerEpoch: params.allocationOwner.ownerEpoch,
    workspace,
    leaseToken,
  });
  const retireIntent = async () =>
    await allocationOwner.coordinator.retire(ledgerRecord, params.tunnel, params.assertCurrent);
  let initialized: unknown;
  try {
    initialized = JSON.parse(await execute({ op: "init", attestation, id, workspace }));
  } catch (error) {
    await retireIntent().catch(() => undefined);
    params.signal?.throwIfAborted();
    throw new Error("Invalid skill resource allocation from execution environment.", {
      cause: error,
    });
  }
  if (
    !initialized ||
    typeof initialized !== "object" ||
    Array.isArray(initialized) ||
    Object.keys(initialized).length !== 3 ||
    !("identity" in initialized) ||
    !("registryIdentity" in initialized) ||
    !("workspaceIdentity" in initialized) ||
    typeof initialized.identity !== "string" ||
    initialized.identity.match(/^\d+:\d+$/)?.[0] !== initialized.identity ||
    typeof initialized.registryIdentity !== "string" ||
    initialized.registryIdentity.match(/^\d+:\d+$/)?.[0] !== initialized.registryIdentity ||
    typeof initialized.workspaceIdentity !== "string" ||
    initialized.workspaceIdentity.match(/^\d+:\d+$/)?.[0] !== initialized.workspaceIdentity
  ) {
    await retireIntent().catch(() => undefined);
    throw new Error("Invalid skill resource allocation from execution environment.");
  }
  const location: SkillResourceLocation = {
    attestation,
    id,
    identity: initialized.identity,
    root,
    workspace,
    registryIdentity: initialized.registryIdentity,
    workspaceIdentity: initialized.workspaceIdentity,
  };
  const leaseLocation: SkillResourceLeaseLocation = {
    attestation,
    id,
    identity: location.identity,
    workspace,
    registryIdentity: location.registryIdentity,
    workspaceIdentity: location.workspaceIdentity,
  };
  const ledgerLocation = {
    identity: location.identity,
    registryIdentity: location.registryIdentity,
    workspaceIdentity: location.workspaceIdentity,
  };
  // A forged init response cannot prove that its claimed identity belongs to the receiver's
  // canonical root. Require the receiver to accept the complete lease tuple before using it.
  try {
    await execute({ op: "renew", ...leaseLocation });
  } catch (error) {
    await cleanupSkillResourceAllocation({
      record: { ...ledgerRecord, location: ledgerLocation },
      runtimeScript: SKILL_RESOURCE_RUNTIME_SCRIPT,
      tunnel: params.tunnel,
      assertCurrent: params.assertCurrent,
    }).catch(() => undefined);
    await retireIntent().catch(() => undefined);
    throw error;
  }
  try {
    ledgerRecord = await allocationOwner.coordinator.markAllocated(ledgerRecord, {
      identity: location.identity,
      registryIdentity: location.registryIdentity,
      workspaceIdentity: location.workspaceIdentity,
    });
  } catch (error) {
    await cleanupSkillResourceAllocation({
      record: { ...ledgerRecord, location: ledgerLocation },
      runtimeScript: SKILL_RESOURCE_RUNTIME_SCRIPT,
      tunnel: params.tunnel,
      assertCurrent: params.assertCurrent,
    }).catch(() => undefined);
    await retireIntent().catch(() => undefined);
    throw error;
  }
  try {
    await execute({ op: "commit", ...leaseLocation });
  } catch (error) {
    await allocationOwner.coordinator
      .retire(ledgerRecord, params.tunnel, params.assertCurrent)
      .catch(() => undefined);
    throw error;
  }
  let renewalStopped = false;
  let renewalFailure: Error | undefined;
  let leaseDeadline = Date.now() + RESOURCE_LEASE_MS;
  let nextRenewAt = Date.now() + RESOURCE_LEASE_RENEW_MS;
  let renewalRunning = false;
  let renewalAbort: AbortController | undefined;
  let renewalInFlight = Promise.resolve();
  const failRenewal = (error: unknown) => {
    renewalFailure =
      error instanceof Error
        ? error
        : new Error("Skill resource lease authority was lost.", { cause: error });
    renewalStopped = true;
    clearInterval(renewalTimer);
  };
  const runRenewal = () => {
    const controller = new AbortController();
    renewalAbort = controller;
    const signal = params.signal
      ? AbortSignal.any([params.signal, controller.signal])
      : controller.signal;
    const deadlineError = new DOMException("Skill resource lease renewal expired", "TimeoutError");
    const timeout = setTimeout(
      () => controller.abort(deadlineError),
      Math.max(0, leaseDeadline - Date.now()),
    );
    timeout.unref?.();
    const operation = execute({ op: "renew", ...leaseLocation }, signal);
    void operation.catch(() => undefined);
    const abortReason = () =>
      signal.reason instanceof Error
        ? signal.reason
        : new DOMException("Skill resource renewal aborted", "AbortError");
    const aborted = new Promise<never>((_resolve, reject) => {
      if (signal.aborted) {
        reject(abortReason());
        return;
      }
      signal.addEventListener("abort", () => reject(abortReason()), { once: true });
    });
    return Promise.race([operation, aborted]).finally(() => {
      clearTimeout(timeout);
      if (renewalAbort === controller) {
        renewalAbort = undefined;
      }
    });
  };
  const renewalTimer = setInterval(() => {
    if (renewalStopped || renewalRunning || Date.now() < nextRenewAt) {
      return;
    }
    renewalRunning = true;
    renewalInFlight = runRenewal()
      .then(() => {
        leaseDeadline = Date.now() + RESOURCE_LEASE_MS;
        nextRenewAt = Date.now() + RESOURCE_LEASE_RENEW_MS;
      })
      .catch((error: unknown) => {
        try {
          assertAllocationCurrent();
        } catch (authorityError) {
          failRenewal(authorityError);
          return;
        }
        if (Date.now() + RESOURCE_SWEEP_MS >= leaseDeadline) {
          failRenewal(
            new Error("Skill resource lease could not be renewed before expiry.", {
              cause: error,
            }),
          );
        } else {
          nextRenewAt = Date.now() + RESOURCE_SWEEP_MS;
        }
      })
      .finally(() => {
        renewalRunning = false;
      });
  }, RESOURCE_SWEEP_MS);
  renewalTimer.unref?.();
  const assertResourcesCurrent = () => {
    assertAllocationCurrent();
    if (!renewalFailure && !renewalStopped && Date.now() >= leaseDeadline) {
      const error = new Error("Skill resource lease expired before renewal completed.");
      renewalAbort?.abort(error);
      failRenewal(error);
    }
    if (renewalFailure) {
      throw renewalFailure;
    }
  };
  let cleanupInFlight: Promise<void> | undefined;
  const cleanup = () => {
    if (cleanupInFlight) {
      return cleanupInFlight;
    }
    const current = (async () => {
      renewalStopped = true;
      clearInterval(renewalTimer);
      renewalAbort?.abort(new DOMException("Skill resource cleanup started", "AbortError"));
      await renewalInFlight.catch(() => undefined);
      await allocationOwner.coordinator.retire(ledgerRecord, params.tunnel, params.assertCurrent);
    })();
    cleanupInFlight = current;
    void current.catch(() => {
      if (cleanupInFlight === current) {
        cleanupInFlight = undefined;
      }
    });
    return current;
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
            ...leaseLocation,
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
      const remoteBase = `${location.root.replaceAll("\\", "/")}/${index}`;
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
      assertCurrent: assertResourcesCurrent,
      cleanup,
    };
  } catch (error) {
    await cleanup().catch(() => undefined);
    throw error;
  }
}
