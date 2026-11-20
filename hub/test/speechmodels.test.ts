import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { makeHub } from "./helpers.js";
import { SPEECH_MANIFEST, allowedHost, fetchFile, modelPin, prepareSpeechModel, resetSpeechModels, sourceUrl, speechModelSettled, useSpeechFetch, type SpeechModelPin } from "../src/speechmodels.js";

test("the hub's speech model pins match the Apple apps' pins file by file", () => {
  const swift = fs.readFileSync(path.resolve(import.meta.dirname, "../../apple/Packages/EACore/Sources/EACore/SpeechModel.swift"), "utf8");
  assert.equal(/static let revision = "([0-9a-f]{40})"/.exec(swift)?.[1], SPEECH_MANIFEST.revision);
  for (const m of SPEECH_MANIFEST.models) {
    const block = swift.slice(swift.indexOf(`name: "${m.name}"`));
    for (const f of m.files) assert.ok(block.includes(`File("${f.path}", ${f.size}, "${f.sha256}")`), `${m.name} ${f.path}`);
    assert.ok(block.includes(`tokenizerRevision: "${m.tokenizer_revision}"`));
  }
});

test("model files come only from Hugging Face, at the pinned revision, and only when they hash as pinned", async () => {
  const m = modelPin("openai_whisper-base.en")!;
  assert.match(sourceUrl(m, m.files[0]), new RegExp(`^https://huggingface\\.co/argmaxinc/whisperkit-coreml/resolve/${SPEECH_MANIFEST.revision}/openai_whisper-base\\.en/`));
  assert.match(sourceUrl(m, m.files.find((f) => f.path === "tokenizer.json")!), /^https:\/\/huggingface\.co\/openai\/whisper-base\.en\/resolve\/[0-9a-f]{40}\/tokenizer\.json$/);
  assert.ok(allowedHost("huggingface.co") && allowedHost("cas-bridge.xethub.hf.co") && !allowedHost("evil.example") && !allowedHost("huggingface.co.evil.example"));

  const dir = fs.mkdtempSync(path.join(import.meta.dirname, ".speech-"));
  try {
    const body = Buffer.from("pretend model weights");
    const f = { path: "x.bin", size: body.length, sha256: crypto.createHash("sha256").update(body).digest("hex") };
    const fake = (async (url: string) => {
      const u = new URL(url);
      if (u.hostname === "huggingface.co") return new Response(null, { status: 302, headers: { location: url.includes("bad") ? "https://evil.example/x" : "https://cdn-lfs.hf.co/x" } });
      return new Response(url.includes("cdn-lfs") ? body : "other", { status: 200 });
    }) as typeof fetch;
    await fetchFile("https://huggingface.co/a/resolve/r/x.bin", f, path.join(dir, "x.bin"), fake);
    assert.deepEqual(fs.readFileSync(path.join(dir, "x.bin")), body, "followed to Hugging Face's file host and kept");
    await assert.rejects(fetchFile("https://huggingface.co/a/resolve/r/bad.bin", f, path.join(dir, "y.bin"), fake), /refused to fetch from evil\.example/);
    await assert.rejects(fetchFile("https://huggingface.co/a/resolve/r/x.bin", { ...f, sha256: "0".repeat(64) }, path.join(dir, "z.bin"), fake), /not the pinned file/);
    assert.equal(fs.existsSync(path.join(dir, "z.bin")) || fs.existsSync(path.join(dir, "z.bin.part")), false, "nothing unchecked is left behind");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the hub fetches the Watch's model once on the first ask and hands each checked file to a device", async () => {
  const t = makeHub();
  resetSpeechModels();
  try {
    // A small stand-in model with real hashes, fetched through a fake Hugging Face.
    const files = ["a.bin", "b/c.json"].map((p) => ({ p, body: Buffer.from(`contents of ${p}`) }));
    const m: SpeechModelPin = { name: "openai_whisper-base.en", tokenizer_repo: "openai/whisper-base.en", tokenizer_revision: "1".repeat(40), files: files.map(({ p, body }) => ({ path: p, size: body.length, sha256: crypto.createHash("sha256").update(body).digest("hex") })) };
    let asked = 0;
    const fake = (async (url: string) => { asked++; const f = files.find(({ p }) => url.endsWith(`/${p}`))!; return new Response(f.body, { status: 200 }); }) as typeof fetch;
    // Everything this test starts goes to the stand-in, never the network (the route asks for the real model too).
    useSpeechFetch((async () => new Response("no", { status: 404 })) as typeof fetch);
    assert.equal(prepareSpeechModel(t.hub, m, fake).state, "fetching");
    await speechModelSettled(m.name);
    assert.equal(prepareSpeechModel(t.hub, m, fake).state, "ready");
    assert.equal(asked, 2, "each file once");

    const res = await t.api("/speech-models/openai_whisper-base.en");
    assert.equal(res.status, 200);
    await speechModelSettled(m.name);
    const unknown = await t.api("/speech-models/whatever");
    assert.equal(unknown.status, 404);
    const refused = await t.api(`/speech-models/openai_whisper-base.en/file?path=${encodeURIComponent("../../hub.env")}`);
    assert.equal(refused.status, 404, "only the model's own files");
    const notYet = await t.api(`/speech-models/openai_whisper-base.en/file?path=${encodeURIComponent("config.json")}`);
    assert.equal(notYet.status, 409, "a real pinned file not fetched here is not handed out");
  } finally { resetSpeechModels(); t.cleanup(); }
});
