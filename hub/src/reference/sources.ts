/**
 * The curated sources of the offline reference (CONTRACT "Offline reference"), joined with Kiwix's catalog by book
 * name. `books` are Kiwix name patterns: `{lang}` stands for the wiki's language code in the name (`wikipedia_en_all`),
 * `*` for any part of a name (`libretexts.org_en_bio`). Every name was checked against Kiwix's catalog on 2026-11-16.
 */

export const GROUPS = ["Encyclopedias", "Dictionaries and travel", "Medicine", "Practical", "Questions and answers", "Learning", "Books", "Technical"] as const;
export type Group = (typeof GROUPS)[number];

export interface Source { id: string; title: string; summary: string; group: Group; license: string; books: string[] }

const WIKIMEDIA = "CC BY-SA 4.0";
const STACK_EXCHANGE = "CC BY-SA 4.0";
const UNSURE = "See the source";

/** One Stack Exchange site in one language. */
const qa = (id: string, title: string, summary: string, book: string): Source => ({ id, title, summary, group: "Questions and answers", license: STACK_EXCHANGE, books: [book] });

export const DEVDOCS = ["python", "javascript", "node", "typescript", "bash", "git", "docker", "rust", "go", "css", "html", "http", "sqlite", "postgresql", "nginx"];

export const SOURCES: Source[] = [
  { id: "wikipedia", title: "Wikipedia", summary: "The free encyclopedia: people, places, history, science and much more.", group: "Encyclopedias", license: WIKIMEDIA, books: ["wikipedia_{lang}_all"] },

  { id: "wiktionary", title: "Wiktionary", summary: "A dictionary: meanings, spelling, pronunciation and where words come from.", group: "Dictionaries and travel", license: WIKIMEDIA, books: ["wiktionary_{lang}_all"] },
  { id: "wikivoyage", title: "Wikivoyage", summary: "A travel guide: places to see, getting around, staying safe.", group: "Dictionaries and travel", license: WIKIMEDIA, books: ["wikivoyage_{lang}_all"] },

  { id: "mdwiki", title: "WikiProjectMed medical encyclopedia", summary: "Medical articles for patients and caregivers: illnesses, injuries, treatments and medicines.", group: "Medicine", license: UNSURE, books: ["mdwiki_en_all"] },
  { id: "military_medicine", title: "Military medicine", summary: "US military manuals on field and trauma care, from the Federation of American Scientists' archive.", group: "Medicine", license: "US government work, public domain", books: ["irp.fas.org_en_military-medicine"] },
  { id: "zimgit_medicine", title: "Medical guides", summary: "Practical medical books and guides for when no doctor is near.", group: "Medicine", license: UNSURE, books: ["zimgit-medicine_en"] },

  { id: "zimgit_post_disaster", title: "After a disaster", summary: "Guides for getting through a disaster and after: shelter, power, sanitation and first aid.", group: "Practical", license: UNSURE, books: ["zimgit-post-disaster_en"] },
  { id: "zimgit_water", title: "Safe water", summary: "Finding, treating and storing safe drinking water.", group: "Practical", license: UNSURE, books: ["zimgit-water_en"] },
  { id: "zimgit_food", title: "Food preparation", summary: "Preparing, cooking and keeping food.", group: "Practical", license: UNSURE, books: ["zimgit-food-preparation_en"] },
  { id: "appropedia", title: "Appropedia", summary: "Sustainable living, appropriate technology and do-it-yourself projects.", group: "Practical", license: UNSURE, books: ["appropedia_en_all"] },
  { id: "energypedia", title: "energypedia", summary: "Renewable energy and energy access: solar, hydro, biogas, cooking stoves.", group: "Practical", license: UNSURE, books: ["energypedia_en_all"] },
  { id: "ifixit", title: "iFixit", summary: "Repair guides for phones, computers, appliances, cars and more.", group: "Practical", license: "CC BY-NC-SA 3.0", books: ["ifixit_{lang}_all"] },
  { id: "wikibooks", title: "Wikibooks", summary: "Open textbooks and manuals on many subjects.", group: "Practical", license: WIKIMEDIA, books: ["wikibooks_{lang}_all"] },

  qa("serverfault", "Server Fault", "Questions and answers for system and network administrators.", "serverfault.com_en_all"),
  qa("superuser", "Super User", "Questions and answers for computer enthusiasts and power users.", "superuser.com_en_all"),
  qa("unix_stackexchange", "Unix and Linux Stack Exchange", "Questions and answers on Linux, FreeBSD and other Unix-like systems.", "unix.stackexchange.com_en_all"),
  qa("askubuntu", "Ask Ubuntu", "Questions and answers on Ubuntu.", "askubuntu.com_en_all"),
  qa("electronics_stackexchange", "Electrical Engineering Stack Exchange", "Questions and answers on electronics and electrical engineering.", "electronics.stackexchange.com_en_all"),
  qa("gamedev_stackexchange", "Game Development Stack Exchange", "Questions and answers on making games.", "gamedev.stackexchange.com_en_all"),
  qa("music_stackexchange", "Music: Practice and Theory", "Questions and answers on playing and understanding music.", "music.stackexchange.com_en_all"),
  qa("cooking_stackexchange", "Seasoned Advice", "Questions and answers on cooking.", "cooking.stackexchange.com_en_all"),
  qa("security_stackexchange", "Information Security Stack Exchange", "Questions and answers on information security.", "security.stackexchange.com_en_all"),
  qa("stackoverflow", "Stack Overflow", "Questions and answers on programming.", "stackoverflow.com_en_all"),
  qa("stackoverflow_es", "Stack Overflow en español", "Questions and answers on programming, in Spanish.", "es.stackoverflow.com_mul_all"),
  qa("stackoverflow_ja", "Stack Overflow in Japanese", "Questions and answers on programming, in Japanese.", "ja.stackoverflow.com_mul_all"),
  qa("stackoverflow_pt", "Stack Overflow em Português", "Questions and answers on programming, in Portuguese.", "pt.stackoverflow.com_mul_all"),
  qa("stackoverflow_ru", "Stack Overflow на русском", "Questions and answers on programming, in Russian.", "ru.stackoverflow.com_mul_all"),

  { id: "khanacademy", title: "Khan Academy", summary: "Lessons and videos in math, science, computing and more.", group: "Learning", license: UNSURE, books: ["khanacademy_{lang}_all"] },
  { id: "libretexts", title: "LibreTexts", summary: "Open college textbooks: biology, chemistry, math, physics, medicine, statistics and more.", group: "Learning", license: UNSURE, books: ["libretexts.org_en_*"] },
  { id: "phet", title: "PhET simulations", summary: "Interactive science and math simulations.", group: "Learning", license: "CC BY 4.0", books: ["phet_{lang}_all"] },

  { id: "gutenberg", title: "Project Gutenberg", summary: "Free ebooks: classic literature and other books whose US copyright has ended.", group: "Books", license: "Public domain in the US", books: ["gutenberg_{lang}_all"] },
  { id: "gutenberg_agriculture", title: "Project Gutenberg: agriculture", summary: "Gutenberg's books on agriculture, farming, gardening and keeping animals.", group: "Books", license: "Public domain in the US", books: ["gutenberg_en_lcc-s"] },

  { id: "archwiki", title: "ArchWiki", summary: "Linux documentation from Arch Linux, useful on any distribution.", group: "Technical", license: "GFDL 1.3 or later", books: ["archlinux_en_all"] },
  { id: "devdocs", title: "DevDocs", summary: "Programming documentation: Python, JavaScript, Node.js, TypeScript, Bash, Git, Docker, Rust, Go, CSS, HTML, HTTP, SQLite, PostgreSQL and nginx.", group: "Technical", license: UNSURE, books: DEVDOCS.map((d) => `devdocs_en_${d}`) },
];

