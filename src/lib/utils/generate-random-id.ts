export function generateRandomId(): string {
  const hex = crypto.randomUUID().replace(/-/g, "");
  const bytes = new Uint8Array(
    hex.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16)),
  );
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const BASE60_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz".slice(0, 60);

export function randomBase60String(length: number) {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += BASE60_ALPHABET[Math.floor(Math.random() * 60)];
  }
  return out;
}
