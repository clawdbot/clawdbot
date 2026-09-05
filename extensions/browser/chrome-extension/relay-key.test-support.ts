export function relayTestKey(seed: number): string {
  let key = "";
  for (let byteIndex = 0; byteIndex < 32; byteIndex += 1) {
    key += ((seed + byteIndex * 17) & 0xff).toString(16).padStart(2, "0");
  }
  return key;
}
