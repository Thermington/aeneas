import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub } from "./helpers.js";
import { ago, done, fake, linked } from "./fake-icloud-mail.js";
import { verifiedLogo } from "../src/imports/icloud.js";
import { fetchMailImages, isSvg, mailImages } from "../src/mail-inbox.js";

// Brand logos on the Mail screen: only those iCloud verified (BIMI with a mark certificate). Every mail is made up.

const LOGO = "https://cdn.shop.example/logo.svg";
/** The header lines iCloud writes at the top of a mail whose brand logo it verified. */
const verified = (domain = "shop.example", from = domain) => Buffer.from([
  `Authentication-Results: bimi.icloud.com; bimi=pass header.d=${domain} header.selector=default policy.authority=pass policy.authority-uri=https://cdn.shop.example/vmc.pem`,
  `BIMI-Location: v=BIMI1; l=${LOGO} a=https://cdn.shop.example/vmc.pem`,
  "Authentication-Results: arc.icloud.com; arc=none",
  `Authentication-Results: dmarc.icloud.com; dmarc=pass header.from=${from}`,
  "",
].join("\r\n"));

test("mail logos: a brand's logo only when iCloud verified it, its certificate included, for the From domain", () => {
  assert.deepEqual(verifiedLogo(verified(), "orders@shop.example"), { domain: "shop.example", url: LOGO });
  assert.deepEqual(verifiedLogo(verified("shop.example", "mail.shop.example"), "news@mail.shop.example"), { domain: "shop.example", url: LOGO }, "a subdomain of the brand");
  const no = (headers: string, from = "orders@shop.example") => assert.equal(verifiedLogo(Buffer.from(headers), from), null, headers.slice(0, 120));
  no("Authentication-Results: bimi.icloud.com; bimi=none\r\nAuthentication-Results: dmarc.icloud.com; dmarc=pass header.from=shop.example\r\n");
  no("Authentication-Results: bimi.icloud.com; bimi=skipped reason=\"insufficient dmarc\"\r\n");
  no(verified().toString().replace("policy.authority=pass", "policy.authority=none"), "orders@shop.example");
  no(verified().toString().replace("dmarc=pass", "dmarc=fail"), "orders@shop.example");
  no(verified().toString().replace(`l=${LOGO}`, "l=http://cdn.shop.example/logo.svg"), "orders@shop.example");
  no(verified().toString(), "phish@sh0p.example");
  no(verified().toString(), "no address");
});

test("mail logos: a sender's forged verdict below iCloud's is never read", () => {
  // iCloud said none; the sender wrote a pass of their own, lower down. The first bimi.icloud.com result is iCloud's.
  const forged = [
    "Authentication-Results: bimi.icloud.com; bimi=none",
    "Authentication-Results: dmarc.icloud.com; dmarc=pass header.from=sh0p.example",
    "Authentication-Results: bimi.icloud.com; bimi=pass header.d=sh0p.example policy.authority=pass",
    `BIMI-Location: v=BIMI1; l=${LOGO}`,
    "",
  ].join("\r\n");
  assert.equal(verifiedLogo(Buffer.from(forged), "alerts@sh0p.example"), null);
  // A logo verified for another brand's domain is not this sender's.
  assert.equal(verifiedLogo(verified("bank.example", "sh0p.example"), "alerts@sh0p.example"), null);
});

test("mail logos: only an SVG picture is kept", () => {
  assert.ok(isSvg(Buffer.from('<?xml version="1.0"?>\n<!-- logo -->\n<svg xmlns="http://www.w3.org/2000/svg"></svg>')));
  assert.ok(!isSvg(Buffer.from("<html><body>Not found</body></html>")));
  assert.ok(!isSvg(Buffer.from([0x89, 0x50, 0x4e, 0x47])));
});

test("mail logos: fetched once per brand by the hub through Tor, listed once, and gone with the module", async () => {
  const t = makeHub({ torSocks: "127.0.0.1:9" });
  const real = mailImages.fetch;
  const fetched: string[] = [];
  try {
    linked(t);
    const headers = verified().toString();
    fake([
      { uid: 1, folder: "INBOX", at: ago(0), subject: "Your order shipped", from: { name: "Shop", address: "orders@shop.example" }, messageId: "a@x", plain: "Shipped.", headers },
      { uid: 2, folder: "INBOX", at: ago(1), subject: "Your receipt", from: { name: "Shop", address: "orders@shop.example" }, messageId: "b@x", plain: "Thanks.", headers },
      { uid: 3, folder: "INBOX", at: ago(2), subject: "Hike?", from: { name: "Alex", address: "alex@example.com" }, messageId: "c@x", plain: "Saturday?" },
    ]);
    mailImages.fetch = async (url, socks) => { assert.equal(socks, "127.0.0.1:9"); fetched.push(url); return Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>'); };
    await t.api("/mail/refresh", { method: "POST" });
    await fetchMailImages(t.hub);
    assert.deepEqual(fetched, [LOGO], "one fetch for the brand, not one per mail");
    const l = await (await t.api("/mail")).json() as { messages: { subject: string; logo_domain?: string }[]; logos: Record<string, string> };
    assert.deepEqual(l.messages.map((m) => m.logo_domain ?? null), ["shop.example", "shop.example", null]);
    assert.deepEqual(Object.keys(l.logos), ["shop.example"]);
    assert.match(l.logos["shop.example"], /^data:image\/svg\+xml;base64,/);
    await t.api("/modules", { method: "PUT", json: { mail_inbox: false } });
    assert.equal((t.hub.mailDb.prepare("SELECT COUNT(*) AS n FROM logos").get() as { n: number }).n, 0);
  } finally { mailImages.fetch = real; done(t); }
});

test("mail logos: a hub without Tor fetches no logo, and shows none", async () => {
  const t = makeHub();
  const real = { ...mailImages };
  const fetched: string[] = [];
  try {
    linked(t);
    fake([{ uid: 1, folder: "INBOX", at: ago(0), subject: "Your order shipped", from: { name: "Shop", address: "orders@shop.example" }, messageId: "a@x", plain: "Shipped.", headers: verified().toString() }]);
    mailImages.fetch = async (url) => { fetched.push(url); return Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'); };
    mailImages.direct = async (url) => { fetched.push(url); return null; };
    await t.api("/mail/refresh", { method: "POST" });
    await fetchMailImages(t.hub);
    assert.deepEqual(fetched, []);
    const l = await (await t.api("/mail")).json() as { logos: Record<string, string> };
    assert.deepEqual(l.logos, {});
  } finally { Object.assign(mailImages, real); done(t); }
});
