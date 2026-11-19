#!/usr/bin/env node
// Signs Windows and Android app installers so hubs hand them to devices as updates (CONTRACT, App updates).
//
//   node tools/sign-app-update.mjs dist/Aeneas-windows-1.0.5-setup.exe dist/Aeneas-android-1.0.5.apk
//
// Writes <file>.sig (the base64 Ed25519 signature) next to each file; upload both to the GitHub release. The platform
// and version come from the file name. The private key is AENEAS_UPDATE_KEY or ~/.config/aeneas-release/
// app-update-ed25519.pem, kept off the repository; each signature is checked against the public key every copy ships
// with (packages/shared/app-update-key.txt) before it is written, so a wrong key fails here, not on people's devices.
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function signedMessage(platform, version, sha256hex) {
  return `aeneas-app-update/1\n${platform}\n${version}\n${sha256hex.toLowerCase()}`;
}

export function parseName(file) {
  const base = path.basename(file);
  let m = /^Aeneas-windows-(\d+\.\d+\.\d+)-setup\.exe$/.exec(base);
  if (m) return { platform: "windows", version: m[1] };
  m = /^Aeneas-android-(\d+\.\d+\.\d+)\.apk$/.exec(base);
  if (m) return { platform: "android", version: m[1] };
  return null;
}

function publicKey() {
  const text = fs.readFileSync(path.join(ROOT, "packages/shared/app-update-key.txt"), "utf8");
  const b64 = text.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
  const raw = Buffer.from(b64 ?? "", "base64");
  if (raw.length !== 32) throw new Error("packages/shared/app-update-key.txt has no 32-byte key");
  return createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]), format: "der", type: "spki" });
}

function main(files) {
  if (!files.length) {
    console.error("usage: node tools/sign-app-update.mjs <Aeneas-windows-X.Y.Z-setup.exe | Aeneas-android-X.Y.Z.apk>...");
    process.exit(2);
  }
  const keyPath = process.env.AENEAS_UPDATE_KEY || path.join(os.homedir(), ".config/aeneas-release/app-update-ed25519.pem");
  const key = createPrivateKey(fs.readFileSync(keyPath));
  const pub = publicKey();
  for (const file of files) {
    const named = parseName(file);
    if (!named) throw new Error(`${file}: not named like Aeneas-windows-1.2.3-setup.exe or Aeneas-android-1.2.3.apk`);
    const sha = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    const msg = Buffer.from(signedMessage(named.platform, named.version, sha));
    const sig = sign(null, msg, key);
    if (!verify(null, msg, pub, sig)) throw new Error("the private key does not match packages/shared/app-update-key.txt");
    fs.writeFileSync(`${file}.sig`, sig.toString("base64") + "\n");
    console.log(`${path.basename(file)}.sig  ${named.platform} ${named.version}  sha256 ${sha}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(e instanceof Error ? e.message : e); process.exit(1); }
}
