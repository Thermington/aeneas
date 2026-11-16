import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { installKiwix, kiwixPlatform, KIWIX_VERSION } from "../src/reference/kiwix.js";

/** A release folder on 127.0.0.1 serving one file; counts what was asked. */
async function release(file: string, bytes: Buffer): Promise<{ url: string; asked: string[]; close(): Promise<void> }> {
  const asked: string[] = [];
  const server = http.createServer((req, res) => {
    asked.push(req.url ?? "");
    if (req.url === `/release/${file}`) { res.writeHead(200, { "content-length": String(bytes.length) }); res.end(bytes); return; }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/release/`, asked, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test("reference reader install: the archive is checked against its pin before it is unpacked, then reused", { skip: process.platform === "win32" ? "the zip build is unpacked by Windows' own tar" : false }, async () => {
  const platform = kiwixPlatform() ?? "linux-x86_64";
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "ea-ref-install-"));
  try {
    // A stand-in for Kiwix's tarball: one folder holding kiwix-serve and its tools.
    const name = `kiwix-tools_${platform}-${KIWIX_VERSION}`;
    fs.mkdirSync(path.join(work, "src", name), { recursive: true });
    fs.writeFileSync(path.join(work, "src", name, "kiwix-serve"), "#!/bin/sh\necho stand-in\n");
    fs.writeFileSync(path.join(work, "src", name, "kiwix-search"), "x");
    const file = `${name}.tar.gz`;
    execFileSync("tar", ["-czf", path.join(work, file), "-C", path.join(work, "src"), name]);
    const bytes = fs.readFileSync(path.join(work, file));
    const pin = { file, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
    const r = await release(file, bytes);
    try {
      const binDir = path.join(work, "bin");
      // A pin that does not match: nothing is unpacked or kept.
      await assert.rejects(installKiwix({ binDir, releaseUrl: r.url, pins: { [platform]: { ...pin, sha256: "0".repeat(64) } }, allowHttpLoopback: true }, platform), /pinned SHA-256/);
      await assert.rejects(installKiwix({ binDir, releaseUrl: r.url, pins: { [platform]: { ...pin, bytes: pin.bytes + 1 } }, allowHttpLoopback: true }, platform), /not the size pinned/);
      assert.deepEqual(fs.readdirSync(binDir), [], "no archive and no reader left behind");
      // Plain http is refused outside tests.
      await assert.rejects(installKiwix({ binDir, releaseUrl: r.url, pins: { [platform]: pin } }, platform), /only https/);
      const exe = await installKiwix({ binDir, releaseUrl: r.url, pins: { [platform]: pin }, allowHttpLoopback: true }, platform);
      assert.equal(exe, path.join(binDir, `kiwix-tools-${KIWIX_VERSION}`, "kiwix-serve"));
      assert.equal(fs.statSync(exe).mode & 0o111, 0o111, "it can run");
      assert.deepEqual(fs.readdirSync(binDir), [`kiwix-tools-${KIWIX_VERSION}`], "the archive is removed once unpacked");
      const asked = r.asked.length;
      assert.equal(await installKiwix({ binDir, releaseUrl: r.url, pins: { [platform]: pin }, allowHttpLoopback: true }, platform), exe);
      assert.equal(r.asked.length, asked, "downloaded once");
      await assert.rejects(installKiwix({ binDir, pins: {} }, "plan9-mips"), /no reader for this machine/);
    } finally { await r.close(); }
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
});
