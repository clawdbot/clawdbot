import { beginGatewayRootWorkAdmissionWhenOpen } from "./gateway-work-admission.js";

export async function runWithGatewayRootWorkAdmissionForTest<T>(run: () => Promise<T>): Promise<T> {
  const admission = await beginGatewayRootWorkAdmissionWhenOpen();
  try {
    return await admission.run(run);
  } finally {
    admission.release();
  }
}
