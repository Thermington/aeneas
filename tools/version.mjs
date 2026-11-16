#!/usr/bin/env node
// One version for the hub and every app (CONTRACT, Versions): the hub reports it in /health, the iPhone, iPad, Mac and
// Watch apps show it in Settings, About, and so do the Windows and Android apps and the Windows hub installer. A hub
// installed from GitHub and an app from the App Store of the same release say the same number.
//
//   node tools/version.mjs                 lists every place and fails when they differ
//   node tools/version.mjs --tag v1.2.3    also fails unless the version is 1.2.3 (the release workflow's check)
//   node tools/version.mjs set 1.2.3       writes it everywhere, lock files included (npm ci refuses a lock whose
//                                          workspace versions differ from their package.json)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION_RE = /^\d+\.\d+\.\d+$/;

/** The first top-level `"version": "..."` of a package.json or tauri.conf.json (they come before any nested one). */
const jsonVersion = {
  read: (s) => /^\s*"version":\s*"([^"]*)"/m.exec(s)?.[1] ?? null,
  write: (s, v) => s.replace(/^(\s*"version":\s*")[^"]*(")/m, `$1${v}$2`),
};

/** Every place the version is written, with how to read and write it there. */
export const PLACES = [
  { file: "package.json", ...jsonVersion },
  { file: "hub/package.json", ...jsonVersion },
  { file: "web/package.json", ...jsonVersion },
  { file: "packages/shared/package.json", ...jsonVersion },
  { file: "tools/vault-mirror/package.json", ...jsonVersion },
  { file: "web/src-tauri/tauri.conf.json", ...jsonVersion },
  {
    file: "web/src-tauri/Cargo.toml",
    read: (s) => /^\[package\][^[]*?^version\s*=\s*"([^"]*)"/ms.exec(s)?.[1] ?? null,
    write: (s, v) => s.replace(/^(\[package\][^[]*?^version\s*=\s*")[^"]*(")/ms, `$1${v}$2`),
  },
  {
    file: "web/src-tauri/Cargo.lock",
    read: (s) => /^name = "everythingapp"\nversion = "([^"]*)"/m.exec(s)?.[1] ?? null,
    write: (s, v) => s.replace(/^(name = "everythingapp"\nversion = ")[^"]*(")/m, `$1${v}$2`),
  },
  {
    // Every target takes MARKETING_VERSION from the project settings; each line must say the same.
    file: "apple/project.yml",
    read: (s) => {
      const all = [...s.matchAll(/MARKETING_VERSION:\s*"([^"]*)"/g)].map((m) => m[1]);
      return all.length && all.every((x) => x === all[0]) ? all[0] : all.length ? `mixed: ${all.join(", ")}` : null;
    },
    write: (s, v) => s.replace(/(MARKETING_VERSION:\s*")[^"]*(")/g, `$1${v}$2`),
  },
  {
    // The workspaces' own entries (npm writes this file as JSON with two spaces and a newline at the end).
    file: "package-lock.json",
    read: (s) => {
      const j = JSON.parse(s);
      const all = [j.version, ...WORKSPACES.map((w) => j.packages?.[w]?.version)];
      return all.every((x) => x === all[0]) ? all[0] : `mixed: ${all.join(", ")}`;
    },
    write: (s, v) => {
      const j = JSON.parse(s);
      j.version = v;
      for (const w of WORKSPACES) if (j.packages?.[w]) j.packages[w].version = v;
      return `${JSON.stringify(j, null, 2)}\n`;
    },
  },
];

/** The lock file's keys for the root and each workspace package. */
const WORKSPACES = ["", "hub", "web", "packages/shared", "tools/vault-mirror"];

/** `{ file, version }` for every place, read from `root`. */
export function readVersions(root = ROOT) {
  return PLACES.map((p) => {
    let version = null;
    try { version = p.read(fs.readFileSync(path.join(root, p.file), "utf8")); } catch { version = null; }
    return { file: p.file, version };
  });
}

/** The one version, or null with the reason when the places differ or one cannot be read. */
export function oneVersion(root = ROOT) {
  const list = readVersions(root);
  const missing = list.filter((x) => !x.version);
  if (missing.length) return { version: null, list, reason: `no version found in ${missing.map((x) => x.file).join(", ")}` };
  const first = list[0].version;
  const odd = list.filter((x) => x.version !== first);
  if (odd.length) return { version: null, list, reason: `${odd.map((x) => `${x.file} says ${x.version}`).join("; ")}, but package.json says ${first}` };
  return { version: first, list, reason: null };
}

function main(argv) {
  if (argv[0] === "set") {
    const v = argv[1];
    if (!v || !VERSION_RE.test(v)) { console.error("give the version as three numbers, like 1.2.3"); return 2; }
    for (const p of PLACES) {
      const file = path.join(ROOT, p.file);
      const before = fs.readFileSync(file, "utf8");
      const after = p.write(before, v);
      if (after !== before) fs.writeFileSync(file, after);
    }
    const r = oneVersion();
    if (!r.version) { console.error(`not every place took it: ${r.reason}`); return 1; }
    console.log(`version ${r.version} in ${r.list.length} places`);
    return 0;
  }
  const r = oneVersion();
  for (const x of r.list) console.log(`${(x.version ?? "missing").padEnd(10)} ${x.file}`);
  if (!r.version) { console.error(`the versions differ: ${r.reason}. Set one with: node tools/version.mjs set <version>`); return 1; }
  const tag = argv[0] === "--tag" ? String(argv[1] ?? "").replace(/^v/, "") : null;
  if (tag !== null && tag !== r.version) { console.error(`the tag says ${tag}, the repository says ${r.version}`); return 1; }
  console.log(`one version: ${r.version}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
