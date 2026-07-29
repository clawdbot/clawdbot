// Runtime barrel for gateway call clients. Keeping this separate lets tests and
// lazy boundaries import the runtime call implementation without extra exports.
export { callGateway } from "./call.js";
