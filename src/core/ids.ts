/**
 * Record ids: UUID v7 — made on the client, so a record has its id before any
 * source has seen it (offline, in a batch with its register movements), and
 * sorted by creation time, which keeps indexes of the sources compact.
 */
export function uuid(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let ms = Date.now();
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ms & 0xff;
    ms = Math.floor(ms / 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
