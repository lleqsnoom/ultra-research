# The depth bar

`UR status --dir <dir>` names what each open question and gate still lacks. `UR status --question Q3,Q4` shows only
those questions.

## Tiers

The tier follows from `--kind`:

| Tier | Kinds |
|---|---|
| A | `spec`, `paper`, `docs` (first-party only), `code`, `data`, `experiment` |
| B | `survey`, `textbook`, `course`, `talk` |
| C | `article`, `forum`, `video`, `other` |

- A tier C source adds at most one voice and never answers a question alone.
- Fix a misfiled source with `reclassify --source <S> --kind <kind> --reason <why>`.
- Only tier B sources count toward the field map.

## Independent sources

Sources count by voice, meaning who stands behind them. Three things decide it:

1. **The site.** On a publisher or video site the work itself is the site: each arXiv paper, each DOI, each YouTube
   video, each GDC Vault talk, each paper in the ACM or IEEE library. Elsewhere it is the site's owner: two pages of
   the PostgreSQL docs are one site, two GitHub owners are two.
2. **A source that names no people speaks for its site.** All such sources on one site are one voice, however the
   organisation is spelled.
3. **Sources that share a person or an organisation are one voice**, wherever they are. Five papers by one research
   group are one voice. "J. Smith" is "John Smith".

So name who stands behind each web source:

- `--authors "Ada Lovelace, Alan Turing"` for a paper, a talk, an article or a mailing-list post. First name first,
  split by commas.
- `--org "PostgreSQL"` for docs and other pages with no named author.
- Fix them with `reclassify --source <S> --authors <names> --reason <why>`.

`status` lists every site that carries sources under different authors. Check that they are different people.

- The project's own files count as one voice, and the run's experiments as one more.
- `standard` and `deep` also need a source from outside the project.
- Files under `.ultra-research/` are never sources.

## What a question needs

| Depth | Voices | Primary | Claim kinds | Recency | Quotes |
|---|:-:|:-:|---|---|---|
| quick | 1 | 0 | any | any | not shown missing |
| standard | 2 | 1 | `mechanism` | any | all checked |
| deep | 3 | 1 | `mechanism`, `limit` | 5 years | found or hand-confirmed; at least one found |

- `mechanism` says how or why it works. `limit` says when it doesn't apply or what it costs.
- A question marked `--quantitative` needs a `number` claim backed by a tier A source.
- Recency counts only tier A and B sources.
- `--timeless` exempts a settled result, such as B-trees or two-phase commit. Never use it for anything that
  changes: cloud services, security advice, library APIs.
- `--recent-years <n>` on `start` sets the recency window.
- `--needs comparison` adds a required kind.
- A question with sub-questions is answered when they are.

## Budget

A run has a budget of web sources and of questions, set at `start` by depth or by `--max-sources` and
`--max-questions` (0 lifts a limit). The project's own files and experiments cost nothing.

- `status` shows the spend, and how many independent sources the open questions still lack.
- The last 15% of the source budget is kept for closing work: a broken quote, a probe's hit, a reviewer's finding.
  When reading reaches that line, `round` says `wrap-up`: read nothing new for open questions, write the report with
  what is open, and record one more round. If the bar is still not cleared, that round says `escalate`.
- At the budget, `source` and `question` are refused. Park a question to make room for another.
- Only the user raises a budget: `budget --max-sources <n> --reason "<who said so>"`.

## Quotes

- Copy at least 5 words in a row, verbatim. Around an ellipsis, each part needs at least 3 words. Matching ignores
  punctuation, markup and accents.
- One sentence backs one claim. Take a source off a claim with `uncite`.
- A quote is read against its source as you write it. Local files and experiment output are read from disk. A web
  page is read by these readers in turn, until one finds the words:
  1. captions, for a video (`yt-dlp`): what a talk says is in its captions, not on its page;
  2. a plain fetch, which also reads PDFs (`pdftotext`) and slide decks with their speaker notes (`unzip`);
  3. a headless browser (`chromium` or `chrome`), for a page drawn by JavaScript;
  4. the Wayback Machine, for a page that is gone or that nothing else could open.
- Each reader's text is saved in `evidence/pages/`, which git ignores. `check-quotes --refresh` reads a page anew.
- The results:
  - **found**: the quote is on the page.
  - **missing** or **dead**: a write is refused. Cite the real words, or the source that says them.
  - **unverifiable**: no reader could open the page (a paywall, a bot check, a missing tool). The claim is recorded,
    and only this result may be confirmed by hand (`confirm-quote --how`). The report must name every claim that
    rests on a hand check.
