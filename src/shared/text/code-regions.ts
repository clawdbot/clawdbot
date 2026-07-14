// Code region helpers now live in the shared normalization-core package so both
// core sanitizers and the tool-call-repair package resolve one implementation.
export { findCodeRegions, isInsideCode, type CodeRegion } from "@openclaw/normalization-core";
