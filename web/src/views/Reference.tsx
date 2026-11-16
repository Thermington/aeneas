import { readerRoute } from "../lib/reference";
import { ReferenceReader } from "./reference/Reader";
import { ReferenceSearch } from "./reference/Search";

/**
 * Reference (module `reference`): the open references kept on the hub, search first. `#/reference` is the search,
 * `#/reference/<book>/<path>` a page in the reader; each page is a reader of its own, so Back and Forward between
 * pages work as they do on the web.
 */
export function Reference({ path, params }: { path: string; params: URLSearchParams }) {
  const page = readerRoute(path, params);
  if (!page) return <ReferenceSearch />;
  return <ReferenceReader key={`${page.book}\n${page.path}`} book={page.book} path={page.path} anchor={page.anchor} />;
}