const BY_ID = new Map(SOURCES.map((s) => [s.id, s]));
export function sourceById(id: string): Source | undefined { return BY_ID.get(id); }
export function isSourceId(id: unknown): id is string { return typeof id === "string" && BY_ID.has(id); }

/**
 * A source named by its id or title ("wikipedia", "Wikipedia", "stack overflow"), for the assistant's `source`. Null
 * when none matches.
 */
export function findSource(given: string): Source | null {
  const v = given.trim().toLowerCase().replace(/[\s_-]+/g, " ");
  if (!v) return null;
  const plain = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, " ");
  return SOURCES.find((s) => plain(s.id) === v || plain(s.title) === v)
    ?? SOURCES.find((s) => plain(s.title).startsWith(v) || plain(s.id).startsWith(v))
    ?? null;
}

interface Matcher { re: RegExp; byLang: boolean }
const matchers = new Map<string, Matcher>();
function matcher(pattern: string): Matcher {
  let m = matchers.get(pattern);
  if (!m) {
    const esc = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      // A wiki's language code: two or three letters, perhaps with a variant (be-tarask). "mul" (every language in one
      // archive, 250 GB for Gutenberg) is never a language here.
      .replace("\\{lang\\}", "(?!mul_)([a-z]{2,3}(?:-[a-z0-9]+)*)")
      .replace("\\*", "[A-Za-z0-9.-]+");
    m = { re: new RegExp(`^${esc}$`), byLang: pattern.includes("{lang}") };
    matchers.set(pattern, m);
  }
  return m;
}

/** The source a Kiwix book name belongs to, the pattern it matched, and the language code in the name for a `{lang}` pattern. */
export function sourceOfBook(name: string): { source: Source; pattern: string; segment: string | null } | null {
  for (const source of SOURCES) {
    for (const pattern of source.books) {
      const m = matcher(pattern);
      const hit = m.re.exec(name);
      if (hit) return { source, pattern, segment: m.byLang ? hit[1] : null };
    }
  }
  return null;
}
