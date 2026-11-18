#!/usr/bin/env node
/**
 * ultra-research — what a research run knows, how well it knows it, and when it may stop.
 *
 * A research run is a folder `.ultra-research/<date>-<slug>/` holding the report, `research.md`, and nothing else
 * beside `evidence/`. The evidence is a log, `evidence/ledger.jsonl`: the question tree, every source opened, every
 * claim with the verbatim quote that backs it, the disputes, the field map, the reviews, the inputs the user named and
 * the rounds. Each write appends one event under a lock, so researchers working in parallel never lose each other's
 * lines; every read replays the log.
 *
 * A question counts only when it clears the depth bar, and the run scores 1 only when every gate holds as well,
 * the report included. `round` records each round and says what comes next: iterate, wrap-up when the reading
 * budget is spent, done, or escalate at the cap.
 *
 * What the script can check, it checks itself: a quote is read on its page as it is written, by a fetch, a headless
 * browser, a video's captions or the Wayback Machine; voices are counted by author; a run reads within a budget.
 * What only a reader can judge is recorded so that it cannot be skipped: a search against each claim the Answer
 * cites, an audit of each cited quote against its claim, and a review whose every finding is closed.
 */
import { execFile, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

export const VERSION = "3.0.0";
/**
 * The rules a ledger is scored by. A ledger made before rules 2 has no `v` in its init event and keeps the rules
 * it was made under, so an old run still scores what it scored: voices counted by origin, the saturation gate, a
 * review that is one line, no budget.
 */
export const RULES = 2;

export const RUNS_DIR = ".ultra-research";
export const EVIDENCE_DIR = "evidence";
export const LEDGER_FILE = "ledger.jsonl";
export const REPORT_FILE = "research.md";
export const RENDER_FILE = "ledger.md";
export const MAP_FILE = "map.md";
export const ROUNDS_FILE = "rounds.md";
/** The report links the ledger by this path, from beside it in the research folder. */
export const LEDGER_LINK = `${EVIDENCE_DIR}/${RENDER_FILE}`;
export const DEFAULT_CAP = 12;

/** What a source is decides its tier. The agent names the kind and never the tier, so a blog cannot promote itself. */
export const SOURCE_KINDS = {
  spec: "A",
  paper: "A",
  docs: "A",
  code: "A",
  data: "A",
  experiment: "A",
  survey: "B",
  textbook: "B",
  course: "B",
  talk: "B",
  article: "C",
  forum: "C",
  video: "C",
  other: "C",
};
export const CLAIM_KINDS = ["definition", "mechanism", "number", "limit", "comparison", "recommendation", "history", "other"];
export const OUTCOMES = ["upheld", "refuted", "debate"];
export const MIN_QUOTE_WORDS = 5;
/** Each part of a quote around an ellipsis: three words in a row is a phrase, one word is a word every page has. */
export const MIN_QUOTE_PART_WORDS = 3;
/** A question that claims to cover a whole map is a heading, not a question. */
export const MAX_TOPICS_PER_QUESTION = 2;
/** A report section with fewer words than this is a heading with nothing under it. */
export const MIN_SECTION_WORDS = 12;
/** A review read before most of the tree was answered critiques a plan, not the research. */
export const REVIEW_AFTER = 0.75;
const LINE_WINDOW = 15;
const STALE_LOCK_MS = 10000;
const LOCK_WAIT_MS = 30000;
const THIN_PAGE_WORDS = 150;
const DEFAULT_TIMEOUT_MS = 20000;
const EXPERIMENT_TIMEOUT_MS = 300000;
const FETCH_CONCURRENCY = 4;
const MAX_FETCH_BYTES = 64 * 1024 * 1024;
const MAX_PDF_BYTES = 400 * 1024 * 1024;
/** How long a headless browser lets a page's scripts run before its text is taken. */
const BROWSER_BUDGET_MS = 8000;
/** A source no reader could open is not tried again for this long, so one dead page does not stall every claim. */
const FAILED_READ_TTL_MS = 15 * 60 * 1000;
const MIN_PDF_WORDS_PER_PAGE = 8;
const BOT_WALL = /making sure you(?:'|’)?re not a bot|protected by anubis|checking your browser before accessing|just a moment\.\.\.\s*enable javascript and cookies|verify(?:ing)? you are human/i;
/** The share of the source budget kept for closing work: a quote to replace, a probe's hit, a reviewer's finding. */
export const CLOSING_RESERVE = 0.15;
const AUDIT_VERDICTS = ["supports", "partly", "no"];
const DISAGREE = "Where experts disagree";
export const CITED_FILE = "cited.md";
export const CITED_LINK = `${EVIDENCE_DIR}/${CITED_FILE}`;

const ALL_SECTIONS = ["Answer", "Glossary", "Map of the field", "Decision guide", DISAGREE, "Next steps", "Reading path", "Open questions", "Evidence"];

/**
 * `external`: a question needs a source from outside the project, since the agent's own files and runs are one
 * voice at most. `verifiedOnly`: a citation counts only once its quote was found on the page or confirmed by hand.
 * `saturation` is a gate under the first rules and an indicator since. `probe` and `audit` exist since rules 2:
 * every claim the Answer cites was searched against, and every claim cited in the `audit` sections was read
 * against its quote. `maxSources` and `maxQuestions` are the default budget of a run; 0 is no limit.
 */
export const DEPTHS = {
  quick: { sources: 1, primary: 0, external: 0, needs: [], recentYears: 0, verifiedOnly: false, anchored: false, quoteChecks: false, mapTopics: 0, mapSources: 0, saturation: 0, reviews: 0, probe: false, audit: [], maxSources: 12, maxQuestions: 4, report: ["Answer", "Evidence"] },
  standard: {
    sources: 2,
    primary: 1,
    external: 1,
    needs: ["mechanism"],
    recentYears: 0,
    verifiedOnly: false,
    anchored: false,
    quoteChecks: true,
    mapTopics: 3,
    mapSources: 1,
    saturation: 3,
    reviews: 1,
    probe: true,
    audit: ["Answer"],
    maxSources: 60,
    maxQuestions: 15,
    report: ["Answer", "Glossary", "Map of the field", "Decision guide", "Open questions", "Evidence"],
  },
  deep: {
    sources: 3,
    primary: 1,
    external: 1,
    needs: ["mechanism", "limit"],
    recentYears: 5,
    verifiedOnly: true,
    anchored: true,
    quoteChecks: true,
    mapTopics: 6,
    mapSources: 2,
    saturation: 5,
    reviews: 1,
    probe: true,
    audit: ["Answer", "Decision guide"],
    maxSources: 150,
    maxQuestions: 30,
    report: ALL_SECTIONS,
  },
};

/** The bar a depth sets, with the one setting a run may change: how recent its newest source must be. */
export function barFor(depth, recentYears) {
  const preset = DEPTHS[depth];
  if (!preset) throw new Error(`--depth must be one of ${Object.keys(DEPTHS).join(", ")}`);
  return { ...preset, ...(recentYears === undefined ? {} : { recentYears }) };
}

const currentYear = () => new Date().getUTCFullYear();

// ── matching a quote against the text it came from ─────────────────────────────────────────────────────────────

/**
 * Japanese and Chinese are written without spaces, so where a line breaks is not where a word ends: each such
 * character is a word of its own, and a quote matches however its source wrapped the line.
 */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const WORD = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|(?:(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])[\p{L}\p{N}])+/gu;
/** How much a run of words says: a character of an unspaced script is about half a word. */
const weight = (part) => part.reduce((sum, word) => sum + (UNSPACED.test(word) ? 0.5 : 1), 0);

/** A text as its words: markup, punctuation, accents, quote styles and dashes differ between a page and a copy of it. */
export function words(text) {
  return (
    String(text ?? "")
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .replace(/[­​-‍⁠﻿]/g, "")
      .toLowerCase()
      .match(WORD) ?? []
  );
}

/** A quote as the runs of words it is made of: an ellipsis skips words between two runs. */
export const quoteParts = (quote) => String(quote).split(/\.{3}|…/).map(words).filter((part) => part.length);

/** Why a quote cannot back a claim, or null: too short to say anything, or single words stitched by ellipses. */
export function quoteProblem(quote) {
  const parts = quoteParts(quote);
  if (!parts.length || Math.max(...parts.map(weight)) < MIN_QUOTE_WORDS) {
    return `a quote needs at least ${MIN_QUOTE_WORDS} words in a row copied from the source, not a paraphrase`;
  }
  if (parts.some((part) => weight(part) < MIN_QUOTE_PART_WORDS)) return `every part of a quote around an ellipsis needs at least ${MIN_QUOTE_PART_WORDS} words in a row`;
  return null;
}

/** The quote's runs of words appear in the text, in order. */
export function quoteFound(quote, text) {
  const hay = ` ${words(text).join(" ")} `;
  const parts = quoteParts(quote);
  let from = 0;
  for (const part of parts) {
    const at = hay.indexOf(` ${part.join(" ")} `, from);
    if (at < 0) return false;
    from = at + 1;
  }
  return parts.length > 0;
}

const sameWords = (a, b) => words(a).join(" ") === words(b).join(" ");

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ensp: " ", emsp: " ", thinsp: " ", shy: "", zwnj: "", zwj: "",
  mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", laquo: "«", raquo: "»", minus: "−",
  times: "×", divide: "÷", middot: "·", bull: "•", deg: "°", micro: "µ", copy: "©", reg: "®", trade: "™", szlig: "ß",
  aelig: "æ", oelig: "œ", eth: "ð", thorn: "þ", alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", theta: "θ",
  lambda: "λ", mu: "μ", pi: "π", sigma: "σ", tau: "τ", phi: "φ", omega: "ω",
};

/** `&eacute;`, `&Ouml;` and the like: the letter is what matching keeps, since `words` drops accents. */
const ACCENTED = /^([a-z])(acute|grave|circ|uml|tilde|cedil|ring|caron)$/i;

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (match, code) => {
    if (code[0] === "#") {
      const point = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      try {
        return String.fromCodePoint(point);
      } catch {
        return " ";
      }
    }
    if (/^oslash$/i.test(code)) return "ø";
    return ENTITIES[code] ?? ENTITIES[code.toLowerCase()] ?? code.match(ACCENTED)?.[1] ?? match;
  });
}

/** The visible text of an HTML page; scripts and styles are code, not what the page says. */
export function htmlText(html) {
  return decodeEntities(
    String(html)
      .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " "),
  );
}

/** PDF text breaks words across lines with a hyphen; the quote was copied without it. */
const dehyphenate = (text) => text.replace(/(\p{L})-\s*\n\s*(\p{L})/gu, "$1$2");

// ── sources: identity and independence ─────────────────────────────────────────────────────────────────────────

const ARXIV_ID = /\/(?:abs|pdf|html)\/((?:\d{4}\.\d{4,5})|(?:[a-z-]+(?:\.[a-z]{2})?\/\d{7}))(?:v\d+)?(?:\.pdf)?\/?$/i;

/**
 * The URL a source is deduplicated by. The URL the agent gave is the one fetched; this is only its identity, so
 * http and https, tracking parameters, a fragment, and an arXiv paper's abstract, PDF and versions are one page.
 */
