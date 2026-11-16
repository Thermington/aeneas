// The second backup folder's file work, run in a child process by backup.ts (copyBackupOutside, listCopiesOutside).
// That folder can be a network share: when its server goes away, file calls on it block with no end, and run in the
// hub they blocked its only thread (the hub stopped answering at 03:00 and whenever Ops was opened). The child is
// given up on after a time limit and the hub goes on. Plain JavaScript, so it starts without the hub's TypeScript.
//
//   node backup-copy.mjs copy <encrypted backup file> <folder> <cutoff ms>   prints { copied, error? }
//   node backup-copy.mjs list <folder>                                       prints [{ file, at, bytes, encrypted }]
//
// The answer is written once and the process ends by itself: process.exit right after a write to a pipe can cut the
// write short on a Mac.
import fs from "node:fs";
import path from "node:path";

const ENCRYPTED = /^hub-\d{8}-\d{6}\.sqlite\.age$/;
const PLAIN = /^hub-\d{8}-\d{6}\.sqlite$/;

function copy(file, dir, cutoff) {
  let isDir = false;
  try { isDir = fs.statSync(dir).isDirectory(); } catch { return { copied: null, error: `${dir} is not there (a drive not plugged in or not mounted?)` }; }
  if (!isDir) return { copied: null, error: `${dir} is not a folder` };
  const dst = path.join(dir, path.basename(file));
  const part = `${dst}.partial`;
  try {
    fs.copyFileSync(file, part);
    fs.chmodSync(part, 0o600);
    const st = fs.statSync(file);
    fs.utimesSync(part, st.atime, st.mtime);
    fs.renameSync(part, dst);
  } catch (e) {
    try { fs.rmSync(part, { force: true }); } catch { /* the folder went away */ }
    return { copied: null, error: String(e?.code ?? e?.name ?? "error") };
  }
  // Only encrypted copies are pruned there: anything else in that folder is the owner's.
  for (const n of fs.readdirSync(dir)) {
    if (!ENCRYPTED.test(n)) continue;
    try { if (fs.statSync(path.join(dir, n)).mtimeMs < Number(cutoff)) fs.rmSync(path.join(dir, n), { force: true }); } catch { /* gone */ }
  }
  return { copied: dst };
}

function list(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    const encrypted = ENCRYPTED.test(n);
    if (!encrypted && !PLAIN.test(n)) continue;
    try { const st = fs.statSync(path.join(dir, n)); out.push({ file: n, at: st.mtime.toISOString(), bytes: st.size, encrypted }); } catch { /* removed meanwhile */ }
  }
  return out.sort((a, b) => b.file.localeCompare(a.file));
}

const [cmd, ...args] = process.argv.slice(2);
const result = cmd === "copy" ? copy(args[0], args[1], args[2]) : cmd === "list" ? list(args[0]) : null;
if (result === null) process.exitCode = 2;
else process.stdout.write(JSON.stringify(result));
