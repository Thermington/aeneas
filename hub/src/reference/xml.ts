import { createRequire } from "node:module";

/**
 * XML from Kiwix (the OPDS catalog, metalinks, the reader's search results) read with xmldom, the XML parser the hub
 * already has. It never fetches or expands outside entities. A document that is not well-formed is an error.
 */

export interface XNode {
  nodeType: number;
  nodeName: string;
  localName?: string | null;
  nodeValue: string | null;
  textContent: string | null;
  childNodes: { length: number; [i: number]: XNode };
  getAttribute?(name: string): string | null;
}

const require = createRequire(import.meta.url);
const xmldom = require("@xmldom/xmldom") as { DOMParser: new (o: { onError: (level: string, msg: string) => void }) => { parseFromString(x: string, t: string): XNode } };

export function parseXml(text: string): XNode {
  let fatal: string | null = null;
  let doc: XNode;
  try {
    doc = new xmldom.DOMParser({ onError: (level, msg) => { if (level !== "warning" && !fatal) fatal = String(msg).slice(0, 200); } }).parseFromString(text, "text/xml");
  } catch (e) { throw new Error(`not well-formed XML: ${String((e as Error).message).slice(0, 200)}`); }
  if (fatal) throw new Error(`not well-formed XML: ${fatal}`);
  return doc;
}

/** An element's name without its namespace prefix. */
export function localName(n: XNode): string { return n.localName ?? n.nodeName.replace(/^.*:/, ""); }

export function children(n: XNode, name?: string): XNode[] {
  const out: XNode[] = [];
  for (let i = 0; i < n.childNodes.length; i++) {
    const c = n.childNodes[i];
    if (c.nodeType === 1 && (!name || localName(c) === name)) out.push(c);
  }
  return out;
}

export function child(n: XNode, name: string): XNode | null { return children(n, name)[0] ?? null; }

/** Every element of that name under `n`, in document order. */
export function descendants(n: XNode, name: string): XNode[] {
  const out: XNode[] = [];
  const walk = (x: XNode) => {
    for (let i = 0; i < x.childNodes.length; i++) {
      const c = x.childNodes[i];
      if (c.nodeType !== 1) continue;
      if (localName(c) === name) out.push(c);
      walk(c);
    }
  };
  walk(n);
  return out;
}

export function text(n: XNode | null | undefined): string { return (n?.textContent ?? "").trim(); }
export function attr(n: XNode | null | undefined, name: string): string { return n?.getAttribute?.(name) ?? ""; }