export function normalizeUrl(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw new Error(`not a URL: ${raw}`);
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error(`not an http(s) URL: ${raw}`);
  url.protocol = "https:";
  url.hash = "";
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  if (url.hostname === "arxiv.org") {
    const id = url.pathname.match(ARXIV_ID)?.[1];
    if (id) return `https://arxiv.org/abs/${id}`;
  }
  for (const key of [...url.searchParams.keys()]) if (/^utm_|^(fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
  const text = url.toString();
  return url.pathname !== "/" && text.endsWith("/") ? text.slice(0, -1) : text;
}

/** Second-level registries: under these, the name a person registers is the third label. */
const TWO_LEVEL_SUFFIXES = new Set(
  [
    "co.uk org.uk ac.uk gov.uk me.uk ltd.uk com.au net.au org.au edu.au gov.au co.nz org.nz ac.nz co.jp ne.jp or.jp ac.jp go.jp",
    "com.br org.br gov.br com.cn net.cn org.cn edu.cn gov.cn co.in org.in ac.in gov.in co.kr or.kr ac.kr com.tw org.tw edu.tw",
    "com.sg edu.sg gov.sg co.za org.za ac.za com.mx org.mx com.ar com.tr edu.tr com.pl org.pl com.hk edu.hk co.il ac.il com.ua",
    "co.id ac.id com.my edu.my com.ph com.vn edu.vn co.th ac.th",
  ].join(" ").split(" "),
);

function registrable(host) {
  if (/^[\d.]+$/.test(host) || host.includes(":")) return host;
  const labels = host.split(".");
  return labels.slice(labels.length > 2 && TWO_LEVEL_SUFFIXES.has(labels.slice(-2).join(".")) ? -3 : -2).join(".");
}

/** Sites where each account is its own author: two repositories on GitHub are not one source. */
const HOSTING = new Set(["github.com", "gitlab.com", "bitbucket.org", "github.io", "gitlab.io", "medium.com", "substack.com", "dev.to", "hashnode.dev", "blogspot.com", "wordpress.com", "youtube.com", "stackoverflow.com", "stackexchange.com", "reddit.com", "netlify.app", "vercel.app", "pages.dev"]);

function urlOrigin(raw) {
  const url = new URL(raw);
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const first = url.pathname.split("/").filter(Boolean)[0] ?? "";
  if (host === "arxiv.org") return `arxiv:${url.pathname.match(ARXIV_ID)?.[1] ?? first}`;
  if (host === "doi.org" || host === "dx.doi.org") return `doi:${decodeURIComponent(url.pathname.slice(1)).toLowerCase()}`;
  if (host === "web.archive.org") {
    const inner = url.pathname.match(/^\/web\/[^/]+\/(.+)$/)?.[1];
    if (inner) {
      try {
        return urlOrigin(/^https?:/i.test(inner) ? inner : `https://${inner}`);
      } catch {
        // Not a URL inside after all; the archive itself is the origin.
      }
    }
  }
  if (host === "raw.githubusercontent.com" || host === "gist.github.com") return `github.com/${first}`;
  const site = registrable(host);
  if (!HOSTING.has(site)) return site;
  return host !== site ? host : `${site}/${first}`;
}

/**
 * Who stands behind a source, for counting independent ones: two pages of one vendor's docs are one voice, and so
 * are all of the project's own files and all of the run's own experiments. Only a URL source may name its origin
 * (`--origin "PostgreSQL"`), for two domains with one author.
 */
export function originOf(source) {
  if (source.kind === "experiment") return "experiment";
  if (!source.url) return "local";
  return source.origin ?? urlOrigin(source.url);
}

// Since rules 2 a voice is an author, not a web host. Three things decide it:
//   1. A source's site: the paper, talk or video itself on a publisher or video site, else what `urlOrigin` says.
//   2. A source that names no people speaks for its site: all such sources on one site are one voice.
//   3. Two sources that share a person or an organisation are one voice, wherever they are.

const DOI_IN_PATH = /\/(10\.\d{4,9}\/[^\s?#]+?)(?:\.pdf)?(?:\/(?:full|pdf|abstract|epdf|html))?\/?$/i;

/** Venues that publish many authors under one host and give a work no id of its own: each document is its own. */
const VENUES = new Set([
  "advances.realtimerendering.com", "usenix.org", "proceedings.mlr.press", "papers.nips.cc", "proceedings.neurips.cc", "openaccess.thecvf.com",
  "hal.science", "jcgt.org", "diglib.eg.org", "dl.acm.org", "gdcvault.com", "media.gdcvault.com", "ssrn.com", "biorxiv.org", "medrxiv.org",
  "researchgate.net", "semanticscholar.org", "openreview.net", "ieeexplore.ieee.org", "aclanthology.org", "vimeo.com", "slideshare.net",
]);

/** The work itself, where a site gives each work an id: a video, a paper in a digital library, a DOI in the path. */
function itemOrigin(url, host, parts) {
  const param = (name) => url.searchParams.get(name);
  if (/^(?:m\.|music\.)?youtube\.com$/.test(host)) {
    if (parts[0] === "watch" && param("v")) return `youtube:${param("v")}`;
    if (["shorts", "live", "embed"].includes(parts[0]) && parts[1]) return `youtube:${parts[1]}`;
    return null;
  }
  if (host === "youtu.be" && parts[0]) return `youtube:${parts[0]}`;
  if (host === "vimeo.com" && /^\d+$/.test(parts[0] ?? "")) return `vimeo:${parts[0]}`;
  if (host === "openreview.net" && param("id")) return `openreview:${param("id")}`;
  if (host === "ieeexplore.ieee.org" && parts[0] === "document" && parts[1]) return `ieee:${parts[1]}`;
  if (host === "gdcvault.com" && parts[0] === "play" && parts[1]) return `gdcvault:${parts[1]}`;
  if (host === "aclanthology.org" && parts[0]) return `acl:${parts[0].replace(/\.pdf$/i, "").toLowerCase()}`;
  if (host === "pubmed.ncbi.nlm.nih.gov" && parts[0]) return `pmid:${parts[0]}`;
  let pathname = url.pathname;
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    // A path that does not decode is matched as it is.
  }
  const doi = pathname.match(DOI_IN_PATH)?.[1];
  return doi ? `doi:${doi.toLowerCase()}` : null;
}

/** Where a source sits, for telling voices apart: the work on a publisher or video site, else the site's owner. */
export function siteKey(raw) {
  const url = new URL(raw);
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host === "web.archive.org") {
    const inner = url.pathname.match(/^\/web\/[^/]+\/(.+)$/)?.[1];
    if (inner) {
      try {
        return siteKey(/^https?:/i.test(inner) ? `${inner}${url.search}` : `https://${inner}${url.search}`);
      } catch {
        // Not a URL inside after all; the archive itself is the site.
      }
    }
  }
  const item = itemOrigin(url, host, url.pathname.split("/").filter(Boolean));
  if (item) return item;
  if (VENUES.has(host) || VENUES.has(registrable(host))) return `${host}${url.pathname.replace(/\/+$/, "")}`.toLowerCase();
  return urlOrigin(raw);
}

/** Words that say what kind of body an organisation is, not which one: "Godot Engine contributors" is Godot Engine. */
const ORG_NOISE = new Set(["the", "inc", "ltd", "llc", "corp", "corporation", "company", "co", "gmbh", "project", "contributors", "documentation", "docs", "team", "foundation", "group", "official", "authors", "developers", "community"]);

export function orgKey(text) {
  const all = words(text);
  const kept = all.filter((word) => !ORG_NOISE.has(word));
  return (kept.length ? kept : all).join(" ");
}

/** The people in `--authors "Ada Lovelace, Alan Turing"`: first name first, split at commas, semicolons, "and", "&". */
export function peopleOf(text) {
  return String(text ?? "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\bet\s+al\b\.?/gi, " ")
    .split(/[;,&]|\band\b/i)
    .map(words)
    .filter((name) => name.length)
    .map((name) => ({ last: name.at(-1), first: name.length > 1 ? name[0] : "" }));
}

/** "J. Smith" is "John Smith"; "Wei Zhang" is not "Wen Zhang". */
function samePerson(a, b) {
  if (a.last !== b.last) return false;
  if (a.first === b.first) return true;
  return (a.first.length === 1 && b.first.startsWith(a.first)) || (b.first.length === 1 && a.first.startsWith(b.first));
}

/**
 * Who a source is, under rules 2. A source carried over from the first rules has a free-text `origin`, which may
 * be a list of authors or the name of a body; it is read as both, so equal words still mean one voice.
 */
export function identityOf(source) {
  if (source.kind === "experiment") return { site: "experiment", people: [], org: null };
  if (!source.url) return { site: "local", people: [], org: null };
  const legacy = !source.authors && !source.org ? source.origin : null;
  return {
    site: siteKey(source.url),
    people: peopleOf(source.authors ?? legacy),
    org: source.org || legacy ? orgKey(source.org ?? legacy) : null,
  };
}

/** For each source, the voice it belongs to: sources with the same number are one voice. */
export function voiceGroups(sources) {
  const ids = sources.map(identityOf);
  const parent = sources.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const join = (a, b) => {
    parent[find(a)] = find(b);
  };
  const bySite = new Map();
  const byOrg = new Map();
  const byLast = new Map();
  ids.forEach((id, i) => {
    if (!id.people.length) {
      if (bySite.has(id.site)) join(i, bySite.get(id.site));
      else bySite.set(id.site, i);
    }
    if (id.org) {
      if (byOrg.has(id.org)) join(i, byOrg.get(id.org));
      else byOrg.set(id.org, i);
    }
    for (const person of id.people) {
      const known = byLast.get(person.last) ?? [];
      for (const other of known) if (samePerson(person, other.person)) join(i, other.i);
      known.push({ person, i });
      byLast.set(person.last, known);
    }
  });
  return ids.map((_, i) => find(i));
}

/** How many voices a set of sources is. */
const voiceCount = (sources) => new Set(voiceGroups(sources)).size;

/** How a source's author reads in a table: the names given, else the site. */
function voiceLabel(source) {
  if (source.kind === "experiment" || !source.url) return originOf(source);
  const named = [source.authors, source.org].filter(Boolean).join(" — ");
  return named || source.origin || siteKey(source.url);
}

/**
 * Sites that carry sources under different names. Naming an author is how one site holds several voices, and it is
 * also how one author could be counted twice, so the reviewer is told where to look.
 */
function mixedSites(led) {
  const bySite = new Map();
  for (const source of led.sources.values()) {
    if (!source.url) continue;
    const id = identityOf(source);
    const names = `${id.people.map((person) => `${person.first} ${person.last}`).sort().join(", ")}|${id.org ?? ""}`;
    if (!bySite.has(id.site)) bySite.set(id.site, new Map());
    const seen = bySite.get(id.site);
    seen.set(names, [...(seen.get(names) ?? []), source.id]);
  }
  return [...bySite]
    .filter(([, seen]) => seen.size > 1)
    .map(([site, seen]) => `${site} carries ${seen.size} different authors (${[...seen.values()].map((ids) => ids.join("+")).join(", ")}): check that they are different people`);
}

export function yearOf(source) {
  const match = String(source?.date ?? "").match(/^(\d{4})/);
  return match ? Number(match[1]) : null;
}

/** The project a research folder belongs to: the folder holding its `.ultra-research/`. */
function projectRoot(dir) {
  let current = path.resolve(dir);
  while (current !== path.dirname(current)) {
    if (path.basename(current) === RUNS_DIR) return path.dirname(current);
    current = path.dirname(current);
  }
  return null;
}

const projectBase = (dir) => projectRoot(dir) ?? process.cwd();

/** Where a new run goes: the nearest folder up from here that already holds research or is a repository's root. */
export function findProject(start = process.cwd()) {
  for (let current = path.resolve(start); current !== path.dirname(current); current = path.dirname(current)) {
    if (fs.existsSync(path.join(current, RUNS_DIR)) || fs.existsSync(path.join(current, ".git"))) return { root: current, found: true };
  }
  return { root: path.resolve(start), found: false };
}

const evidenceOf = (dir) => path.join(dir, EVIDENCE_DIR);

/** A local path as the agent wrote it, found from the project root, the working directory or the run folder. */
function resolveLocal(file, dir) {
  if (!file) return null;
  const roots = path.isAbsolute(file) ? [""] : [projectBase(dir), process.cwd(), dir];
  for (const root of roots) {
    const candidate = path.resolve(root, file);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** A path as the project sees it, so a later run started with `start --from` finds the same file. */
const projectPath = (absolute, dir) => {
  const relative = path.relative(projectBase(dir), absolute);
  return relative.startsWith("..") ? absolute : relative;
};

const insideRuns = (absolute) => absolute.split(path.sep).includes(RUNS_DIR);
const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");

// ── the log ────────────────────────────────────────────────────────────────────────────────────────────────────

export function readEvents(dir) {
  const file = path.join(evidenceOf(dir), LEDGER_FILE);
  if (!fs.existsSync(file)) throw new Error(`no ${EVIDENCE_DIR}/${LEDGER_FILE} in ${dir}: \`ultra-research.mjs start\` makes a research folder`);
  const events = [];
  const bad = [];
  fs.readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, i) => {
      if (!line.trim()) return;
      try {
        events.push(JSON.parse(line));
      } catch {
        bad.push(`${LEDGER_FILE} line ${i + 1} is not JSON`);
      }
    });
  return { events, bad };
}

/** Events that are research itself: whoever wrote one of these did not read the run with fresh eyes. */
const WRITES = new Set(["source", "topic", "question", "claim", "cite"]);

function applyEvent(led, event) {
  if (event.agent && WRITES.has(event.t)) led.writers.add(String(event.agent));
  const need = (map, id, what) => {
    const item = map.get(id);
    if (!item) throw new Error(`names unknown ${what} ${id}`);
    return item;
  };
  switch (event.t) {
    case "init":
      led.v = event.v ?? 1;
      led.depth = event.depth;
      led.bar = barFor(event.depth, event.recentYears);
      led.from = event.from ?? null;
      led.goal = event.goal ?? null;
      led.cap = event.cap ?? DEFAULT_CAP;
      led.script = event.script ?? null;
      led.langs = event.experimentLangs ?? null;
      // A ledger made under the first rules had no budget, and gets none now.
      led.budget = { sources: event.maxSources ?? 0, questions: event.maxQuestions ?? 0 };
      break;
    case "budget":
      if (event.maxSources !== undefined) led.budget.sources = event.maxSources;
      if (event.maxQuestions !== undefined) led.budget.questions = event.maxQuestions;
      led.budgetChanges.push(event);
      break;
    case "round":
      led.rounds.push(event);
      break;
    case "source":
      led.sources.set(event.id, { ...event, tier: SOURCE_KINDS[event.kind] ?? "C" });
      break;
    case "reclassify":
      Object.assign(need(led.sources, event.source, "source"), {
        kind: event.kind,
        tier: SOURCE_KINDS[event.kind] ?? "C",
        reclassified: event.reason,
        ...(event.origin ? { origin: event.origin } : {}),
        ...(event.authors !== undefined ? { authors: event.authors } : {}),
        ...(event.org !== undefined ? { org: event.org } : {}),
      });
      break;
    case "topic":
      need(led.sources, event.from, "source");
      led.topics.set(event.id, { ...event, parked: null });
      break;
    case "question":
      if (event.parent) need(led.questions, event.parent, "question");
      led.questions.set(event.id, { ...event, topics: event.topics ?? [], needs: event.needs ?? [], parked: null });
      break;
    case "park":
      need(String(event.target).startsWith("T") ? led.topics : led.questions, event.target, "question or topic").parked = event.reason;
      break;
    case "claim":
      need(led.questions, event.question, "question");
      need(led.sources, event.source, "source");
      led.claims.set(event.id, {
        id: event.id,
        question: event.question,
        kind: event.kind,
        text: event.text,
        first: event.source,
        citations: new Map([[event.source, { quote: event.quote, check: null, audit: null, agent: event.agent ?? null }]]),
        status: "live",
        disputes: [],
        probes: [],
        resolution: null,
        inherited: event.inherited === true,
        agent: event.agent ?? null,
      });
      break;
    case "cite": {
      const claim = need(led.claims, event.claim, "claim");
      need(led.sources, event.source, "source");
      // Citing the same words again keeps their check: a quote shown missing stays missing until it changes.
      const before = claim.citations.get(event.source);
      const same = before && before.quote === event.quote;
      claim.citations.set(event.source, { quote: event.quote, check: same ? before.check : null, audit: same ? before.audit : null, agent: event.agent ?? null });
      break;
    }
    case "uncite": {
      const claim = need(led.claims, event.claim, "claim");
      if (!claim.citations.delete(event.source)) throw new Error(`names a citation ${event.claim} does not have (${event.source})`);
      break;
    }
    case "audit": {
      // Like a check, an audit is of these words: a quote the agent has since replaced was not read against the claim.
      const citation = led.claims.get(event.claim)?.citations.get(event.source);
      if (!citation || citation.quote !== event.quote) break;
      // The worst reading stands: a later "supports" does not undo a "no" on the same words.
      const worse = (a, b) => (AUDIT_VERDICTS.indexOf(a) >= AUDIT_VERDICTS.indexOf(b) ? a : b);
      citation.audit = { verdict: citation.audit ? worse(citation.audit.verdict, event.verdict) : event.verdict, by: event.by, note: event.note ?? null };
      break;
    }
    case "probe":
      need(led.claims, event.claim, "claim").probes.push({ query: event.query, found: event.found, note: event.note ?? null, agent: event.agent ?? null });
      break;
    case "check": {
      // A check of a quote the agent has since replaced says nothing about the new one.
      const citation = led.claims.get(event.claim)?.citations.get(event.source);
      if (citation && citation.quote === event.quote) citation.check = { result: event.result, reason: event.reason ?? null, how: event.how ?? null, via: event.via ?? null, at: event.at };
      break;
    }
    case "dispute":
      need(led.claims, event.claim, "claim").disputes.push({ by: event.by, note: event.note, open: true });
      break;
    case "resolve": {
      const claim = need(led.claims, event.claim, "claim");
      for (const dispute of claim.disputes) dispute.open = false;
      claim.resolution = { outcome: event.outcome, note: event.note, by: event.by ?? null };
      if (event.outcome === "refuted") claim.status = "refuted";
      break;
    }
    case "retract": {
      const claim = need(led.claims, event.claim, "claim");
      claim.status = "retracted";
      claim.retracted = event.reason;
      break;
    }
    case "review":
      led.reviews.push({ ...event, id: event.id ?? `R${led.reviews.length + 1}`, clean: event.clean === true, findings: [] });
      break;
    case "finding": {
      const review = led.reviews.find((item) => item.id === event.review);
      if (!review) throw new Error(`names unknown review ${event.review}`);
      const finding = { id: event.id, review: event.review, text: event.text, claim: event.claim ?? null, question: event.question ?? null, closed: null };
      review.findings.push(finding);
      led.findings.set(event.id, finding);
      break;
    }
    case "close":
      need(led.findings, event.finding, "finding").closed = { how: event.how, note: event.note };
      break;
    case "input":
      led.inputs.set(event.key, { ref: event.ref, key: event.key, unreadable: null });
      break;
    case "unreadable":
      need(led.inputs, event.key, "input").unreadable = event.reason;
      break;
    default:
      throw new Error(`has unknown type ${event.t}`);
  }
}

/** The ledger as of its last event. A hand edit that broke an event lands in `errors`, failing the evaluator's pass. */
export function replay(events) {
  const led = {
    v: 1,
    depth: null,
    bar: null,
    goal: null,
    cap: DEFAULT_CAP,
    script: null,
    langs: null,
    budget: { sources: 0, questions: 0 },
    budgetChanges: [],
    sources: new Map(),
    topics: new Map(),
    questions: new Map(),
    claims: new Map(),
    inputs: new Map(),
    findings: new Map(),
    writers: new Set(),
    reviews: [],
    rounds: [],
    errors: [],
  };
  events.forEach((event, i) => {
    try {
      applyEvent(led, event ?? {});
    } catch (err) {
      led.errors.push(`event ${i + 1} (${event?.t ?? "?"}) ${err.message}`);
    }
  });
  if (!led.bar) led.errors.push("no init event: the ledger was not made by `ultra-research.mjs start`");
  return led;
}

export function load(dir) {
  const { events, bad } = readEvents(dir);
  const led = replay(events);
  led.errors.unshift(...bad);
  return led;
}

function append(dir, events) {
  const at = new Date().toISOString();
  fs.appendFileSync(path.join(evidenceOf(dir), LEDGER_FILE), events.map((event) => `${JSON.stringify({ ...event, at })}\n`).join(""));
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * A lock a crashed writer left behind is broken by renaming it aside. Two waiters may both see it stale; the inode
 * says whether the one renamed is still that stale lock or a fresh one another waiter just took, which goes back.
 */
function breakStaleLock(lock) {
  try {
    const stale = fs.statSync(lock);
    if (Date.now() - stale.mtimeMs <= STALE_LOCK_MS) return;
    const aside = `${lock}.stale-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
    fs.renameSync(lock, aside);
    if (fs.statSync(aside).ino === stale.ino) fs.rmSync(aside, { recursive: true, force: true });
    else fs.renameSync(aside, lock);
  } catch {
    // Another waiter broke it first, or its writer released it.
  }
}

/** One writer at a time: a researcher reads the ledger, picks the next id and appends inside the lock. */
function withLock(dir, fn) {
  const lock = path.join(evidenceOf(dir), "ledger.lock");
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      breakStaleLock(lock);
      if (Date.now() > deadline) throw new Error("the ledger is locked by another writer; retry");
      sleep(20);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

/** Read, validate and append under the lock; `build` returns the events to write and what to print. */
function write(dir, build) {
  return withLock(dir, () => {
    const led = load(dir);
    const { events = [], output } = build(led);
    if (events.length) append(dir, events);
    return output;
  });
}

function nextId(led, prefix) {
  if (prefix === "R") return `R${led.reviews.length + 1}`;
  const map = { S: led.sources, T: led.topics, Q: led.questions, C: led.claims, F: led.findings }[prefix];
  return `${prefix}${Math.max(0, ...[...map.keys()].map((id) => Number(String(id).slice(1)) || 0)) + 1}`;
}

// ── judging: the depth bar, the gates, the score ───────────────────────────────────────────────────────────────

const broken = (citation) => ["missing", "dead"].includes(citation.check?.result);
const verified = (citation) => ["found", "manual"].includes(citation.check?.result);
const unique = (items) => [...new Set(items)];
const liveClaims = (led) => [...led.claims.values()].filter((claim) => claim.status === "live");

function parkedReason(led, question) {
  for (let q = question; q; q = q.parent ? led.questions.get(q.parent) : null) if (q.parked) return q.parked;
  return null;
}

/**
 * The citations that still count: on a live claim, with a quote not shown missing from its source. At a depth that
 * counts only verified quotes, an unchecked or unreadable one waits for `check-quotes` or `confirm-quote`.
 */
function countedCitations(led, claims) {
  return claims
    .flatMap((claim) => [...claim.citations].map(([id, citation]) => ({ claim, source: led.sources.get(id), citation })))
    .filter((entry) => entry.source && !broken(entry.citation) && (!led.bar.verifiedOnly || verified(entry.citation)));
}

/** Voices among a question's sources: every tier A or B voice, and at most one more from articles and forums. */
function independentVoices(led, sources) {
  const isStrong = (source) => source.tier !== "C";
  if (led.v < 2) {
    const origins = new Set(sources.filter(isStrong).map(originOf));
    const weak = new Set(sources.filter((source) => !isStrong(source)).map(originOf).filter((origin) => !origins.has(origin)));
    return origins.size + Math.min(1, weak.size);
  }
  const groups = voiceGroups(sources);
  const strong = new Set(groups.filter((_, i) => isStrong(sources[i])));
  const weakOnly = groups.some((group, i) => !isStrong(sources[i]) && !strong.has(group));
  return strong.size + (weakOnly ? 1 : 0);
}

function leafVerdict(led, question, now) {
  const bar = led.bar;
  const gaps = [];
  const claims = liveClaims(led).filter((claim) => claim.question === question.id);
  const cited = countedCitations(led, claims);
  const sources = unique(cited.map((entry) => entry.source));
  const strong = sources.filter((source) => source.tier !== "C");
  // An article or a forum thread may add one voice; it never makes up the count on its own.
  const independent = independentVoices(led, sources);
  const primary = sources.filter((source) => source.tier === "A").length;
  const external = sources.filter((source) => source.url).length;
  const waiting = bar.verifiedOnly ? claims.flatMap((claim) => [...claim.citations.values()]).filter((citation) => !citation.check || citation.check.result === "unverifiable").length : 0;
  if (waiting) gaps.push(`${waiting} citations wait for check-quotes or confirm-quote before they count`);
  if (!strong.length) gaps.push("no tier A or B source (an article or forum post never answers a question alone)");
  if (independent < bar.sources) gaps.push(`${independent}/${bar.sources} independent sources`);
  if (primary < bar.primary) gaps.push(`${primary}/${bar.primary} primary (tier A) sources`);
  if (external < bar.external) gaps.push("no source from outside the project (the project's own files and experiments are one voice)");
  const kinds = new Set(cited.map((entry) => entry.claim.kind));
  for (const kind of unique([...bar.needs, ...question.needs, ...(question.quantitative ? ["number"] : [])])) {
    if (!kinds.has(kind)) gaps.push(`no ${kind} claim`);
  }
  if (question.quantitative && kinds.has("number") && !cited.some((entry) => entry.claim.kind === "number" && entry.source.tier === "A")) {
    gaps.push("no number backed by a tier A source (a measurement, paper, spec or our own experiment)");
  }
  const disputed = claims.filter((claim) => claim.disputes.some((dispute) => dispute.open)).map((claim) => claim.id);
  if (disputed.length) gaps.push(`open dispute on ${disputed.join(", ")}`);
  if (bar.recentYears > 0 && !question.timeless) {
    // A blog post is easy to find for any year; recency must come from a source that carries weight.
    const floor = now.getUTCFullYear() - bar.recentYears + 1;
    const newest = Math.max(-Infinity, ...strong.map(yearOf).filter(Number.isFinite));
    if (newest < floor) gaps.push(`${newest === -Infinity ? "no dated tier A or B source" : `newest tier A or B source is from ${newest}`}; needs one from ${floor} or later, or --timeless`);
  }
  if (bar.anchored && !cited.some((entry) => entry.citation.check?.result === "found")) gaps.push("no quote found on its page by check-quotes (a hand confirmation alone does not anchor it)");
  return { id: question.id, answered: gaps.length === 0, gaps, claims: claims.length, sources: sources.length, independent, primary };
}

function questionVerdicts(led, now) {
  const verdicts = new Map();
  const inScope = [...led.questions.values()].filter((question) => !parkedReason(led, question));
  const verdictOf = (question) => {
    if (verdicts.has(question.id)) return verdicts.get(question.id);
    const children = inScope.filter((child) => child.parent === question.id);
    let verdict;
    if (children.length) {
      // A question with sub-questions is answered by them.
      const waiting = children.filter((child) => !verdictOf(child).answered).map((child) => child.id);
      verdict = { id: question.id, answered: waiting.length === 0, gaps: waiting.length ? [`waits on ${waiting.join(", ")}`] : [], group: true };
    } else {
      verdict = leafVerdict(led, question, now);
    }
    verdicts.set(question.id, verdict);
    return verdict;
  };
  return { inScope, verdicts: inScope.map(verdictOf) };
}

/** Sources that weigh in the field: from outside the project, tier A or B, not carried over from an earlier run. */
const weighty = (source) => source.url && source.tier !== "C" && !source.inherited;

/**
 * How many authors, among the newest tier A and B sources from outside the project, only confirmed what the ledger
 * already held. A source is new information when it started a claim, raised a question or topic, or disputed a
 * claim; one cited by nothing was not shown to be read and counts neither way. Five pages of one site are one author.
 */
export function saturationStreak(led) {
  const novel = new Set([
    ...[...led.claims.values()].map((claim) => claim.first),
    ...[...led.questions.values()].map((question) => question.from),
    ...[...led.topics.values()].map((topic) => topic.from),
    ...[...led.claims.values()].flatMap((claim) => claim.disputes.map((dispute) => dispute.by)),
  ]);
  const citedBy = new Set(liveClaims(led).flatMap((claim) => [...claim.citations].filter(([, citation]) => !broken(citation)).map(([id]) => id)));
  const tail = [];
  for (const source of [...led.sources.values()].reverse()) {
    if (!weighty(source)) continue;
    if (novel.has(source.id)) break;
    if (citedBy.has(source.id)) tail.push(source);
  }
  return led.v < 2 ? new Set(tail.map(originOf)).size : voiceCount(tail);
}

/** The web sources a run opened itself: what its budget counts. A file of the project and an experiment cost no reading. */
const sourcesRead = (led) => [...led.sources.values()].filter((source) => source.url && !source.inherited).length;

const questionsAsked = (led) => [...led.questions.values()].filter((question) => !parkedReason(led, question)).length;

/**
 * Where a run stands against its budget. Reading stops before the budget is spent, so a quote that needs a new
 * source, a probe's hit and a reviewer's finding still have room.
 */
export function budgetOf(led) {
  const max = led.budget.sources;
  const used = sourcesRead(led);
  const readingLimit = max > 0 ? Math.max(1, Math.floor(max * (1 - CLOSING_RESERVE))) : 0;
  return {
    sources: { used, max, readingLimit, spent: max > 0 && used >= readingLimit, full: max > 0 && used >= max },
    questions: { used: questionsAsked(led), max: led.budget.questions, full: led.budget.questions > 0 && questionsAsked(led) >= led.budget.questions },
  };
}

/** The live claims a report cites under the named sections: what a probe and an audit are owed for. */
function claimsCitedIn(led, report, names) {
  const all = sections(visible(report));
  const ids = unique(names.flatMap((name) => claimRefs(sectionNamed(all, name)?.body ?? "")));
  return ids.map((id) => led.claims.get(id)).filter((claim) => claim?.status === "live");
}

const hasSection = (report, name) => Boolean(sectionNamed(sections(visible(report)), name));

/** Every claim the Answer cites was searched against: the last pass tests what the reader will act on. */
function probeProblems(led, report) {
  if (!hasSection(report, "Answer")) return ["research.md has no Answer yet: draft it, then probe each claim it cites"];
  const cited = claimsCitedIn(led, report, ["Answer"]);
  if (!cited.length) return ["the Answer cites no claim yet"];
  const unprobed = cited.filter((claim) => !claim.probes.length).map((claim) => claim.id);
  return unprobed.length ? [`no search for evidence against ${unprobed.join(", ")} (probe --claim <C> --query <words> --found <S>|none)`] : [];
}

/** Every claim cited where the reader decides was read against its quote by someone who did not write it. */
function auditProblems(led, report) {
  const names = led.bar.audit.filter((name) => hasSection(report, name));
  if (!names.length) return [`research.md has no ${led.bar.audit.join(" or ")} section yet: draft it, then audit each claim it cites`];
  const problems = [];
  const waiting = [];
  for (const claim of claimsCitedIn(led, report, names)) {
    const counted = [...claim.citations].filter(([, citation]) => !broken(citation));
    const failed = counted.filter(([, citation]) => citation.audit && citation.audit.verdict !== "supports");
    if (failed.length) problems.push(...failed.map(([source, citation]) => `${claim.id}/${source} was audited "${citation.audit.verdict}": cite words that say the claim, or retract it and record what the quote does say`));
    else if (!counted.some(([, citation]) => citation.audit?.verdict === "supports")) waiting.push(claim.id);
  }
  if (waiting.length) problems.push(`not audited yet: ${waiting.join(", ")} (audit-queue lists them with their quotes)`);
  return problems;
}

/** A review counts when it was taken late enough and nothing it found is left open. */
function reviewState(review) {
  const open = review.findings.filter((finding) => !finding.closed).map((finding) => finding.id);
  return { late: review.answered >= REVIEW_AFTER, open, empty: !review.clean && review.findings.length === 0 };
}

function reviewProblems(led) {
  const bar = led.bar;
  if (led.v < 2) {
    const counted = led.reviews.filter((review) => review.answered >= REVIEW_AFTER).length;
    return counted < bar.reviews ? [`${counted}/${bar.reviews} reviews by a reader who did not write it, taken once ${Math.round(REVIEW_AFTER * 100)}% of the tree was answered`] : [];
  }
  const states = led.reviews.map((review) => ({ review, ...reviewState(review) }));
  const counted = states.filter((state) => state.late && !state.open.length && !state.empty).length;
  if (counted >= bar.reviews) return [];
  const problems = [`${counted}/${bar.reviews} reviews by a reader who did not write it, taken once ${Math.round(REVIEW_AFTER * 100)}% of the tree was answered, with every finding closed`];
  for (const state of states.filter((item) => item.late)) {
    if (state.open.length) problems.push(`${state.review.id} has open findings: ${state.open.join(", ")} (close --finding <F> --how fixed|rejected --note <what was done>)`);
    else if (state.empty) problems.push(`${state.review.id} names no finding: record each with \`finding --review ${state.review.id}\`, or take a review with --clean`);
  }
  return problems;
}

/** An input is read when a source is it and a live claim cites that source; registering a URL is not reading it. */
function inputRead(led, input) {
  const matches = [...led.sources.values()].filter((source) => (source.url ? source.key === input.key : (source.resolved ?? source.path) === input.key));
  return matches.some((source) => liveClaims(led).some((claim) => claim.citations.has(source.id) && !broken(claim.citations.get(source.id))));
}

function gateList(led, report) {
  const bar = led.bar;
  const gates = [];
  const gate = (name, problems) => gates.push({ name, pass: problems.length === 0, problems });
  if (bar.mapTopics > 0) {
    const topics = [...led.topics.values()];
    const questions = [...led.questions.values()];
    const askedInScope = new Set(questions.filter((question) => !parkedReason(led, question)).flatMap((question) => question.topics));
    const askedAtAll = new Set(questions.flatMap((question) => question.topics));
    const asked = topics.filter((topic) => !topic.parked && askedInScope.has(topic.id)).length;
    // The map must come from experts laying out the field: surveys, textbooks, courses, talks, by different authors.
    const mapSources = unique(topics.map((topic) => led.sources.get(topic.from)).filter((source) => source?.url && source.tier === "B"));
    const mapAuthors = led.v < 2 ? new Set(mapSources.map(originOf)).size : voiceCount(mapSources);
    const loose = topics.filter((topic) => !topic.parked && !askedAtAll.has(topic.id)).map((topic) => topic.id);
    gate("map", [
      ...(asked < bar.mapTopics ? [`${asked}/${bar.mapTopics} topics of the field map asked as questions (parked ones do not count)`] : []),
      ...(mapAuthors < bar.mapSources ? [`map drawn from ${mapAuthors}/${bar.mapSources} surveys, textbooks, courses or talks by different authors`] : []),
      ...(loose.length ? [`${loose.join(", ")} neither asked nor parked`] : []),
    ]);
  }
  // Under rules 2 the streak is an indicator: a closing pass could always supply it, so the probe gate took its place.
  if (bar.saturation > 0 && led.v < 2) {
    const streak = saturationStreak(led);
    gate("saturation", streak < bar.saturation ? [`${streak}/${bar.saturation} authors among the newest tier A/B sources added nothing new`] : []);
  }
  const citations = liveClaims(led).flatMap((claim) => [...claim.citations].map(([source, citation]) => ({ claim: claim.id, source, citation })));
  const brokenOnes = citations.filter((entry) => broken(entry.citation)).map((entry) => `${entry.claim}/${entry.source}`);
  const unchecked = bar.quoteChecks ? citations.filter((entry) => !entry.citation.check).length : 0;
  gate("quotes", [
    ...(brokenOnes.length ? [`quote not found at its source: ${brokenOnes.join(", ")} (re-cite with the real words or retract)`] : []),
    ...(unchecked ? [`${unchecked} citations not checked yet (check-quotes)`] : []),
  ]);
  if (led.inputs.size) {
    const pending = [...led.inputs.values()].filter((input) => !input.unreadable && !inputRead(led, input)).map((input) => input.ref);
    gate("inputs", pending.length ? [`named but not read and cited: ${pending.join(", ")}`] : []);
  }
  if (bar.reviews > 0) gate("review", reviewProblems(led));
  if (led.v >= 2 && bar.probe) gate("probe", probeProblems(led, report));
  if (led.v >= 2 && bar.audit.length) gate("audit", auditProblems(led, report));
  gate("report", reportProblems(led, report));
  return gates;
}

const round = (value) => Math.round(value * 1000) / 1000;

/**
 * The evaluator JSON. `pass` is the ledger's integrity — a hand edit that broke it fails the step. `score` counts
 * answered questions and passed gates together, and reaches 1 only when every one holds.
 */
export function evaluate(led, { report = "", now = new Date() } = {}) {
  if (!led.bar) return { pass: false, score: 0, errors: led.errors };
  const { inScope, verdicts } = questionVerdicts(led, now);
  const gates = gateList(led, report);
  const answered = verdicts.filter((verdict) => verdict.answered).length;
  const passed = gates.filter((gate) => gate.pass).length;
  const complete = led.errors.length === 0 && inScope.length > 0 && answered === inScope.length && passed === gates.length;
  const raw = inScope.length ? (answered + passed) / (inScope.length + gates.length) : 0;
  return {
    pass: led.errors.length === 0,
    score: complete ? 1 : Math.min(round(raw), 0.999),
    depth: led.depth,
    answered,
    questions: inScope.length,
    parked: led.questions.size - inScope.length,
    gates: gates.map(({ name, pass, problems }) => ({ name, pass, problems })),
    open: verdicts.filter((verdict) => !verdict.answered).map(({ id, gaps }) => ({ id, gaps })),
    ...(led.v >= 2 ? { budget: budgetOf(led), plan: { open: inScope.length - answered, lacking: verdicts.filter((verdict) => !verdict.answered && !verdict.group).reduce((sum, verdict) => sum + Math.max(0, led.bar.sources - verdict.independent), 0) }, ...(led.bar.saturation > 0 ? { saturation: { streak: saturationStreak(led), of: led.bar.saturation } } : {}) } : {}),
    ...(led.v >= 2 && mixedSites(led).length ? { warnings: mixedSites(led) } : {}),
    ...(led.errors.length ? { errors: led.errors } : {}),
  };
}

// ── the report ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The report: research.md is the report and nothing else, so all of it is read. */
export function reportBody(dir) {
  const file = path.join(dir, REPORT_FILE);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

/** What a reader sees: a comment or a code block is not where a report says anything. */
const visible = (text) =>
  String(text)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, " ");

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Each heading's body, up to the next heading of the same or a higher level. */
function sections(text) {
  const lines = text.split("\n");
  const found = [];
  lines.forEach((line, i) => {
    const match = line.match(/^(#{1,6})\s+(.*)$/);
    if (match) found.push({ level: match[1].length, title: match[2].trim(), start: i });
  });
  return found.map((heading, k) => {
    const end = found.slice(k + 1).find((next) => next.level <= heading.level)?.start ?? lines.length;
    return { ...heading, body: lines.slice(heading.start + 1, end).join("\n") };
  });
}

function sectionNamed(all, name) {
  const re = new RegExp(`^(?:\\d+[.)]\\s*)?${escapeRe(name)}\\b`, "i");
  return all.find((section) => re.test(section.title)) ?? null;
}

/**
 * Claim ids the report cites: a bracket holding only claim ids, as `[C3]`, `[C3, C7]` or the link `[C3](ledger.md#c3)`.
 * A bracket with other words in it, such as a C language standard, is not a citation.
 */
export function claimRefs(text) {
  return unique([...String(text).matchAll(/\[\s*(C\d+(?:\s*[,;]\s*C\d+)*)\s*\]/g)].flatMap((match) => match[1].split(/[,;]/).map((id) => id.trim())));
}

/** What keeps the report from teaching the field: a section missing or empty, a dead reference, a question left out. */
export function reportProblems(led, raw) {
  if (!led.bar) return led.errors;
  const text = visible(raw);
  if (!text.trim()) return [`${REPORT_FILE} has no report yet (references/report.md)`];
  const problems = [];
  const all = sections(text);
  const debates = liveClaims(led).filter((claim) => claim.resolution?.outcome === "debate");
  const required = unique([...led.bar.report, ...(debates.length ? [DISAGREE] : [])]);
  for (const name of required) {
    const section = sectionNamed(all, name);
    if (!section) problems.push(`no "${name}" section`);
    else if (words(section.body).length < MIN_SECTION_WORDS) problems.push(`the "${name}" section is nearly empty`);
  }
  const refs = claimRefs(text);
  for (const id of refs) {
    const claim = led.claims.get(id);
    if (!claim) problems.push(`cites ${id}, which is not in the ledger`);
    else if (claim.status !== "live") problems.push(`cites ${id}, which was ${claim.status}`);
  }
  const cited = new Set(refs);
  const inScope = [...led.questions.values()].filter((question) => !parkedReason(led, question));
  const parents = new Set(inScope.map((question) => question.parent).filter(Boolean));
  for (const question of inScope.filter((q) => !parents.has(q.id))) {
    const claims = liveClaims(led).filter((claim) => claim.question === question.id);
    if (claims.length && !claims.some((claim) => cited.has(claim.id))) problems.push(`no claim of ${question.id} is cited in the report`);
  }
  const disagree = sectionNamed(all, DISAGREE);
  for (const claim of debates) {
    if (!disagree || !claimRefs(disagree.body).includes(claim.id)) problems.push(`the open debate on ${claim.id} is not cited under "${DISAGREE}"`);
  }
  for (const input of led.inputs.values()) {
    if (input.unreadable && !text.includes(input.ref)) problems.push(`the unread input ${input.ref} is not named in the report`);
  }
  const evidence = sectionNamed(all, "Evidence")?.body ?? "";
  if (led.depth !== "quick" && !evidence.includes(LEDGER_LINK)) problems.push(`the Evidence section does not link ${LEDGER_LINK}`);
  // A quote no script could read rests on the agent's word, so the reader is told which.
  const unchecked = liveClaims(led).filter((claim) => [...claim.citations.values()].some((citation) => ["manual", "unverifiable"].includes(citation.check?.result)));
  const unnamed = unchecked.filter((claim) => !new RegExp(`\\b${claim.id}\\b`).test(evidence)).map((claim) => claim.id);
  if (unnamed.length) problems.push(`the Evidence section does not name ${unnamed.join(", ")}, whose quotes no script could check`);
  return problems;
}

// ── checking quotes against their sources ──────────────────────────────────────────────────────────────────────

/** A GitHub file page is mostly script; its raw twin is the file itself. */
function fetchable(url) {
  const match = String(url).match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+?)(?:#.*)?$/);
  return match ? `https://raw.githubusercontent.com/${match[1]}/${match[2]}/${match[3]}` : url;
}

function pdfText(buffer) {
  const run = spawnSync("pdftotext", ["-q", "-", "-"], { input: buffer, maxBuffer: 256 * 1024 * 1024 });
  return run.status === 0 ? run.stdout.toString("utf8") : null;
}

function decodeBody(buffer, type) {
  const declared = type.match(/charset=["']?([\w-]+)/i)?.[1] ?? buffer.subarray(0, 4096).toString("latin1").match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1] ?? "utf-8";
  try {
    return new TextDecoder(declared).decode(buffer);
  } catch {
    return buffer.toString("utf8");
  }
}

const execFileP = promisify(execFile);

/** The readers a quote check may use, in the order it tries them. ULTRA_RESEARCH_READERS narrows the list. */
const READERS = ["captions", "fetch", "browser", "archive"];

function enabledReaders() {
  const raw = process.env.ULTRA_RESEARCH_READERS;
  if (raw === undefined) return new Set(READERS);
  return new Set(raw.split(",").map((name) => name.trim()).filter((name) => READERS.includes(name)));
}

/** A program on the PATH, or the one an environment variable names. */
function findTool(variable, names) {
  const named = process.env[variable];
  if (named) return fs.existsSync(named) ? named : null;
  for (const folder of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = path.join(folder, name);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // Not here; try the next one.
      }
    }
  }
  return null;
}

/** A page is asked for the way a browser asks, since many sites answer 403 or 406 to anything else. */
const PAGE_HEADERS = {
  "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.9,text/plain;q=0.8,*/*;q=0.7",
  "accept-language": "en-US,en;q=0.9",
};

/** The text of a slide deck or a document, speaker notes included: an Office file is a zip of XML. */
function officeText(buffer) {
  const unzip = findTool("ULTRA_RESEARCH_UNZIP", ["unzip"]);
  if (!unzip) return null;
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "ultra-research-office-"));
  try {
    const file = path.join(folder, "file.zip");
    fs.writeFileSync(file, buffer);
    const run = spawnSync(unzip, ["-p", file, "ppt/slides/*.xml", "ppt/notesSlides/*.xml", "word/document.xml", "word/footnotes.xml"], { maxBuffer: 256 * 1024 * 1024 });
    // unzip exits 11 when one of the patterns matched nothing, which every deck and every document does.
    if (![0, 11].includes(run.status) || !run.stdout.length) return null;
    return decodeEntities(run.stdout.toString("utf8").replace(/<\/a:p>|<\/w:p>/g, "\n").replace(/<[^>]+>/g, " "));
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
}

/** What a response says, as text: a page, a PDF, a deck. A reader returns the text or why it has none. */
async function responseText(response, url) {
  if (response.status === 404 || response.status === 410) return { result: "dead", reason: `HTTP ${response.status}` };
  if (!response.ok) return { result: "unverifiable", reason: `HTTP ${response.status}` };
  const type = response.headers.get("content-type") ?? "";
  // A slide deck of hundreds of MB cannot be decoded as one string. A PDF goes to pdftotext as a buffer, so it may be larger.
  const limit = /pdf|octet-stream/i.test(type) ? MAX_PDF_BYTES : MAX_FETCH_BYTES;
  const declared = Number(response.headers.get("content-length") ?? 0);
  const media = /image\/|video\/|audio\//i.test(type);
  if (declared > limit || media) {
    await response.body?.cancel().catch(() => {});
    return { result: "unverifiable", file: true, reason: media ? `a media file (${type}) holds no text to check` : `too large to read (${Math.round(declared / 1048576)} MB)` };
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const head = buffer.subarray(0, 5).toString("latin1");
  if (buffer.length > (head === "%PDF-" ? MAX_PDF_BYTES : MAX_FETCH_BYTES)) return { result: "unverifiable", reason: `too large to read (${Math.round(buffer.length / 1048576)} MB)` };
  if (/pdf/i.test(type) || head === "%PDF-") {
    const text = pdfText(buffer);
    if (text === null) return { result: "unverifiable", file: true, reason: "PDF (install pdftotext to check it)" };
    // Scanned pages and slides with outlined type have no text to read, whatever a few page numbers say.
    const pages = (text.match(/\f/g) ?? []).length;
    if (pages >= 3 && weight(words(text)) / pages < MIN_PDF_WORDS_PER_PAGE) return { result: "unverifiable", file: true, reason: "a PDF with almost no text layer (scanned pages or outlined slides)" };
    return { text, pdf: true };
  }
  if (head.startsWith("PK\x03\x04")) {
    const text = officeText(buffer);
    return text === null ? { result: "unverifiable", file: true, reason: "an Office or zip file the script could not read (install unzip to check a .pptx or .docx)" } : { text };
  }
  const body = decodeBody(buffer, type);
  const text = /html|xml/i.test(type) || /^\s*</.test(body) ? htmlText(body) : body;
  if (BOT_WALL.test(text) && words(text).length < 2000) return { result: "unverifiable", reason: "a bot-check page answered instead of the source" };
  return { text, url };
}

async function fetchReader(url, timeoutMs) {
  try {
    const response = await fetch(fetchable(url), { redirect: "follow", signal: AbortSignal.timeout(timeoutMs), headers: PAGE_HEADERS });
    return await responseText(response, url);
  } catch (err) {
    return { result: "unverifiable", reason: `fetch failed (${err.cause?.code ?? err.name})` };
  }
}

/** A page drawn by JavaScript has its text only after its scripts ran: a headless browser, with a profile of its own. */
async function browserReader(url, timeoutMs) {
  const browser = findTool("ULTRA_RESEARCH_BROWSER", ["chromium", "chromium-browser", "google-chrome-stable", "google-chrome", "chrome"]);
  if (!browser) return { result: "unverifiable", reason: "no headless browser found (chromium or chrome reads a page drawn by JavaScript)" };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ultra-research-browser-"));
  try {
    const flags = ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-sync", "--disable-background-networking", "--mute-audio", `--user-data-dir=${profile}`, `--virtual-time-budget=${BROWSER_BUDGET_MS}`, "--dump-dom"];
    const { stdout } = await execFileP(browser, [...flags, url], { timeout: timeoutMs + BROWSER_BUDGET_MS, maxBuffer: 128 * 1024 * 1024, killSignal: "SIGKILL" });
    const text = htmlText(stdout);
    if (BOT_WALL.test(text) && words(text).length < 2000) return { result: "unverifiable", reason: "a bot-check page answered instead of the source" };
    return { text, url };
  } catch (err) {
    return { result: "unverifiable", reason: `the headless browser failed (${err.killed ? "timeout" : (err.code ?? err.name)})` };
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

/** An address on this machine or this network is nobody else's business, and no archive holds it. */
function privateHost(raw) {
  const host = new URL(raw).hostname.toLowerCase();
  return host === "localhost" || !host.includes(".") || /\.(local|internal|lan|home|test|localhost)$/.test(host) || /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || host.includes(":");
}

const isArchived = (raw) => new URL(raw).hostname.toLowerCase() === "web.archive.org";

/** A page that is gone, or that no reader could open, may still stand in the Wayback Machine as it was. */
async function archiveReader(url, timeoutMs) {
  const base = process.env.ULTRA_RESEARCH_ARCHIVE;
  if (!base && privateHost(url)) return { result: "unverifiable", reason: "a private address, not asked of the archive" };
  const page = await fetchReader(`${base ?? "https://web.archive.org"}/web/2id_/${url}`, timeoutMs);
  if (page.text === undefined) return { result: "unverifiable", reason: page.result === "dead" ? "no archived copy" : `the archive: ${page.reason}` };
  return { ...page, url };
}

const isVideo = (raw) => /^youtube:/.test(siteKey(raw));

/** Captions as running text: no cue numbers, no timings, no markup, and no line said twice in a row. */
export function captionText(vtt) {
  const lines = [];
  for (const raw of String(vtt).split(/\r?\n/)) {
    const line = decodeEntities(raw.replace(/<[^>]+>/g, "")).trim();
    if (!line || line.includes("-->") || /^(WEBVTT|NOTE|STYLE|REGION|Kind:|Language:)/.test(line) || /^\d+$/.test(line)) continue;
    if (lines.at(-1) !== line) lines.push(line);
  }
  return lines.join(" ");
}

/** What is said in a talk is in its captions, not on its page. */
async function captionsReader(url, timeoutMs) {
  const tool = findTool("ULTRA_RESEARCH_YTDLP", ["yt-dlp"]);
  if (!tool) return { result: "unverifiable", reason: "yt-dlp not found (it reads what a video says from its captions)" };
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "ultra-research-captions-"));
  try {
    let failure = null;
    try {
      // The spoken track in its own language (`<lang>-orig`), and the English one: two requests, not one per language.
      const flags = ["--skip-download", "--write-subs", "--write-auto-subs", "--sub-langs", ".*-orig,en", "--sub-format", "vtt", "--sleep-subtitles", "1", "--ignore-errors", "--no-playlist", "--no-warnings", "--quiet"];
      await execFileP(tool, [...flags, "-o", path.join(folder, "%(id)s.%(ext)s"), url], { timeout: Math.max(timeoutMs, 60000), maxBuffer: 16 * 1024 * 1024, killSignal: "SIGKILL" });
    } catch (err) {
      // One track that could not be fetched fails the command, though another may be on disk.
      failure = err.killed ? "timeout" : String(err.stderr ?? "").trim().split("\n").at(-1).replace(/^ERROR:\s*/, "").slice(0, 120) || String(err.code ?? err.name);
    }
    const tracks = fs.readdirSync(folder).filter((name) => name.endsWith(".vtt")).sort();
    const text = tracks.map((name) => captionText(fs.readFileSync(path.join(folder, name), "utf8"))).join("\n");
    if (words(text).length) return { text };
    return { result: "unverifiable", reason: failure ? `yt-dlp failed (${failure})` : "the video has no captions" };
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
}

const READ = { captions: captionsReader, fetch: fetchReader, browser: browserReader, archive: archiveReader };

const pagesOf = (dir) => path.join(evidenceOf(dir), "pages");

/** Saved pages are other people's text, kept to check quotes against and never committed. */
function pageFile(dir, source, via, kind) {
  const folder = pagesOf(dir);
  if (!fs.existsSync(folder)) {
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, ".gitignore"), "*\n");
  }
  return path.join(folder, `${source.id}-${sha256(source.key ?? source.url).slice(0, 12)}.${via}.${kind}`);
}

/**
 * One reader's text of a source, from the copy saved in evidence/pages/ when there is one. A reader that failed
 * is not asked again for a while. `refresh` reads the page anew.
 */
async function readWith(via, source, dir, { timeoutMs, refresh }) {
  const saved = pageFile(dir, source, via, "txt");
  const savedPdf = pageFile(dir, source, via, "pdf.txt");
  const failed = pageFile(dir, source, via, "fail");
  if (!refresh) {
    if (fs.existsSync(saved)) return { text: fs.readFileSync(saved, "utf8"), url: source.url };
    if (fs.existsSync(savedPdf)) return { text: fs.readFileSync(savedPdf, "utf8"), pdf: true };
    if (fs.existsSync(failed) && Date.now() - fs.statSync(failed).mtimeMs < FAILED_READ_TTL_MS) return JSON.parse(fs.readFileSync(failed, "utf8"));
  }
  const page = await READ[via](source.url, timeoutMs);
  for (const file of [saved, savedPdf, failed]) fs.rmSync(file, { force: true });
  if (page.text === undefined) fs.writeFileSync(failed, JSON.stringify({ result: page.result, reason: page.reason, ...(page.file ? { file: true } : {}) }));
  else fs.writeFileSync(page.pdf ? savedPdf : saved, page.text);
  return page;
}

/** The saved text of a source, for showing an auditor the words around a quote. */
function savedText(dir, source) {
  if (!source.url) return localText(source, dir).text ?? null;
  const folder = pagesOf(dir);
  if (!fs.existsSync(folder)) return null;
  const mine = fs.readdirSync(folder).filter((name) => name.startsWith(`${source.id}-`) && name.endsWith(".txt"));
  return mine.length ? mine.map((name) => fs.readFileSync(path.join(folder, name), "utf8")).join("\n") : null;
}

/**
 * Each quote against its source, by every reader that can open it, until one finds the words. A quote is missing
 * only when a reader had the page's text and the words were not in it; a page nobody could read is unverifiable.
 */
async function judgeCitations(dir, source, quotes, { timeoutMs = DEFAULT_TIMEOUT_MS, refresh = false } = {}) {
  if (!source.url) {
    const page = localText(source, dir);
    return quotes.map((quote) => judgeQuote(quote, page));
  }
  const on = enabledReaders();
  const order = [...(isVideo(source.url) ? ["captions"] : []), "fetch", "browser", ...(isArchived(source.url) ? [] : ["archive"])].filter((via) => on.has(via));
  // What a talk says is in its captions: its page can hold a quote, and can never show that one is missing.
  const decides = (via) => !isVideo(source.url) || via === "captions";
  const verdicts = quotes.map(() => null);
  const notes = [];
  let readable = false;
  let gone = null;
  let file = false;
  for (const via of order) {
    if (verdicts.every(Boolean)) break;
    // A page that answered 404 is gone for a browser too, a file is nothing a browser draws, and a page whose
    // text was read has no older self to ask.
    if ((via === "browser" && (gone || file)) || (via === "archive" && readable)) continue;
    const page = await readWith(via, source, dir, { timeoutMs, refresh });
    if (page.text === undefined) {
      if (page.result === "dead") gone = page.reason;
      if (page.file) file = true;
      notes.push(`${via}: ${page.reason}`);
      continue;
    }
    const thin = weight(words(page.text)) < THIN_PAGE_WORDS;
    if (thin) notes.push(`${via}: almost no text${via === "captions" ? "" : " (likely drawn by JavaScript)"}`);
    else if (decides(via)) readable = true;
    else notes.push(`${via}: the page does not hold what the video says`);
    quotes.forEach((quote, i) => {
      if (verdicts[i]) return;
      const verdict = judgeQuote(quote, { ...page, thin: false });
      if (verdict.result === "found") verdicts[i] = { result: "found", ...(via === "fetch" ? {} : { via }) };
      // A page that says its own address back says whatever it was asked.
      else if (verdict.result === "unverifiable") verdicts[i] = verdict;
    });
  }
  return verdicts.map((verdict) => {
    if (verdict) return verdict;
    if (readable) return { result: "missing", reason: "the quote is not in the source" };
    if (gone) return { result: "dead", reason: `${gone}${notes.some((note) => note.startsWith("archive")) ? "; no archived copy holds it" : ""}` };
    return { result: "unverifiable", reason: `${notes.join("; ") || "no reader is enabled"}; confirm it by hand` };
  });
}

function localText(source, dir) {
  if (source.kind === "experiment") {
    if (source.path && !resolveLocal(source.resolved ?? source.path, dir)) return { result: "dead", reason: `the experiment's script ${source.path} is gone` };
    const output = resolveLocal(source.output, dir);
    if (!output) return { result: "dead", reason: `the experiment's output ${source.output} is gone` };
    const text = fs.readFileSync(output, "utf8");
    // The ledger wrote this file from the run; a different file is not what the run printed.
    if (source.hash && sha256(text) !== source.hash) return { result: "dead", reason: "the experiment's output was edited after the run; run it again" };
    return { text };
  }
  const file = resolveLocal(source.resolved ?? source.path, dir);
  if (!file) return { result: "dead", reason: `${source.path} not found` };
  const text = fs.readFileSync(file, "utf8");
  if (!source.line) return { text };
  const lines = text.split(/\r?\n/);
  return { text: lines.slice(Math.max(0, source.line - 1 - LINE_WINDOW), source.line + LINE_WINDOW).join("\n") };
}

function judgeQuote(quote, page) {
  if (page.text === undefined) return { result: page.result, reason: page.reason };
  if (!quoteFound(quote, page.text) && !(page.pdf && quoteFound(quote, dehyphenate(page.text)))) {
    if (page.thin !== false && weight(words(page.text)) < THIN_PAGE_WORDS) return { result: "unverifiable", reason: "the source has almost no text (likely drawn by JavaScript); confirm it by hand" };
    return { result: "missing", reason: "the quote is not in the source" };
  }
  // A search page, or a "not found" page that repeats its address, says back whatever the URL asked it.
  if (page.url && quoteFound(quote, safeDecode(page.url))) return { result: "unverifiable", reason: "the quote is in the URL itself, so the page may only be echoing it" };
  return { result: "found" };
}

function safeDecode(url) {
  try {
    return decodeURIComponent(String(url).replace(/\+/g, " "));
  } catch {
    return String(url);
  }
}

async function pool(items, size, fn) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(size, queue.length) }, async () => {
      while (queue.length) await fn(queue.shift());
    }),
  );
}