- `check-quotes` re-reads what is not checked yet. A researcher scopes it to its own work: `--agent <label>`,
  `--question`, `--claim` or `--source`.
- `--no-check` on `claim` and `cite` leaves a web quote to `check-quotes`. `ULTRA_RESEARCH_READERS=fetch,archive`
  narrows the readers, on a host that must not start a browser.
- `--quote -` reads the quote from stdin.

## Disputes

Record one with `dispute --claim <C> --by <S> --note <what disagrees>`. Settle it one of two ways:

- `resolve --outcome upheld|refuted --by <S>`, with stronger evidence.
- `--outcome debate --note <why both hold>`. The report must then cite it under "Where experts disagree".

A topic with no dispute was usually read too narrowly.

## Probe: search against the answer

Once the report is drafted, search for evidence **against** each claim the Answer cites. Use the critique searches:
"<x> pitfalls", "<x> vs", "<x> fails", "<x> benchmark", and the newest work that cites the claim's source.

```bash
UR probe --dir <dir> --claim C12 --query "row-level security overhead benchmark regression" --found none
UR probe --dir <dir> --claim C12 --query "RLS planner cost large IN lists" --found S40 --note "S40 measures 4x on joins"
```

- `--found none` says the search turned up nothing against the claim.
- `--found S<n>` opens a dispute by that source, which blocks the claim's question until it is settled.
- Record the source first; it comes out of the closing reserve of the budget.
- The gate holds when every claim the Answer cites has a probe. The words of each search stay in the ledger, so a
  reader can judge it.

`status` still shows saturation: how many of the newest authors only confirmed what the ledger held. It is an
indicator. It is not a gate, because a closing pass can always supply confirming sources.

## Audit: does the quote say the claim?

The script shows that a quote is on its page. It cannot show that the quote says what the claim says. So each claim
cited where the reader decides (the Answer, and at `deep` the Decision guide) is read against its quote by someone
who did not write it.

```bash
UR audit-queue --dir <dir>            # the claims that wait, each with its quotes and the words around them
UR audit --dir <dir> --claim C12 --source S3 --verdict supports --by verifier-1
UR audit --dir <dir> --claim C14 --source S9 --verdict partly --by verifier-1 --note "the quote covers Postgres 16 only"
```

- Hand the queue to verifiers in shares. A verifier gets the claim, the quote and its context, and nothing else. Use
  another model family when the host has one.
- `supports`: the quote says the claim. `partly`: it says less, or under a condition the claim drops. `no`: it does
  not say it.
- After `partly` or `no`: cite words that say the claim, take the source off with `uncite`, or `retract` the claim
  and record what the quote does say. The worst verdict on the same words stands.
- The gate holds when each cited claim has a citation audited `supports`, and none audited `partly` or `no`.

## Experiments

A measurement beats opinions. For example:

- **APIs:** load-test both variants with one script (k6, wrk, autocannon) on one machine. Compare p50 and p99
  latency and throughput.
- **Databases:** run the query, index, policy or isolation level against a throwaway database in Docker. Read its
  `EXPLAIN ANALYZE` output, or attempt the attack it should stop.
- **Architecture:** build both designs at small scale, such as a queue against polling or a cache against none,
  and measure them under the same load.

```bash
UR experiment --dir <dir> --path <dir>/evidence/experiments/bench.c \
  --command "cc -O2 <dir>/evidence/experiments/bench.c -o /tmp/bench && /tmp/bench" --title "OFFSET vs keyset pagination on 1M rows"
```

The command runs from the project root, and a non-zero exit is refused. The output is saved with a hash, and an
edited output stops counting. Quote the output in your claims. Never touch production.

When the host limits the languages of experiments, start the run with `--experiment-langs c,cpp,rust,go`. The tool
then refuses an experiment plainly written in another language. It is a guard-rail, not a lock: the rule itself goes
into every brief.

## What no script checks

No script can check these, so the reviewer does:

- whether claims are labelled with the right kind;
- dates;
- whether authors and organisations are named truly, above all on the sites `status` lists;
- whether experiment commands are honest;
- whether a probe's search was a fair one;
- hand checks, audits and reviews;
- park reasons;
- sources that were read but never recorded.
