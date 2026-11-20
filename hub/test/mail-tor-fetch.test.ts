import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fetchBytesViaTor, fetchPublicBytes, TorDown, torFetch } from "../src/ai/web.js";

/**
 * Mail pictures through Tor (ai/web.ts, fetchBytesViaTor). A stand-in takes curl's place: it writes down how it was
 * called and answers as the test says, so nothing here reaches Tor or the internet. It is a shell script, so these
 * tests run on macOS and Linux.
 */
const posix = process.platform !== "win32";
const SOCKS = "127.0.0.1:9052";

function standIn(): { dir: string; args: () => string[]; answer: (a: string) => void; done: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-tor-fetch-"));
  const file = path.join(dir, "curl-stand-in");
  const argsFile = path.join(dir, "args");
  fs.writeFileSync(file, [
    "#!/bin/sh",
    "printf '%s\\n' \"$@\" > \"$STANDIN_ARGS\"",
    "case \"$STANDIN_ANSWER\" in",
    "  picture) printf 'PICTUREBYTES'; printf '\\n@@meta@@200' >&2; exit 0;;",
    "  notfound) printf 'not here'; printf '\\n@@meta@@404' >&2; exit 0;;",
    "  big) head -c 5000 /dev/zero; printf '\\n@@meta@@200' >&2; exit 0;;",
    "  toobig) echo 'curl: (63) Maximum file size exceeded' >&2; exit 63;;",
    "  noproxy) echo 'curl: (7) Failed to connect to 127.0.0.1 port 9052: Connection refused' >&2; exit 7;;",
    "  unreachable) echo 'curl: (97) cannot complete SOCKS5 connection' >&2; exit 97;;",
    "esac",
    "",
  ].join("\n"), { mode: 0o755 });
  const before = { curl: torFetch.curl, args: process.env.STANDIN_ARGS, answer: process.env.STANDIN_ANSWER };
  torFetch.curl = file;
  process.env.STANDIN_ARGS = argsFile;
  return {
    dir,
    args: () => (fs.existsSync(argsFile) ? fs.readFileSync(argsFile, "utf8").split("\n").filter(Boolean) : []),
    answer: (a) => { process.env.STANDIN_ANSWER = a; fs.rmSync(argsFile, { force: true }); },
    done: () => {
      torFetch.curl = before.curl;
      if (before.args === undefined) delete process.env.STANDIN_ARGS; else process.env.STANDIN_ARGS = before.args;
      if (before.answer === undefined) delete process.env.STANDIN_ANSWER; else process.env.STANDIN_ANSWER = before.answer;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("mail pictures through Tor: asked for through the SOCKS proxy, https only, with nothing that names the hub", { skip: !posix }, async () => {
  const s = standIn();
  try {
    s.answer("picture");
    const b = await fetchBytesViaTor("https://img.example/a[1-3]{x,y}.png?u=1", SOCKS, 30_000, 1000);
    assert.equal(b?.toString(), "PICTUREBYTES");
    const args = s.args();
    const after = (flag: string) => args[args.indexOf(flag) + 1];
    assert.equal(after("--socks5-hostname"), SOCKS, "the name is looked up at the exit, not here");
    assert.equal(after("--proto"), "=https");
    assert.equal(after("--proto-redir"), "=https", "a redirect to plain http is not followed");
    assert.equal(after("--max-filesize"), "1000");
    assert.equal(after("--max-time"), "30");
    assert.ok(args.includes("-g"), "brackets and braces in an address are not a list of addresses");
    // The address as Node writes it out: braces are escaped, brackets stay, and -g keeps curl from reading them as a range.
    assert.equal(args[args.length - 1], "https://img.example/a[1-3]%7Bx,y%7D.png?u=1");
    for (const never of ["-k", "--insecure", "-b", "--cookie", "-c", "--cookie-jar", "-e", "--referer", "--noproxy", "-x", "--proxy"]) assert.ok(!args.includes(never), never);
  } finally { s.done(); }
});

test("mail pictures through Tor: no picture for a refusal, too much, or a server Tor cannot reach; never a direct fetch", { skip: !posix }, async () => {
  const s = standIn();
  try {
    for (const a of ["notfound", "big", "toobig", "unreachable"]) {
      s.answer(a);
      assert.equal(await fetchBytesViaTor("https://img.example/a.png", SOCKS, 30_000, 1000), null, a);
      assert.equal(s.args().at(-1), "https://img.example/a.png", `${a}: asked once, through the stand-in`);
    }
    // Plain http is not asked for at all: a Tor exit could read and change it.
    s.answer("picture");
    assert.equal(await fetchBytesViaTor("http://img.example/a.png", SOCKS), null);
    assert.equal(await fetchBytesViaTor("ftp://img.example/a.png", SOCKS), null);
    assert.equal(await fetchBytesViaTor("not an address", SOCKS), null);
    assert.deepEqual(s.args(), [], "nothing was run for them");
  } finally { s.done(); }
});

test("mail pictures through Tor: Tor not there is told apart from a picture that failed", { skip: !posix }, async () => {
  const s = standIn();
  try {
    s.answer("noproxy");
    await assert.rejects(fetchBytesViaTor("https://img.example/a.png", SOCKS), TorDown);
    // No curl on the hub, or no Tor address at all: the same, and nothing is fetched another way.
    torFetch.curl = path.join(s.dir, "no-such-program");
    await assert.rejects(fetchBytesViaTor("https://img.example/a.png", SOCKS), TorDown);
    await assert.rejects(fetchBytesViaTor("https://img.example/a.png", ""), TorDown);
  } finally { s.done(); }
});

test("mail pictures straight from the hub (Show pictures): https only, and never an address on the home network", async () => {
  assert.equal(await fetchPublicBytes("http://img.example/a.png", 2000), null);
  assert.equal(await fetchPublicBytes("https://192.168.1.1/logo.png", 2000), null);
  assert.equal(await fetchPublicBytes("https://127.0.0.1:1/logo.png", 2000), null);
  assert.equal(await fetchPublicBytes("https://[::1]/logo.png", 2000), null);
});