// ── rendering ──────────────────────────────────────────────────────────────────────────────────────────────────

const cell = (text) => String(text ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

function where(source) {
  if (source.url) return `[${cell(source.title)}](${source.url})`;
  if (source.kind === "experiment") return `${cell(source.title)} — \`${cell(source.command)}\` → \`${source.output}\``;
  return `${cell(source.title)} — \`${source.path}${source.line ? `:${source.line}` : ""}\``;
}

const generated = (verdict, led) => `Rendered from \`${LEDGER_FILE}\` by ultra-research.mjs — depth **${led.depth}**, score ${verdict.score}, ${verdict.answered}/${verdict.questions} questions answered. Do not edit by hand.`;

/** Where a run stands against its budget, in one line. */
function budgetLine(verdict) {
  const { sources, questions } = verdict.budget;
  const parts = [];
  if (sources.max) parts.push(`${sources.used}/${sources.max} web sources (reading stops at ${sources.readingLimit})${sources.full ? " — spent" : sources.spent ? " — reading budget spent, closing work only" : ""}`);
  if (questions.max) parts.push(`${questions.used}/${questions.max} questions`);
  if (verdict.plan?.lacking) parts.push(`open questions still lack ${verdict.plan.lacking} independent sources between them`);
  return parts.join(" · ");
}

/** One claim's citations as a reader checks them: the source, the words, and what each check and audit said. */
function citationLines(led, claim) {
  const lines = [];
  for (const [id, citation] of claim.citations) {
    const source = led.sources.get(id);
    if (!source) continue;
    const check = citation.check
      ? `${citation.check.result}${citation.check.via ? ` (read by ${citation.check.via})` : ""}${citation.check.reason ? ` (${citation.check.reason})` : ""}${citation.check.how ? ` — ${citation.check.how}` : ""}`
      : "not checked";
    const audit = citation.audit ? `; audit: ${citation.audit.verdict} — ${citation.audit.by}${citation.audit.note ? ` (${citation.audit.note})` : ""}` : "";
    lines.push(`- **${id}** tier ${source.tier}, ${source.date ?? "undated"} — ${where(source)}`, `  > ${citation.quote.replace(/\n/g, " ")}`, `  quote check: ${check}${audit}`);
  }
  return lines;
}

export function render(led, { report = "", now = new Date() } = {}) {
  const verdict = evaluate(led, { report, now });
  const byId = new Map(questionVerdicts(led, now).verdicts.map((v) => [v.id, v]));
  const lines = [`# Research ledger`, "", ...(led.goal ? [`**Goal:** ${led.goal}`, ""] : []), generated(verdict, led), "", `The field map and the question tree are in [${MAP_FILE}](${MAP_FILE}), the rounds in [${ROUNDS_FILE}](${ROUNDS_FILE}), and the claims the report cites in [${CITED_FILE}](${CITED_FILE}).`, ""];
  const budget = verdict.budget ? budgetLine(verdict) : "";
  if (budget) lines.push(`**Budget:** ${budget}`, "");
  for (const change of led.budgetChanges) lines.push(`- budget changed${change.maxSources === undefined ? "" : ` to ${change.maxSources} web sources`}${change.maxQuestions === undefined ? "" : ` to ${change.maxQuestions} questions`}: ${change.reason}`);
  if (led.budgetChanges.length) lines.push("");
  lines.push("## Gates", "", "| Gate | Holds | What is missing |", "|---|---|---|");
  for (const gate of verdict.gates) lines.push(`| ${gate.name} | ${gate.pass ? "yes" : "no"} | ${cell(gate.problems.join("; "))} |`);
  if (verdict.saturation) lines.push("", `Saturation (an indicator, not a gate): ${verdict.saturation.streak}/${verdict.saturation.of} authors among the newest tier A/B sources added nothing new.`);
  if (verdict.warnings?.length) {
    lines.push("", "## To check by eye", "");
    for (const warning of verdict.warnings) lines.push(`- ${warning}`);
  }
  lines.push("", "## Questions", "", "| Question | Answered | What is missing |", "|---|---|---|");
  for (const question of led.questions.values()) {
    const parked = parkedReason(led, question);
    const v = byId.get(question.id);
    lines.push(`| **${question.id}** ${cell(question.text)}${question.parent ? ` (under ${question.parent})` : ""} | ${parked ? "parked" : v.answered ? "yes" : "no"} | ${cell(parked ?? v.gaps.join("; "))} |`);
  }
  lines.push("", "## Claims");
  for (const question of led.questions.values()) {
    const claims = [...led.claims.values()].filter((claim) => claim.question === question.id);
    if (!claims.length) continue;
    lines.push("", `### ${question.id} — ${question.text}`);
    for (const claim of claims) {
      lines.push("", `#### ${claim.id}`, "", `*${claim.kind}${claim.status === "live" ? "" : `, ${claim.status}`}* — ${claim.text}${claim.agent ? ` (by ${claim.agent})` : ""}`, "");
      lines.push(...citationLines(led, claim));
      for (const dispute of claim.disputes) lines.push(`- disputed by ${dispute.by}: ${dispute.note}${dispute.open ? " — **open**" : ""}`);
      if (claim.resolution) lines.push(`- resolved: **${claim.resolution.outcome}**${claim.resolution.by ? ` by ${claim.resolution.by}` : ""} — ${claim.resolution.note}`);
      for (const probe of claim.probes) lines.push(`- searched against: "${probe.query}" — ${probe.found === "none" ? "nothing against it" : `found ${probe.found}`}`);
      if (claim.retracted) lines.push(`- retracted: ${claim.retracted}`);
    }
  }
  lines.push("", "## Sources", "", `| ID | Tier | Kind | Date | ${led.v < 2 ? "Origin" : "Author or site"} | Source |`, "|---|---|---|---|---|---|");
  for (const source of led.sources.values()) {
    const notes = [source.inherited ? "from an earlier run" : "", source.reclassified ? `reclassified: ${source.reclassified}` : "", led.v < 2 && source.origin && source.url ? "origin named by the agent" : ""].filter(Boolean).join("; ");
    lines.push(`| ${source.id} | ${source.tier} | ${source.kind} | ${source.date ?? "—"} | ${cell(led.v < 2 ? originOf(source) : voiceLabel(source))} | ${where(source)}${notes ? ` (${cell(notes)})` : ""} |`);
  }
  if (led.inputs.size) {
    lines.push("", "## Inputs the user named", "");
    for (const input of led.inputs.values()) lines.push(`- ${input.ref} — ${input.unreadable ? `**not read**: ${input.unreadable}` : inputRead(led, input) ? "read and cited" : "**not read yet**"}`);
  }
  const parked = [...led.questions.values(), ...led.topics.values()].filter((item) => item.parked);
  if (parked.length) {
    lines.push("", "## Parked", "");
    for (const item of parked) lines.push(`- **${item.id}** ${item.text} — ${item.parked}`);
  }
  if (led.reviews.length) {
    lines.push("", "## Reviews", "");
    for (const review of led.reviews) {
      lines.push(`- **${review.id}** ${review.by} (at ${Math.round(review.answered * 100)}% answered${review.clean ? ", clean" : ""}): ${review.note}`);
      for (const finding of review.findings) {
        const about = [finding.claim, finding.question].filter(Boolean).join(", ");
        lines.push(`  - **${finding.id}**${about ? ` (${about})` : ""} ${finding.text} — ${finding.closed ? `*${finding.closed.how}*: ${finding.closed.note}` : "**open**"}`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

/**
 * What the report cites, and nothing else: each claim with the words that back it and where they stand. The whole
 * ledger can run to a megabyte; this is the part a reader needs to check a fact.
 */
export function renderCited(led, report) {
  const ids = claimRefs(visible(report)).filter((id) => led.claims.has(id)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  const lines = ["# What the report cites", "", `Each claim \`${REPORT_FILE}\` cites, with the words that back it and where they stand. Rendered from \`${LEDGER_FILE}\`; do not edit by hand. The whole ledger is in [${RENDER_FILE}](${RENDER_FILE}).`];
  if (!ids.length) lines.push("", "The report cites no claim yet.");
  for (const id of ids) {
    const claim = led.claims.get(id);
    lines.push("", `<a id="${id.toLowerCase()}"></a>`, "", `### ${id}`, "", `*${claim.kind}${claim.status === "live" ? "" : `, ${claim.status}`}* — ${claim.text}`, "", ...citationLines(led, claim));
    if (claim.resolution?.outcome === "debate") lines.push(`- experts disagree: ${claim.resolution.note}`);
  }
  return `${lines.join("\n")}\n`;
}

/** `[C3, C7]` as links into evidence/cited.md. Code blocks are left alone, and so is an id the ledger does not hold. */
export function linkClaims(led, text) {
  let linked = 0;
  let fence = null;
  const lines = String(text).split("\n").map((line) => {
    const mark = line.match(/^\s*(`{3,}|~{3,})/)?.[1][0];
    if (mark) {
      if (!fence) fence = mark;
      else if (fence === mark) fence = null;
      return line;
    }
    if (fence) return line;
    return line.replace(/\[\s*(C\d+(?:\s*[,;]\s*C\d+)*)\s*\](?!\()/g, (match, ids) => {
      const list = ids.split(/[,;]/).map((id) => id.trim());
      if (!list.every((id) => led.claims.has(id))) return match;
      linked += list.length;
      return list.map((id) => `[${id}](${CITED_LINK}#${id.toLowerCase()})`).join(", ");
    });
  });
  return { text: lines.join("\n"), linked };
}

const MEASURE = /(?<![\w.])\d+(?:[.,]\d+)?\s?(?:%|×|x(?!\w)|ms\b|µs\b|ns\b|fps\b|Hz\b|[kKMGT]i?B\b|px\b|percent\b|times\b|seconds?\b|minutes?\b|hours?\b)/;

/** Sentences of the Answer that state a measure and cite no claim: "cite every fact" is checked where it matters most. */
export function reportWarnings(raw) {
  const answer = sectionNamed(sections(visible(raw)), "Answer");
  if (!answer) return [];
  return answer.body
    .replace(/\n(?=\s*(?:[-*+]|\d+[.)])\s)/g, "\n\n")
    .split(/\n{2,}|(?<=[.!?])\s+(?=[A-Z*_`[(])/)
    .map((sentence) => sentence.replace(/\s+/g, " ").trim())
    .filter((sentence) => MEASURE.test(sentence) && !/\[\s*C\d+/.test(sentence))
    .map((sentence) => `the Answer states a measure without a claim id: "${sentence.length > 110 ? `${sentence.slice(0, 107)}...` : sentence}"`);
}

/** The field's own map, and the question tree grown from it, as a reader new to the field would scan them. */
export function renderMap(led, { report = "", now = new Date() } = {}) {
  const verdict = evaluate(led, { report, now });
  const byId = new Map(questionVerdicts(led, now).verdicts.map((v) => [v.id, v]));
  const lines = ["# Field map and question tree", "", generated(verdict, led), "", "## Topics the field's sources lay out", ""];
  if (!led.topics.size) lines.push("No topics recorded yet.");
  else {
    lines.push("| Topic | From | Asked as |", "|---|---|---|");
    for (const topic of led.topics.values()) {
      const asked = [...led.questions.values()].filter((question) => question.topics.includes(topic.id)).map((question) => question.id);
      const from = led.sources.get(topic.from);
      lines.push(`| **${topic.id}** ${cell(topic.text)} | ${topic.from}${from ? ` (${cell(from.title)}, ${from.kind})` : ""} | ${cell(topic.parked ? `parked: ${topic.parked}` : asked.join(", ") || "—")} |`);
    }
  }
  lines.push("", "## Question tree", "");
  const questions = [...led.questions.values()];
  const walk = (parent, depth) => {
    for (const question of questions.filter((q) => (q.parent ?? null) === parent)) {
      const parked = parkedReason(led, question);
      const v = byId.get(question.id);
      const state = parked ? `parked: ${parked}` : v?.answered ? "answered" : `open — ${v?.gaps.join("; ")}`;
      lines.push(`${"  ".repeat(depth)}- **${question.id}** ${question.text} — *${state}*`);
      walk(question.id, depth + 1);
    }
  };
  if (!questions.length) lines.push("No questions yet.");
  walk(null, 0);
  return `${lines.join("\n")}\n`;
}

/** Each round as it was recorded: what it did, where the score stood, and what came next. */
export function renderRounds(led) {
  const budget = led.budget.sources || led.budget.questions ? ` · budget ${[led.budget.sources ? `${led.budget.sources} web sources` : "", led.budget.questions ? `${led.budget.questions} questions` : ""].filter(Boolean).join(", ")}` : "";
  const lines = ["# Rounds", "", ...(led.goal ? [`**Goal:** ${led.goal}`, ""] : []), `Depth **${led.depth}** · cap ${led.cap} rounds after the baseline${budget}. Do not edit by hand.`, ""];
  if (!led.rounds.length) return `${[...lines, "No round recorded yet."].join("\n")}\n`;
  lines.push("| Round | When | What it did | Score | Answered | Gates holding | Next |", "|---|---|---|---|---|---|---|");
  for (const r of led.rounds) lines.push(`| ${r.n} | ${String(r.at ?? "").slice(0, 16).replace("T", " ")} | ${cell(r.change)} | ${r.score} | ${r.answered}/${r.questions} | ${r.gatesPassed}/${r.gates} | ${r.next} |`);
  const last = led.rounds.at(-1);
  if (last.reason) lines.push("", `**${last.next === "wrap-up" ? "Wrap-up" : "Stopped"}:** ${last.reason}`);
  return `${lines.join("\n")}\n`;
}

function statusText(verdict, led, only = null) {
  const last = led.rounds.at(-1);
  const stop = last && ["done", "escalate"].includes(last.next) ? ` (stopped: ${last.next})` : last?.next === "wrap-up" ? " (wrap-up: closing work only)" : "";
  const where = last ? `round ${last.n} of ${led.cap}${stop}` : "no round recorded yet";
  const lines = [`depth ${verdict.depth} · ${where} · score ${verdict.score} · ${verdict.answered}/${verdict.questions} questions answered${verdict.parked ? ` · ${verdict.parked} parked` : ""}`];
  const budget = verdict.budget ? budgetLine(verdict) : "";
  if (budget) lines.push(`budget: ${budget}`);
  if (only) {
    // A researcher asks about its own questions, and is spared the rest of the run.
    const open = new Map(verdict.open.map((question) => [question.id, question.gaps]));
    for (const id of only) {
      const parked = parkedReason(led, led.questions.get(id));
      lines.push(`  ${id}: ${parked ? `parked — ${parked}` : open.has(id) ? open.get(id).join("; ") : "answered"}`);
    }
    return `${lines.join("\n")}\n`;
  }
  lines.push(`gates: ${verdict.gates.map((gate) => `${gate.name} ${gate.pass ? "ok" : "open"}`).join(" · ")}`);
  for (const gate of verdict.gates.filter((g) => !g.pass)) lines.push(`  ${gate.name}: ${gate.problems.join("; ")}`);
  if (verdict.saturation) lines.push(`saturation (an indicator, not a gate): ${verdict.saturation.streak}/${verdict.saturation.of} authors among the newest tier A/B sources added nothing new`);
  if (verdict.open.length) lines.push("open questions:");
  for (const question of verdict.open) lines.push(`  ${question.id}: ${question.gaps.join("; ")}`);
  for (const warning of verdict.warnings ?? []) lines.push(`check: ${warning}`);
  for (const error of verdict.errors ?? []) lines.push(`error: ${error}`);
  return `${lines.join("\n")}\n`;
}

// ── commands ───────────────────────────────────────────────────────────────────────────────────────────────────

const given = (value) => (value === undefined || value === true ? undefined : value);

function required(args, flag) {
  const value = given(args[flag]);
  if (value === undefined || !String(value).trim()) throw new Error(`--${flag} is required`);
  return String(value);
}

function int(value, flag) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${flag} must be a whole number`);
  return n;
}

/** The research folder: the one `start` printed, or its `evidence/` folder, which means the same run. */
function requireDir(args) {
  const raw = required(args, "dir");
  const dir = path.basename(path.resolve(raw)) === EVIDENCE_DIR && !fs.existsSync(path.join(raw, EVIDENCE_DIR)) ? path.dirname(path.resolve(raw)) : raw;
  if (!fs.existsSync(path.join(evidenceOf(dir), LEDGER_FILE))) throw new Error(`--dir ${raw} is not a research folder (\`ultra-research.mjs start\` makes one)`);
  return dir;
}

function kindArg(args) {
  const kind = required(args, "kind");
  if (!(kind in SOURCE_KINDS)) throw new Error(`--kind must be one of ${Object.keys(SOURCE_KINDS).join(", ")}`);
  return kind;
}

/** A quote from `--quote "<words>"`, or `--quote -` to read it from stdin when the words hold shell quotes. */
function quoteArg(args) {
  const quote = args.quote === "-" ? fs.readFileSync(0, "utf8").trim() : required(args, "quote");
  const problem = quoteProblem(quote);
  if (problem) throw new Error(problem);
  return quote;
}

const agentOf = (args) => (given(args.agent) ? { agent: String(args.agent) } : {});

function liveClaim(led, id) {
  const claim = led.claims.get(id);
  if (!claim) throw new Error(`no claim ${id}`);
  if (claim.status !== "live") throw new Error(`${id} was ${claim.status}`);
  return claim;
}

function knownSource(led, id) {
  const source = led.sources.get(id);
  if (!source) throw new Error(`no source ${id}: add it with \`source\` first`);
  return source;
}

/** One sentence backs one claim: the same words at the same source cannot stand behind two different claims. */
function refuseReusedQuote(led, claimId, sourceId, quote) {
  const other = liveClaims(led).find((claim) => claim.id !== claimId && claim.citations.has(sourceId) && sameWords(claim.citations.get(sourceId).quote, quote));
  if (other) throw new Error(`${other.id} already rests on these words from ${sourceId}; quote the sentence that says this claim`);
}

/** A local quote is checked as it is written: the file is here, so a misquote is refused instead of recorded. */
function citationEvents(led, dir, source, claim, quote, base, checked = null) {
  if (source.url) return checked ? [base, { t: "check", claim, source: source.id, quote, ...checked }] : [base];
  const verdict = judgeQuote(quote, localText(source, dir));
  if (verdict.result !== "found") throw new Error(`the quote is not in ${source.kind === "experiment" ? source.output : source.path}${source.line ? ` near line ${source.line}` : ""}: ${verdict.reason}`);
  return [base, { t: "check", claim, source: source.id, quote, result: "found" }];
}

function validDate(date) {
  if (date === null) return null;
  if (!/^(\d{4}(-\d{2}(-\d{2})?)?|n\.d\.)$/.test(date)) throw new Error("--date must be YYYY, YYYY-MM, YYYY-MM-DD or n.d.");
  if (yearOf({ date }) > currentYear()) throw new Error(`--date ${date} is in the future`);
  return date;
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** This script, by version and by content: a ledger records which one graded it. */
function scriptIdentity() {
  try {
    return { version: VERSION, sha256: sha256(fs.readFileSync(fileURLToPath(import.meta.url))) };
  } catch {
    return { version: VERSION, sha256: null };
  }
}

/**
 * Languages an experiment may be written in, when the host limits them. How each shows in a command: the program
 * that runs it, or the extension of a file it names. A shell is glue, not a language an experiment is written in.
 */
const LANGUAGES = {
  python: { run: ["python", "python2", "python3", "pypy", "pypy3", "ipython", "uv", "pip", "pipx", "poetry", "conda"], ext: ["py", "ipynb"] },
  javascript: { run: ["node", "nodejs", "deno", "bun", "npx", "npm", "tsx", "ts-node"], ext: ["js", "mjs", "cjs", "ts", "mts"] },
  ruby: { run: ["ruby", "irb", "bundle"], ext: ["rb"] },
  perl: { run: ["perl"], ext: ["pl"] },
  php: { run: ["php"], ext: ["php"] },
  r: { run: ["rscript"], ext: ["r"] },
  julia: { run: ["julia"], ext: ["jl"] },
  lua: { run: ["lua", "luajit"], ext: ["lua"] },
  java: { run: ["java", "javac", "gradle", "mvn"], ext: ["java", "kt"] },
  c: { run: ["gcc", "cc", "clang", "tcc"], ext: ["c"] },
  cpp: { run: ["g++", "c++", "clang++"], ext: ["cpp", "cc", "cxx"] },
  rust: { run: ["cargo", "rustc"], ext: ["rs"] },
  go: { run: ["go"], ext: ["go"] },
  zig: { run: ["zig"], ext: ["zig"] },
};
const LANGUAGE_NAMES = { "c++": "cpp", js: "javascript", typescript: "javascript", ts: "javascript", py: "python", golang: "go", rs: "rust" };

function langList(raw) {
  const langs = String(raw).split(",").map((name) => name.trim().toLowerCase()).filter(Boolean).map((name) => LANGUAGE_NAMES[name] ?? name);
  for (const lang of langs) if (!(lang in LANGUAGES)) throw new Error(`--experiment-langs takes ${Object.keys(LANGUAGES).join(", ")}`);
  if (!langs.length) throw new Error("--experiment-langs needs at least one language");
  return unique(langs);
}

/** Words before a program that are not the program: `OMP_NUM_THREADS=8 time ./bench`. */
const WRAPPERS = new Set(["sudo", "time", "env", "exec", "nice", "nohup", "command", "stdbuf", "taskset", "timeout"]);

/**
 * The languages a command and its script are plainly written in: the program at the head of each part of the
 * command, and the extension of any file it names. A guard-rail against a slip, not a lock.
 */
export function languagesIn(command, script) {
  const found = new Set();
  const note = (token, asProgram) => {
    const name = path.basename(token).toLowerCase();
    const extension = name.includes(".") ? name.split(".").pop() : null;
    for (const [lang, signs] of Object.entries(LANGUAGES)) {
      const runs = asProgram && (signs.run.includes(name) || signs.run.includes(name.replace(/[\d.]+$/, "")));
      if (runs || (extension && signs.ext.includes(extension))) found.add(lang);
    }
  };
  for (const part of String(command).split(/[;|&()"'`\n]+/)) {
    let head = true;
    for (const token of part.trim().split(/\s+/).filter(Boolean)) {
      if (head && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token) || WRAPPERS.has(token) || token.startsWith("-") || /^\d+[smh]?$/.test(token))) continue;
      note(token, head);
      head = false;
    }
  }
  if (script) note(script, false);
  return [...found];
}

function today(now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** A new research folder, `.ultra-research/<date>-<slug>/`: the report's stub, and the evidence folder with its ledger. */
function commandStart(args) {
  const slug = required(args, "slug");
  if (!SLUG.test(slug)) throw new Error("--slug takes lowercase words joined by hyphens, such as pg-multitenancy");
  const goal = required(args, "goal");
  const depth = given(args.depth) ?? "deep";
  const recentYears = given(args["recent-years"]) === undefined ? undefined : int(args["recent-years"], "--recent-years");
  const bar = barFor(depth, recentYears);
  const cap = given(args.cap) === undefined ? DEFAULT_CAP : int(args.cap, "--cap");
  if (cap < 1) throw new Error("--cap must be at least 1");
  const maxSources = given(args["max-sources"]) === undefined ? bar.maxSources : int(args["max-sources"], "--max-sources");
  const maxQuestions = given(args["max-questions"]) === undefined ? bar.maxQuestions : int(args["max-questions"], "--max-questions");
  const experimentLangs = given(args["experiment-langs"]) === undefined ? null : langList(args["experiment-langs"]);
  let from = given(args.from);
  if (from) from = requireDir({ dir: from });
  const { root, found } = given(args.root) ? { root: path.resolve(String(args.root)), found: true } : findProject();
  const runs = path.join(root, RUNS_DIR);
  let dir = path.join(runs, `${today()}-${slug}`);
  for (let n = 2; fs.existsSync(dir); n++) dir = path.join(runs, `${today()}-${slug}-${n}`);
  // An earlier run's knowledge carries over; its quote checks, reviews and rounds do not, since pages and judgments age.
  const KEEP = new Set(["source", "reclassify", "topic", "question", "park", "claim", "cite", "uncite", "dispute", "resolve", "retract"]);
  const inherited = from ? readEvents(from).events.filter((event) => KEEP.has(event.t)).map((event) => ({ ...event, inherited: true })) : [];
  const init = {
    t: "init",
    v: RULES,
    slug,
    goal,
    depth,
    cap,
    maxSources,
    maxQuestions,
    ...(experimentLangs ? { experimentLangs } : {}),
    ...(recentYears === undefined ? {} : { recentYears }),
    ...(from ? { from: path.relative(root, path.resolve(from)) } : {}),
    // Which script graded this run: `verify` says so when it changed on the way.
    script: scriptIdentity(),
    at: new Date().toISOString(),
  };
  fs.mkdirSync(path.join(dir, EVIDENCE_DIR, "experiments"), { recursive: true });
  fs.mkdirSync(path.join(dir, EVIDENCE_DIR, "branches"), { recursive: true });
  fs.writeFileSync(path.join(dir, EVIDENCE_DIR, LEDGER_FILE), [init, ...inherited].map((event) => `${JSON.stringify(event)}\n`).join(""));
  fs.writeFileSync(path.join(dir, REPORT_FILE), `# ${goal}\n\nResearch in progress: see [the rounds](${EVIDENCE_DIR}/${ROUNDS_FILE}). This file becomes the report.\n`);
  const led = load(dir);
  fs.writeFileSync(path.join(dir, EVIDENCE_DIR, ROUNDS_FILE), renderRounds(led));
  return {
    output: {
      dir: path.relative(process.cwd(), dir) || ".",
      report: path.join(dir, REPORT_FILE),
      evidence: path.join(dir, EVIDENCE_DIR),
      depth,
      cap,
      budget: { sources: maxSources, questions: maxQuestions },
      ...(experimentLangs ? { experimentLangs } : {}),
      bar,
      inherited: inherited.length,
      ...(found ? {} : { warning: `no repository or ${RUNS_DIR}/ found above ${process.cwd()}; the run is in ${runs}. Start from the project's root, or pass --root.` }),
    },
  };
}

/** Who stands behind a URL: the people who wrote it, the organisation whose page it is, or both. */
function namedBy(args, led, isUrl) {
  const authors = given(args.authors);
  const org = given(args.org);
  const origin = given(args.origin);
  if (origin && led.v >= 2) throw new Error('--origin is gone: name the people with --authors "First Last, First Last" and the organisation with --org "<name>"');
  if ((authors || org || origin) && !isUrl) throw new Error("--authors and --org name who stands behind a URL; the project's own files are one voice");
  if (authors && !peopleOf(authors).length) throw new Error('--authors takes names, first name first: "Ada Lovelace, Alan Turing"');
  if (org && !orgKey(org)) throw new Error("--org takes the name of an organisation");
  // A ledger under the first rules counts voices by `origin`, so names given to it are kept there as well.
  const legacy = led.v < 2 ? (origin ?? ([authors, org].filter(Boolean).join(" — ") || undefined)) : undefined;
  return { ...(authors ? { authors: String(authors) } : {}), ...(org ? { org: String(org) } : {}), ...(legacy ? { origin: String(legacy) } : {}) };
}

/** Where a source sits, as the ledger's rules see it. */
const siteOf = (led, source) => (led.v >= 2 && source.url ? siteKey(source.url) : originOf(source));

function commandSource(args) {
  const dir = requireDir(args);
  const kind = kindArg(args);
  if (kind === "experiment") throw new Error("an experiment is recorded by `experiment --command`, which runs it and saves what it printed");
  const title = required(args, "title");
  const url = given(args.url);
  const file = given(args.path);
  if (Boolean(url) === Boolean(file)) throw new Error("a source needs exactly one of --url or --path");
  const line = given(args.line) === undefined ? null : int(args.line, "--line");
  const date = validDate(given(args.date) ?? null);
  return {
    output: write(dir, (led) => {
      const names = namedBy(args, led, Boolean(url));
      let resolved = null;
      if (file) {
        const absolute = resolveLocal(file, dir);
        if (!absolute) throw new Error(`${file} not found: a source is something opened`);
        if (insideRuns(absolute)) throw new Error(`${file} is inside ${RUNS_DIR}/: research notes are not a source (start a run --from an earlier one instead)`);
        resolved = projectPath(absolute, dir);
      }
      const key = url ? normalizeUrl(url) : `${resolved}${line ? `:${line}` : ""}`;
      const existing = [...led.sources.values()].find((source) => source.key === key);
      if (existing) return { output: { id: existing.id, tier: existing.tier, origin: siteOf(led, existing), existing: true } };
      const budget = budgetOf(led).sources;
      if (url && budget.full) {
        throw new Error(`the source budget is spent (${budget.used}/${budget.max} web sources): work with what the ledger holds, or ask the user to raise it (budget --max-sources <n> --reason <who said so>)`);
      }
      const id = nextId(led, "S");
      const event = { t: "source", id, kind, title, key, ...(url ? { url } : { path: file, resolved }), ...(line ? { line } : {}), date, ...names, ...agentOf(args) };
      const used = budget.used + 1;
      const spend = url && budget.max ? { budget: `${used}/${budget.max} web sources`, ...(used >= budget.readingLimit ? { note: "the reading budget is spent: no new sources for open questions; what is left is for closing work (a broken quote, a probe's hit, a reviewer's finding)" } : {}) } : {};
      return { events: [event], output: { id, tier: SOURCE_KINDS[kind], origin: siteOf(led, event), existing: false, ...spend } };
    }),
  };
}

/**
 * An experiment the ledger ran itself: the command, its exit code and a hash of what it printed are recorded, so an
 * output the agent typed or edited afterwards does not count.
 */
function commandExperiment(args) {
  const dir = requireDir(args);
  const title = required(args, "title");
  const command = required(args, "command");
  const script = given(args.path);
  const timeout = given(args.timeout) === undefined ? EXPERIMENT_TIMEOUT_MS : int(args.timeout, "--timeout");
  const scriptPath = script ? resolveLocal(script, dir) : null;
  if (script && !scriptPath) throw new Error(`${script} not found`);
  const allowed = load(dir).langs;
  if (allowed) {
    const others = languagesIn(command, script).filter((lang) => !allowed.includes(lang));
    if (others.length) throw new Error(`this run takes experiments in ${allowed.join(", ")} only (a host rule, set at start); this one is ${others.join(", ")}`);
  }
  const run = spawnSync(command, { shell: true, cwd: projectBase(dir), encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024 });
  if (run.error) throw new Error(`the experiment did not run: ${run.error.message}`);
  const printed = `$ ${command}\n${run.stdout ?? ""}${run.stderr ? `\n[stderr]\n${run.stderr}` : ""}`;
  if (run.status !== 0) throw new Error(`the experiment exited ${run.status}; a failed run is not evidence. Its output ends:\n${printed.slice(-800)}`);
  return {
    output: write(dir, (led) => {
      const id = nextId(led, "S");
      const folder = path.join(evidenceOf(dir), "experiments");
      fs.mkdirSync(folder, { recursive: true });
      const outFile = path.join(folder, `${id}.out`);
      fs.writeFileSync(outFile, printed);
      const event = {
        t: "source",
        id,
        kind: "experiment",
        title,
        key: `experiment:${id}`,
        command,
        ...(scriptPath ? { path: script, resolved: projectPath(scriptPath, dir) } : {}),
        output: projectPath(path.resolve(outFile), dir),
        hash: sha256(printed),
        date: new Date().toISOString().slice(0, 10),
        ...agentOf(args),
      };
      return { events: [event], output: { id, tier: "A", output: outFile, printed: printed.slice(0, 4000) } };
    }),
  };
}

/** A source filed under the wrong kind or the wrong authors is corrected in place; re-adding its URL only finds it again. */
function commandReclassify(args) {
  const dir = requireDir(args);
  const id = required(args, "source");
  const kindGiven = given(args.kind);
  if (kindGiven !== undefined && !(kindGiven in SOURCE_KINDS)) throw new Error(`--kind must be one of ${Object.keys(SOURCE_KINDS).join(", ")}`);
  const reason = required(args, "reason");
  return {
    output: write(dir, (led) => {
      const source = knownSource(led, id);
      const kind = kindGiven ?? source.kind;
      if ((source.kind === "experiment") !== (kind === "experiment")) throw new Error("only the experiment command makes an experiment, and an experiment stays one");
      const names = namedBy(args, led, Boolean(source.url));
      if (kindGiven === undefined && !Object.keys(names).length) throw new Error("reclassify needs --kind, --authors or --org");
      const event = { t: "reclassify", source: id, kind, reason, ...names, ...agentOf(args) };
      return { events: [event], output: { id, tier: SOURCE_KINDS[kind], origin: siteOf(led, { ...source, ...names }) } };
    }),
  };
}

function commandTopic(args) {
  const dir = requireDir(args);
  const text = required(args, "text");
  const from = required(args, "from");
  return {
    output: write(dir, (led) => {
      const source = knownSource(led, from);
      const id = nextId(led, "T");
      return { events: [{ t: "topic", id, text, from, ...agentOf(args) }], output: { id, mapSource: Boolean(source.url) && source.tier === "B" } };
    }),
  };
}

function commandQuestion(args) {
  const dir = requireDir(args);
  const text = required(args, "text");
  const topics = given(args.topic) ? String(args.topic).split(",").map((s) => s.trim()).filter(Boolean) : [];
  if (topics.length > MAX_TOPICS_PER_QUESTION) throw new Error(`a question covers at most ${MAX_TOPICS_PER_QUESTION} topics of the map; ask one per topic`);
  const from = given(args.from) ?? (topics.length ? "map" : undefined);
  if (!from) throw new Error("--from is required: the source that raised the question (S<n>), user, or review");
  const needs = given(args.needs) ? String(args.needs).split(",").map((s) => s.trim()).filter(Boolean) : [];
  for (const kind of needs) if (!CLAIM_KINDS.includes(kind)) throw new Error(`--needs takes claim kinds: ${CLAIM_KINDS.join(", ")}`);
  return {
    output: write(dir, (led) => {
      if (/^S\d+$/.test(from)) knownSource(led, from);
      else if (!["user", "review", "map"].includes(from)) throw new Error("--from must be a source id, user, review or map");
      const parent = given(args.parent);
      if (parent && !led.questions.has(parent)) throw new Error(`no question ${parent}`);
      for (const topic of topics) if (!led.topics.has(topic)) throw new Error(`no topic ${topic}`);
      const budget = budgetOf(led).questions;
      if (budget.full) {
        throw new Error(`the question budget is spent (${budget.used}/${budget.max} in scope): park a question first, or ask the user to raise it (budget --max-questions <n> --reason <who said so>)`);
      }
      const id = nextId(led, "Q");
      const event = {
        t: "question",
        id,
        text,
        from,
        ...(parent ? { parent } : {}),
        ...(topics.length ? { topics } : {}),
        ...(needs.length ? { needs } : {}),
        ...(args.quantitative === true ? { quantitative: true } : {}),
        ...(args.timeless === true ? { timeless: true } : {}),
        ...agentOf(args),
      };
      return { events: [event], output: { id, ...(budget.max ? { budget: `${budget.used + 1}/${budget.max} questions` } : {}) } };
    }),
  };
}

function commandPark(args) {
  const dir = requireDir(args);
  const target = given(args.question) ?? given(args.topic);
  if (!target) throw new Error("park needs --question <Q> or --topic <T>");
  const reason = required(args, "reason");
  return {
    output: write(dir, (led) => {
      if (!(target.startsWith("T") ? led.topics : led.questions).has(target)) throw new Error(`no ${target}`);
      return { events: [{ t: "park", target, reason, ...agentOf(args) }], output: { parked: target } };
    }),
  };
}

/**
 * A quote from the web is read against its page as it is written, as a quote from a local file always was: a
 * misquote is refused on the spot instead of becoming a retraction two rounds later. A page no reader could open
 * is recorded as unverifiable, for a hand check. `--no-check` leaves the quote to `check-quotes`.
 */
async function checkOnWrite(dir, args, source, quote) {
  if (!source?.url || args["no-check"] === true) return null;
  const timeoutMs = given(args.timeout) === undefined ? DEFAULT_TIMEOUT_MS : int(args.timeout, "--timeout");
  let verdict;
  try {
    [verdict] = await judgeCitations(dir, source, [quote], { timeoutMs });
  } catch (err) {
    verdict = { result: "unverifiable", reason: `reading the source failed (${String(err.message ?? err.name).slice(0, 120)}); confirm it by hand` };
  }
  if (verdict.result === "missing") throw new Error(`the quote is not in ${source.id} (${source.url}): copy the words as the page has them, or cite the source that says them`);
  if (verdict.result === "dead") throw new Error(`${source.id} is gone (${verdict.reason}): cite a source that can be read`);
  return verdict;
}

/** What a write says about its quote: found, or why it waits for a hand check. */
function checkNote(checked, claim, source) {
  if (!checked) return {};
  if (checked.result === "found") return { check: checked.via ? `found (read by ${checked.via})` : "found" };
  return { check: checked.result, reason: checked.reason, next: `confirm-quote --claim ${claim} --source ${source} --how <how you read it>` };
}

async function commandClaim(args) {
  const dir = requireDir(args);
  const question = required(args, "question");
  const kind = required(args, "kind");
  if (!CLAIM_KINDS.includes(kind)) throw new Error(`--kind must be one of ${CLAIM_KINDS.join(", ")}`);
  const text = required(args, "text");
  const sourceId = required(args, "source");
  const quote = quoteArg(args);
  const admit = (led) => {
    const q = led.questions.get(question);
    if (!q) throw new Error(`no question ${question}`);
    if (parkedReason(led, q)) throw new Error(`${question} is parked`);
    const source = knownSource(led, sourceId);
    const id = nextId(led, "C");
    refuseReusedQuote(led, id, sourceId, quote);
    return { source, id };
  };
  const checked = await checkOnWrite(dir, args, admit(load(dir)).source, quote);
  return {
    output: write(dir, (led) => {
      const { source, id } = admit(led);
      const base = { t: "claim", id, question, kind, text, source: sourceId, quote, ...agentOf(args) };
      return { events: citationEvents(led, dir, source, id, quote, base, checked), output: { id, ...checkNote(checked, id, sourceId) } };
    }),
  };
}

async function commandCite(args) {
  const dir = requireDir(args);
  const claimId = required(args, "claim");
  const sourceId = required(args, "source");
  const quote = quoteArg(args);
  const admit = (led) => {
    liveClaim(led, claimId);
    const source = knownSource(led, sourceId);
    refuseReusedQuote(led, claimId, sourceId, quote);
    return source;
  };
  const checked = await checkOnWrite(dir, args, admit(load(dir)), quote);
  return {
    output: write(dir, (led) => {
      const source = admit(led);
      const base = { t: "cite", claim: claimId, source: sourceId, quote, ...agentOf(args) };
      return { events: citationEvents(led, dir, source, claimId, quote, base, checked), output: { claim: claimId, source: sourceId, ...checkNote(checked, claimId, sourceId) } };
    }),
  };
}

/** One citation taken off a claim: a source attached to the wrong claim no longer costs the whole claim. */
function commandUncite(args) {
  const dir = requireDir(args);
  const claimId = required(args, "claim");
  const sourceId = required(args, "source");
  const reason = required(args, "reason");
  return {
    output: write(dir, (led) => {
      const claim = liveClaim(led, claimId);
      if (!claim.citations.has(sourceId)) throw new Error(`${claimId} does not cite ${sourceId}`);
      if (claim.citations.size === 1) throw new Error(`${sourceId} is the only source behind ${claimId}: retract the claim instead`);
      return { events: [{ t: "uncite", claim: claimId, source: sourceId, reason, ...agentOf(args) }], output: { uncited: `${claimId}/${sourceId}` } };
    }),
  };
}

function commandDispute(args) {
  const dir = requireDir(args);
  const claimId = required(args, "claim");
  const by = required(args, "by");
  const note = required(args, "note");
  return {
    output: write(dir, (led) => {
      liveClaim(led, claimId);
      if (!led.sources.has(by) && !led.claims.has(by)) throw new Error(`--by must be the source or claim that disagrees (no ${by})`);
      return { events: [{ t: "dispute", claim: claimId, by, note, ...agentOf(args) }], output: { disputed: claimId } };
    }),
  };
}

function commandResolve(args) {
  const dir = requireDir(args);
  const claimId = required(args, "claim");
  const outcome = required(args, "outcome");
  if (!OUTCOMES.includes(outcome)) throw new Error(`--outcome must be one of ${OUTCOMES.join(", ")}`);
  const note = required(args, "note");
  const by = given(args.by);
  // Siding with one source over another needs the evidence that settled it; experts still disagreeing needs only saying so.
  if (outcome !== "debate" && !by) throw new Error(`--outcome ${outcome} needs --by: the source, claim or experiment that settled it`);
  return {
    output: write(dir, (led) => {
      const claim = liveClaim(led, claimId);
      if (!claim.disputes.some((dispute) => dispute.open)) throw new Error(`${claimId} has no open dispute`);
      if (by && !led.sources.has(by) && !led.claims.has(by)) throw new Error(`no source or claim ${by}`);
      return { events: [{ t: "resolve", claim: claimId, outcome, note, ...(by ? { by } : {}), ...agentOf(args) }], output: { resolved: claimId, outcome } };
    }),
  };
}

function commandRetract(args) {
  const dir = requireDir(args);
  const claimId = required(args, "claim");
  const reason = required(args, "reason");
  return {
    output: write(dir, (led) => {
      liveClaim(led, claimId);
      return { events: [{ t: "retract", claim: claimId, reason, ...agentOf(args) }], output: { retracted: claimId } };
    }),
  };
}

/**
 * A search for evidence against a claim, recorded with its words so a reader can judge it. What it finds opens a
 * dispute, which blocks the claim's question until it is settled: the last pass tests the answer instead of padding it.
 */
function commandProbe(args) {
  const dir = requireDir(args);
  const claimId = required(args, "claim");
  const query = required(args, "query");
  if (words(query).length < 2) throw new Error("--query takes the words that were searched for, at least two");
  const found = required(args, "found");
  if (found !== "none" && !/^S\d+$/.test(found)) throw new Error("--found takes the source that speaks against the claim (S<n>), or none");
  const note = given(args.note);
  return {
    output: write(dir, (led) => {
      const claim = liveClaim(led, claimId);
      const probe = { t: "probe", claim: claimId, query, found, ...(note ? { note: String(note) } : {}), ...agentOf(args) };
      if (found === "none") return { events: [probe], output: { probed: claimId, found } };
      knownSource(led, found);
      if (claim.citations.has(found)) throw new Error(`${found} backs ${claimId}; a probe looks for evidence against it`);
      if (!note) throw new Error("--note is required with --found <S>: what the source says against the claim");
      const dispute = { t: "dispute", claim: claimId, by: found, note: String(note), ...agentOf(args) };
      return { events: [probe, dispute], output: { probed: claimId, found, disputed: claimId, next: `resolve --claim ${claimId} --outcome upheld|refuted|debate --note <why> [--by <S|C>]` } };
    }),
  };
}

/**
 * Whether a quote says what its claim says, as read by someone who did not write the claim. The script can show a
 * quote is on its page; only a reader can tell that it backs the sentence resting on it.
 */
function commandAudit(args) {
  const dir = requireDir(args);
  const claimId = required(args, "claim");
  const sourceId = required(args, "source");
  const verdict = required(args, "verdict");
  if (!AUDIT_VERDICTS.includes(verdict)) throw new Error(`--verdict must be one of ${AUDIT_VERDICTS.join(", ")}`);
  const by = required(args, "by");
  const note = given(args.note);
  if (verdict !== "supports" && !note) throw new Error(`--note is required with --verdict ${verdict}: what the quote does not say`);
  return {
    output: write(dir, (led) => {
      const claim = liveClaim(led, claimId);
      const citation = claim.citations.get(sourceId);
      if (!citation) throw new Error(`${claimId} does not cite ${sourceId}`);
      if (broken(citation)) throw new Error(`the quote of ${claimId}/${sourceId} was not found at its source: fix the citation before it is audited`);
      if ([claim.agent, citation.agent].filter(Boolean).includes(by)) throw new Error(`${by} wrote ${claimId}: an audit is by a reader who did not write the claim`);
      const event = { t: "audit", claim: claimId, source: sourceId, quote: citation.quote, verdict, by, ...(note ? { note: String(note) } : {}) };
      const next = verdict === "supports" ? {} : { next: `cite words that say the claim (cite --claim ${claimId}), take this source off it (uncite), or retract it and record what the quote does say` };
      return { events: [event], output: { audited: `${claimId}/${sourceId}`, verdict, ...next } };
    }),
  };
}

/** The words around a quote in its source, so an auditor reads the sentence in its place. */
export function contextOf(text, quote, around) {
  if (!text) return null;
  const tokens = [];
  for (const match of String(text).matchAll(/[\p{L}\p{N}\p{M}]+/gu)) for (const word of words(match[0])) tokens.push({ word, at: match.index, end: match.index + match[0].length });
  const parts = quoteParts(quote);
  if (!parts.length) return null;
  const find = (part, from) => {
    for (let i = from; i <= tokens.length - part.length; i++) if (part.every((word, k) => tokens[i + k].word === word)) return i;
    return -1;
  };
  const first = find(parts[0], 0);
  if (first < 0) return null;
  let last = first + parts[0].length - 1;
  for (const part of parts.slice(1)) {
    const at = find(part, last + 1);
    if (at < 0) break;
    last = at + part.length - 1;
  }
  const from = tokens[Math.max(0, first - around)].at;
  const to = tokens[Math.min(tokens.length - 1, last + around)].end;
  return String(text).slice(from, to).replace(/\s+/g, " ").trim();
}

/** The claims that still wait for an audit, each with its quotes and the words around them, ready to hand out. */
function commandAuditQueue(args) {
  const dir = requireDir(args);
  const around = given(args.context) === undefined ? 60 : int(args.context, "--context");
  const led = load(dir);
  const report = reportBody(dir);
  const names = led.bar.audit.length ? led.bar.audit : ["Answer"];
  const waiting = claimsCitedIn(led, report, names)
    .map((claim) => ({ claim, counted: [...claim.citations].filter(([, citation]) => !broken(citation)) }))
    .filter(({ counted }) => !counted.some(([, citation]) => citation.audit?.verdict === "supports") || counted.some(([, citation]) => citation.audit && citation.audit.verdict !== "supports"));
  return {
    output: {
      sections: names,
      waiting: waiting.length,
      claims: waiting.map(({ claim, counted }) => ({
        claim: claim.id,
        kind: claim.kind,
        text: claim.text,
        question: led.questions.get(claim.question)?.text ?? null,
        ...(claim.agent ? { writtenBy: claim.agent } : {}),
        citations: counted.map(([id, citation]) => {
          const source = led.sources.get(id);
          return {
            source: id,
            title: source?.title ?? null,
            where: source?.url ?? source?.output ?? source?.path ?? null,
            quote: citation.quote,
            check: citation.check?.result ?? "not checked",
            ...(citation.audit ? { audited: citation.audit.verdict } : {}),
            context: source ? contextOf(savedText(dir, source), citation.quote, around) : null,
          };
        }),
      })),
    },
  };
}

function commandReview(args) {
  const dir = requireDir(args);
  const by = required(args, "by");
  const note = required(args, "note");
  const clean = args.clean === true;
  return {
    output: write(dir, (led) => {
      if (led.v >= 2 && (led.writers.has(by) || /^main(\/|$)/.test(by))) throw new Error(`${by} wrote part of this run: a review is by a reader who did not write it`);
      const { answered, questions } = evaluate(led, { report: reportBody(dir) });
      const ratio = questions ? round(answered / questions) : 0;
      const id = nextId(led, "R");
      const next = led.v < 2 ? {} : { next: clean ? "a clean review names no finding; the note says what the weakest part is" : `record each objection: finding --review ${id} --text <what is wrong or missing> [--claim <C>] [--question <Q>]` };
      return { events: [{ t: "review", id, by, note, answered: ratio, ...(clean ? { clean: true } : {}) }], output: { review: id, by, answered: ratio, counts: ratio >= REVIEW_AFTER, ...next } };
    }),
  };
}

/** One thing a reviewer found. The review counts only when each one is closed: fixed in the ledger, or rejected with a reason. */
function commandFinding(args) {
  const dir = requireDir(args);
  const reviewId = required(args, "review");
  const text = required(args, "text");
  const claim = given(args.claim);
  const question = given(args.question);
  return {
    output: write(dir, (led) => {
      if (!led.reviews.some((review) => review.id === reviewId)) throw new Error(`no review ${reviewId}: open one with \`review --by <reviewer> --note <one line>\``);
      if (claim && !led.claims.has(claim)) throw new Error(`no claim ${claim}`);
      if (question && !led.questions.has(question)) throw new Error(`no question ${question}`);
      const id = nextId(led, "F");
      const event = { t: "finding", id, review: reviewId, text, ...(claim ? { claim } : {}), ...(question ? { question } : {}), ...agentOf(args) };
      return { events: [event], output: { id, review: reviewId } };
    }),
  };
}

function commandClose(args) {
  const dir = requireDir(args);
  const id = required(args, "finding");
  const how = required(args, "how");
  if (!["fixed", "rejected"].includes(how)) throw new Error("--how must be fixed or rejected");
  const note = required(args, "note");
  return {
    output: write(dir, (led) => {
      const finding = led.findings.get(id);
      if (!finding) throw new Error(`no finding ${id}`);
      if (finding.closed) throw new Error(`${id} was already closed (${finding.closed.how})`);
      return { events: [{ t: "close", finding: id, how, note, ...agentOf(args) }], output: { closed: id, how } };
    }),
  };
}

/** The budget is the user's: it is raised when they say so, and the ledger keeps who said it. */
function commandBudget(args) {
  const dir = requireDir(args);
  const maxSources = given(args["max-sources"]) === undefined ? undefined : int(args["max-sources"], "--max-sources");
  const maxQuestions = given(args["max-questions"]) === undefined ? undefined : int(args["max-questions"], "--max-questions");
  if (maxSources === undefined && maxQuestions === undefined) throw new Error("budget needs --max-sources or --max-questions (0 lifts the limit)");
  const reason = required(args, "reason");
  return {
    output: write(dir, (led) => {
      if (led.v < 2) throw new Error("this run was made before budgets; it has none to change");
      const event = { t: "budget", ...(maxSources === undefined ? {} : { maxSources }), ...(maxQuestions === undefined ? {} : { maxQuestions }), reason, ...agentOf(args) };
      return { events: [event], output: { budget: { sources: maxSources ?? led.budget.sources, questions: maxQuestions ?? led.budget.questions } } };
    }),
  };
}

/** A named input's identity: its URL as sources are keyed, or a file as the project sees it, without a line. */
function inputKey(ref, dir) {
  if (/^https?:\/\//i.test(ref)) return normalizeUrl(ref);
  const absolute = resolveLocal(ref, dir);
  return absolute ? projectPath(absolute, dir) : path.normalize(ref);
}

function commandInput(args) {
  const dir = requireDir(args);
  const ref = required(args, "ref");
  return { output: write(dir, () => ({ events: [{ t: "input", ref, key: inputKey(ref, dir) }], output: { input: ref } })) };
}

function commandUnreadable(args) {
  const dir = requireDir(args);
  const ref = required(args, "ref");
  const reason = required(args, "reason");
  return {
    output: write(dir, (led) => {
      const key = inputKey(ref, dir);
      if (!led.inputs.has(key)) throw new Error(`${ref} is not a named input (add it with \`input\` first)`);
      return { events: [{ t: "unreadable", key, reason }], output: { unreadable: ref } };
    }),
  };
}

function commandConfirmQuote(args) {
  const dir = requireDir(args);
  const claimId = required(args, "claim");
  const sourceId = required(args, "source");
  const how = required(args, "how");
  return {
    output: write(dir, (led) => {
      const citation = liveClaim(led, claimId).citations.get(sourceId);
      if (!citation) throw new Error(`${claimId} does not cite ${sourceId}`);
      // A hand check is for a page the script could not read, never a way around one it read.
      if (citation.check?.result !== "unverifiable") {
        throw new Error(citation.check ? `check-quotes read ${sourceId} and recorded ${citation.check.result}; a hand check is only for a source it could not read` : `run check-quotes first; a hand check is only for a source it could not read`);
      }
      return { events: [{ t: "check", claim: claimId, source: sourceId, quote: citation.quote, result: "manual", how }], output: { confirmed: `${claimId}/${sourceId}` } };
    }),
  };
}

const idList = (value) => (given(value) === undefined ? null : new Set(String(value).split(",").map((id) => id.trim()).filter(Boolean)));

/**
 * Check quotes against their sources. Without a scope it checks every citation not checked yet; a researcher names
 * its own work with --agent, --question, --claim or --source, so two branches do not read each other's pages.
 */
async function commandCheckQuotes(args) {
  const dir = requireDir(args);
  const timeoutMs = given(args.timeout) === undefined ? DEFAULT_TIMEOUT_MS : int(args.timeout, "--timeout");
  const refresh = args.refresh === true;
  const all = args.all === true || refresh;
  const led = load(dir);
  const claims = idList(args.claim);
  const questions = idList(args.question);
  const sources = idList(args.source);
  for (const id of claims ?? []) if (!led.claims.has(id)) throw new Error(`no claim ${id}`);
  for (const id of questions ?? []) if (!led.questions.has(id)) throw new Error(`no question ${id}`);
  for (const id of sources ?? []) if (!led.sources.has(id)) throw new Error(`no source ${id}`);
  const agent = given(args.agent);
  const mine = (label) => !agent || label === agent || String(label ?? "").startsWith(`${agent}/`);
  const bySource = new Map();
  for (const claim of liveClaims(led)) {
    if ((claims && !claims.has(claim.id)) || (questions && !questions.has(claim.question))) continue;
    for (const [source, citation] of claim.citations) {
      if ((sources && !sources.has(source)) || !mine(citation.agent ?? claim.agent)) continue;
      if (citation.check && !all) continue;
      if (citation.check?.result === "manual") continue;
      if (!bySource.has(source)) bySource.set(source, []);
      bySource.get(source).push({ claim: claim.id, quote: citation.quote });
    }
  }
  const events = [];
  await pool([...bySource], FETCH_CONCURRENCY, async ([id, citations]) => {
    const source = led.sources.get(id);
    if (!source) return;
    let verdicts;
    try {
      verdicts = await judgeCitations(dir, source, citations.map((citation) => citation.quote), { timeoutMs, refresh });
    } catch (err) {
      // One page that cannot be read must not stop the check of every other.
      verdicts = citations.map(() => ({ result: "unverifiable", reason: `reading the source failed (${String(err.message ?? err.name).slice(0, 120)}); confirm it by hand` }));
    }
    citations.forEach((citation, i) => events.push({ t: "check", claim: citation.claim, source: id, quote: citation.quote, ...verdicts[i] }));
  });
  if (events.length) withLock(dir, () => append(dir, events));
  const count = (result) => events.filter((event) => event.result === result).length;
  const failed = events.filter((event) => ["missing", "dead"].includes(event.result)).map(({ claim, source, result, reason }) => ({ claim, source, result, reason }));
  const unverifiable = events.filter((event) => event.result === "unverifiable").map(({ claim, source, reason }) => ({ claim, source, reason }));
  return {
    output: { checked: events.length, found: count("found"), missing: count("missing"), dead: count("dead"), unverifiable: unverifiable.length, failed, unverifiableDetail: unverifiable },
    exitCode: failed.length ? 1 : 0,
  };
}

function commandScore(args) {
  const dir = requireDir(args);
  return { output: evaluate(load(dir), { report: reportBody(dir) }) };
}

function commandStatus(args) {
  const dir = requireDir(args);
  const led = load(dir);
  const only = idList(args.question);
  for (const id of only ?? []) if (!led.questions.has(id)) throw new Error(`no question ${id}`);
  const verdict = evaluate(led, { report: reportBody(dir) });
  if (args.json === true) return { output: only ? { ...verdict, open: verdict.open.filter((question) => only.has(question.id)) } : verdict };
  return { text: statusText(verdict, led, only) };
}

/** The evidence a reader opens: the ledger, the field map with the question tree, the rounds, and what the report cites. */
function renderAll(dir, led = load(dir)) {
  const report = reportBody(dir);
  const files = { [RENDER_FILE]: render(led, { report }), [MAP_FILE]: renderMap(led, { report }), [ROUNDS_FILE]: renderRounds(led), [CITED_FILE]: renderCited(led, report) };
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(evidenceOf(dir), name), text);
  return Object.keys(files).map((name) => path.join(evidenceOf(dir), name));
}

function commandRender(args) {
  return { output: { rendered: renderAll(requireDir(args)) } };
}

function commandCheckReport(args) {
  const dir = requireDir(args);
  const led = load(dir);
  const report = reportBody(dir);
  const problems = reportProblems(led, report);
  const warnings = reportWarnings(report);
  return { output: { ok: problems.length === 0, problems, ...(warnings.length ? { warnings } : {}) }, exitCode: problems.length ? 1 : 0 };
}

/**
 * Turn each claim id the report cites into a link to that claim in evidence/cited.md: one click from a fact to
 * its quote and its source. The main agent runs it once the report is written, before the last round.
 */
function commandLinkReport(args) {
  const dir = requireDir(args);
  const led = load(dir);
  const file = path.join(dir, REPORT_FILE);
  const before = reportBody(dir);
  const { text, linked } = linkClaims(led, before);
  if (text !== before) fs.writeFileSync(file, text);
  renderAll(dir, led);
  return { output: { linked, report: file, cited: path.join(evidenceOf(dir), CITED_FILE) } };
}

const STOPS = new Set(["done", "escalate"]);

/**
 * One round of the bounded loop: score the ledger, record it, and say what comes next. The first round is the
 * baseline. A round that grew the tree scores lower and is still progress, so every round is kept; the run is done
 * only at a score of 1, and escalates when the cap is reached first. When the reading budget is spent the round
 * says wrap-up: one closing round to write the report with what is open, and then the run stops.
 */
function commandRound(args) {
  const dir = requireDir(args);
  const change = required(args, "change");
  const result = withLock(dir, () => {
    const { events } = readEvents(dir);
    const led = load(dir);
    const last = led.rounds.at(-1);
    if (last && STOPS.has(last.next)) throw new Error(`the run stopped at round ${last.n} (${last.next}); start a new run with --from ${dir} to carry on`);
    const lastAt = events.findLastIndex((event) => event?.t === "round");
    // Writing the report is work too, though it adds no event: the round keeps the report's hash to tell.
    const report = reportBody(dir);
    const reportHash = sha256(report);
    if (last && lastAt === events.length - 1 && last.report === reportHash) {
      throw new Error("nothing was recorded and research.md is unchanged since the last round: a round is the reading, claims, checks or report it added");
    }
    const verdict = evaluate(led, { report });
    const n = last ? last.n + 1 : 0;
    const gatesPassed = verdict.gates.filter((gate) => gate.pass).length;
    const gaps = () => [...verdict.gates.filter((gate) => !gate.pass).map((gate) => `${gate.name}: ${gate.problems.join("; ")}`), ...verdict.open.map((q) => `${q.id}: ${q.gaps.join("; ")}`)].join(" | ");
    const budget = led.v >= 2 ? budgetOf(led).sources : null;
    let next = "iterate";
    let reason = null;
    if (verdict.pass && verdict.score === 1) {
      next = "done";
      reason = `every in-scope question clears the ${led.depth} bar and every gate holds (score 1 at round ${n})`;
    } else if (n >= led.cap) {
      next = "escalate";
      reason = `cap of ${led.cap} rounds reached at score ${verdict.score}; still open — ${gaps()}`;
    } else if (budget?.spent && last?.next === "wrap-up") {
      next = "escalate";
      reason = `the source budget (${budget.used}/${budget.max}) was spent at score ${verdict.score}; still open — ${gaps()}`;
    } else if (budget?.spent) {
      next = "wrap-up";
      reason = `the reading budget is spent (${budget.used}/${budget.max} web sources, reading stops at ${budget.readingLimit}): read nothing new for open questions; fix quotes, settle disputes, write the report with every open question under Open questions, then record one more round`;
    }
    const event = { t: "round", n, change, score: verdict.score, answered: verdict.answered, questions: verdict.questions, gatesPassed, gates: verdict.gates.length, next, report: reportHash, ...(reason ? { reason } : {}), ...agentOf(args) };
    append(dir, [event]);
    return { verdict, event };
  });
  renderAll(dir);
  const { verdict, event } = result;
  return {
    output: {
      round: event.n,
      cap: load(dir).cap,
      score: event.score,
      answered: `${event.answered}/${event.questions}`,
      next: event.next,
      ...(event.reason ? { reason: event.reason } : {}),
      ...(verdict.budget ? { budget: budgetLine(verdict) } : {}),
      gates: verdict.gates.filter((gate) => !gate.pass).map(({ name, problems }) => ({ name, problems })),
      open: verdict.open,
      ...(verdict.warnings ? { warnings: verdict.warnings } : {}),
    },
  };
}

/** A stop is justified only when the ledger, re-scored now, still scores 1 and the last round said done. */
function commandVerify(args) {
  const dir = requireDir(args);
  const led = load(dir);
  const verdict = evaluate(led, { report: reportBody(dir) });
  const last = led.rounds.at(-1);
  const problems = [];
  if (!verdict.pass) problems.push(`the ledger is broken: ${verdict.errors.join("; ")}`);
  if (verdict.score !== 1) problems.push(`the ledger scores ${verdict.score}, not 1`);
  if (!last) problems.push("no round was recorded");
  else if (last.next !== "done") problems.push(`the last round (${last.n}) said "${last.next}", not "done"${last.reason ? `: ${last.reason}` : ""}`);
  // The script that started a run is the one that should end it: a grader edited on the way is worth a look.
  const now = scriptIdentity();
  const warnings = [...(verdict.warnings ?? [])];
  if (led.script?.sha256 && now.sha256 && led.script.sha256 !== now.sha256) warnings.unshift(`the script changed during the run (started with ${led.script.version}, now ${now.version}): the run was graded by more than one script`);
  return { output: { ok: problems.length === 0, score: verdict.score, round: last?.n ?? null, problems, ...(warnings.length ? { warnings } : {}) }, exitCode: problems.length ? 1 : 0 };
}

/** Earlier research in this project, newest first, so a new run can start from one with --from. */
function commandList(args) {
  const { root } = given(args.root) ? { root: path.resolve(String(args.root)) } : findProject();
  const runs = path.join(root, RUNS_DIR);
  const dirs = fs.existsSync(runs) ? fs.readdirSync(runs).filter((name) => fs.existsSync(path.join(runs, name, EVIDENCE_DIR, LEDGER_FILE))).sort().reverse() : [];
  return {
    output: dirs.map((name) => {
      const led = load(path.join(runs, name));
      const last = led.rounds.at(-1);
      return { dir: path.join(RUNS_DIR, name), goal: led.goal, depth: led.depth, questions: [...led.questions.values()].map((q) => `${q.id} ${q.text}`), score: last?.score ?? null, next: last?.next ?? null };
    }),
  };
}

const COMMANDS = {
  start: commandStart,
  list: commandList,
  round: commandRound,
  budget: commandBudget,
  source: commandSource,
  experiment: commandExperiment,
  reclassify: commandReclassify,
  topic: commandTopic,
  question: commandQuestion,
  park: commandPark,
  claim: commandClaim,
  cite: commandCite,
  uncite: commandUncite,
  dispute: commandDispute,
  resolve: commandResolve,
  retract: commandRetract,
  probe: commandProbe,
  audit: commandAudit,
  "audit-queue": commandAuditQueue,
  review: commandReview,
  finding: commandFinding,
  close: commandClose,
  input: commandInput,
  unreadable: commandUnreadable,
  "confirm-quote": commandConfirmQuote,
  "check-quotes": commandCheckQuotes,
  score: commandScore,
  status: commandStatus,
  render: commandRender,
  "check-report": commandCheckReport,
  "link-report": commandLinkReport,
  verify: commandVerify,
};

/**
 * The flags each command knows. A flag it does not know is refused: a typo such as --quantative used to be dropped
 * without a word, and the question was then held to a lower bar than the agent meant.
 */
const FLAGS = {
  start: { values: ["slug", "goal", "depth", "cap", "recent-years", "from", "root", "max-sources", "max-questions", "experiment-langs"], noDir: true },
  list: { values: ["root"], noDir: true },
  round: { values: ["change"], writes: true },
  budget: { values: ["max-sources", "max-questions", "reason"], writes: true },
  source: { values: ["url", "path", "line", "kind", "title", "date", "authors", "org", "origin"], writes: true },
  experiment: { values: ["command", "title", "path", "timeout"], writes: true },
  reclassify: { values: ["source", "kind", "reason", "authors", "org", "origin"], writes: true },
  topic: { values: ["text", "from"], writes: true },
  question: { values: ["text", "from", "topic", "parent", "needs"], flags: ["quantitative", "timeless"], writes: true },
  park: { values: ["question", "topic", "reason"], writes: true },
  claim: { values: ["question", "kind", "text", "source", "quote", "timeout"], flags: ["no-check"], writes: true },
  cite: { values: ["claim", "source", "quote", "timeout"], flags: ["no-check"], writes: true },
  uncite: { values: ["claim", "source", "reason"], writes: true },
  dispute: { values: ["claim", "by", "note"], writes: true },
  resolve: { values: ["claim", "outcome", "note", "by"], writes: true },
  retract: { values: ["claim", "reason"], writes: true },
  probe: { values: ["claim", "query", "found", "note"], writes: true },
  audit: { values: ["claim", "source", "verdict", "by", "note"], writes: true },
  "audit-queue": { values: ["context"] },
  review: { values: ["by", "note"], flags: ["clean"], writes: true },
  finding: { values: ["review", "text", "claim", "question"], writes: true },
  close: { values: ["finding", "how", "note"], writes: true },
  input: { values: ["ref"], writes: true },
  unreadable: { values: ["ref", "reason"], writes: true },
  "confirm-quote": { values: ["claim", "source", "how"], writes: true },
  "check-quotes": { values: ["timeout", "agent", "question", "claim", "source"], flags: ["all", "refresh"] },
  score: {},
  status: { values: ["question"], flags: ["json"] },
  render: {},
  "check-report": {},
  "link-report": {},
  verify: {},
};

function usage() {
  return `ultra-research ${VERSION} — deep research scored against a depth bar, one round at a time.

Usage: node ultra-research.mjs <command> --dir <research folder> [flags]
Every command but start and list takes --dir, the folder start printed. Writes are safe from parallel agents.
A flag a command does not know is refused. A value that starts with dashes is written --flag=value.
A research folder holds research.md (the report) and evidence/ (ledger.jsonl, ledger.md, map.md, rounds.md, cited.md,
branches/, experiments/, pages/).

The run
  start         --slug <words-with-hyphens> --goal "<what the answer is for>" [--depth quick|standard|deep]
                [--cap <rounds, default ${DEFAULT_CAP}>] [--max-sources <n>] [--max-questions <n>] [--recent-years <n>]
                [--experiment-langs <c,cpp,rust,go,...>] [--from <earlier research folder>] [--root <project>]
                                                        makes .ultra-research/<date>-<slug>/ in the project
                                                        budget by depth: ${Object.entries(DEPTHS).map(([depth, bar]) => `${depth} ${bar.maxSources} web sources, ${bar.maxQuestions} questions`).join("; ")}; 0 lifts a limit
  list          [--root <project>]                     earlier research in this project, newest first
  round         --change "<what this round did>"       score and record a round; prints next: iterate|wrap-up|done|escalate
  budget        [--max-sources <n>] [--max-questions <n>] --reason <who said so>   raise the budget, at the user's word
  verify                                               re-score; exit 0 only when it is 1 and the last round said done

Setup
  input         --ref <url|path>                       a source the user named
  unreadable    --ref <url|path> --reason <why>        a named input that could not be opened

What was read
  source        (--url <u> [--authors "<First Last, ...>"] [--org <organisation>] | --path <file> [--line <n>])
                --kind <kind> --title <t> [--date YYYY[-MM[-DD]]|n.d.]
                                                        kinds: ${Object.entries(SOURCE_KINDS).filter(([k]) => k !== "experiment").map(([k, t]) => `${k}=${t}`).join(" ")}
  experiment    --command "<shell command>" --title <t> [--path <script>] [--timeout <ms>]
                                                        runs it from the project root and saves what it printed
  reclassify    --source <S> [--kind <kind>] [--authors <names>] [--org <organisation>] --reason <why>
  topic         --text <t> --from <S>                  a topic of the field's own map (survey, textbook, course, talk)
  question      --text <t> (--from <S>|user|review | --topic <T>[,<T>]) [--parent <Q>] [--quantitative] [--timeless]
                [--needs <claim kinds>]
  park          (--question <Q> | --topic <T>) --reason <why it is out of scope>
  claim         --question <Q> --kind <kind> --text <t> --source <S> --quote <verbatim words | -> [--no-check]
                                                        kinds: ${CLAIM_KINDS.join(", ")}
                                                        the quote is read against its page as it is written
  cite          --claim <C> --source <S> --quote <verbatim words | -> [--no-check]   another source backing a claim
  uncite        --claim <C> --source <S> --reason <why>   take one source off a claim
  dispute       --claim <C> --by <S|C> --note <what disagrees>
  resolve       --claim <C> --outcome upheld|refuted|debate --note <why> [--by <S|C>]   (--by unless debate)
  retract       --claim <C> --reason <why>

Closing
  probe         --claim <C> --query "<what was searched>" --found <S>|none [--note <what it says against>]
                                                        a search for evidence against a claim the Answer cites
  audit-queue   [--context <words>]                    the cited claims that wait for an audit, with their quotes in context
  audit         --claim <C> --source <S> --verdict supports|partly|no --by <reader> [--note <why>]
                                                        does the quote say what the claim says
  review        --by <reviewer> --note <one line> [--clean]   open a review; prints its id (R<n>)
  finding       --review <R> --text <what is wrong or missing> [--claim <C>] [--question <Q>]
  close         --finding <F> --how fixed|rejected --note <what was done, or why not>

Checking and scoring
  check-quotes  [--agent <label>] [--question <Q,..>] [--claim <C,..>] [--source <S,..>] [--all] [--refresh] [--timeout <ms>]
                                                        read each cited source and look for its quote; exit 1 on a miss
  confirm-quote --claim <C> --source <S> --how <how you checked it>   only for a source no reader could open
  score                                                the score as JSON {pass, score, gates, open, budget, ...}
  status        [--question <Q,..>] [--json]           what each question and gate still needs
  render                                               write evidence/ledger.md, map.md, rounds.md and cited.md
  check-report                                         is research.md a complete report; exit 1 if not
  link-report                                          link each [C<n>] in research.md to its entry in evidence/cited.md

Any write takes --agent <label> to record which researcher made it, such as main/rls/helper-2.
Readers of a page: fetch, a headless browser (chromium), video captions (yt-dlp), the Wayback Machine. Their text is
saved in evidence/pages/. ULTRA_RESEARCH_READERS=fetch,archive narrows the list.
`;
}

/** The closest flag a command knows, for the hint under a typo. */
function closest(name, known) {
  const distance = (a, b) => {
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let diagonal = row[0];
      row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const above = row[j];
        row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
        diagonal = above;
      }
    }
    return row[b.length];
  };
  const best = known.map((flag) => ({ flag, d: distance(name, flag) })).sort((a, b) => a.d - b.d)[0];
  return best && best.d <= Math.max(2, Math.floor(name.length / 3)) ? best.flag : null;
}

export function parseArgs(argv, command) {
  const spec = FLAGS[command] ?? {};
  const values = new Set([...(spec.values ?? []), ...(spec.noDir ? [] : ["dir"]), ...(spec.writes ? ["agent"] : [])]);
  const flags = new Set([...(spec.flags ?? []), "help"]);
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--") || arg === "--") throw new Error(`unexpected argument "${arg}": every value belongs to a --flag (quote a value that holds spaces)`);
    const equals = arg.indexOf("=");
    const key = equals < 0 ? arg.slice(2) : arg.slice(2, equals);
    if (flags.has(key)) {
      if (equals >= 0) throw new Error(`--${key} takes no value`);
      out[key] = true;
      continue;
    }
    if (!values.has(key)) {
      const hint = closest(key, [...values, ...flags]);
      throw new Error(`${command} has no flag --${key}${hint ? ` (did you mean --${hint}?)` : ""}; \`--help\` lists the flags`);
    }
    if (equals >= 0) {
      out[key] = arg.slice(equals + 1);
      continue;
    }
    const next = argv[i + 1];
    // The next word is this flag's value unless it is plainly another flag; a value that starts with dashes is --flag=value.
    if (next === undefined || /^--[a-z][a-z0-9-]*(=.*)?$/.test(next)) throw new Error(`--${key} needs a value${next === undefined ? "" : ` (for a value that starts with dashes, write --${key}=<value>)`}`);
    out[key] = next;
    i++;
  }
  return out;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(usage());
    return;
  }
  if (command === "--version" || command === "-v") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  try {
    const run = COMMANDS[command];
    if (!run) throw new Error(`unknown command "${command}"`);
    if (rest.includes("--help")) {
      process.stdout.write(usage());
      return;
    }
    const args = parseArgs(rest, command);
    const { output, text, exitCode = 0 } = await run(args);
    process.stdout.write(text ?? `${JSON.stringify(output, null, 2)}\n`);
    process.exitCode = exitCode;
  } catch (err) {
    process.stderr.write(`${JSON.stringify({ error: err.message })}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main();
}
