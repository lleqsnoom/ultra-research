# The depth bar

`UR status --dir <dir>` names what each open question still lacks.

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

Sources count by origin, meaning who stands behind them, and the script derives the origin from the URL:

- Two pages of the PostgreSQL docs are one voice. Two GitHub owners are two voices.
- Each arXiv paper and each DOI is its own voice.
- The project's own files count as one voice, and the run's experiments as one more.
- `standard` and `deep` also need a source from outside the project.
- Use `--origin` only for one author across two domains, never to make one author count twice.
- Files under `.ultra-research/` are never sources.

## What a question needs

| Depth | Sources | Primary | Claim kinds | Recency | Quotes |
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

## Quotes

- Copy at least 5 words in a row, verbatim. Around an ellipsis, each part needs at least 3 words. Matching ignores
  punctuation, markup and accents.
- One sentence backs one claim.
- Quotes from local files and experiment output are checked as you write them. Quotes from URLs are checked by
  `check-quotes`, with one of three results:
  - **found**: the quote is on the page.
  - **missing** or **dead**: the citation stops counting. Cite the real words, or `retract` the claim.
  - **unverifiable**: a 403, a paywall, a page drawn by JavaScript, a PDF with no `pdftotext`, or a page that only
    echoes its own URL. Only this result may be confirmed by hand (`confirm-quote --how`). The report must name
    every claim that rests on a hand check.
- `--quote -` reads the quote from stdin.

## Disputes

Record one with `dispute --claim <C> --by <S> --note <what disagrees>`. Settle it one of two ways:

- `resolve --outcome upheld|refuted --by <S>`, with stronger evidence.
- `--outcome debate --note <why both hold>`. The report must then cite it under "Where experts disagree".

A topic with no dispute was usually read too narrowly.

## Saturation

Saturation walks back from the newest source. It counts the authors whose tier A or B pages, from outside the
project, only confirmed claims the ledger already held: each page was only cited, and none started a claim, a
question, a topic or a dispute. A source no claim cites doesn't count. `deep` needs 5 such authors and `standard`
needs 3. When saturation never arrives, the tree is too small: add or park the questions the sources keep raising.

## Experiments

A measurement beats opinions. For example:

- **APIs:** load-test both variants with one script (k6, wrk, autocannon) on one machine. Compare p50 and p99
  latency and throughput.
- **Databases:** run the query, index, policy or isolation level against a throwaway database in Docker. Read its
  `EXPLAIN ANALYZE` output, or attempt the attack it should stop.
- **Architecture:** build both designs at small scale, such as a queue against polling or a cache against none,
  and measure them under the same load.

```bash
UR experiment --dir <dir> --path <dir>/evidence/experiments/bench.mjs \
  --command "node <dir>/evidence/experiments/bench.mjs" --title "OFFSET vs keyset pagination on 1M rows"
```

The command runs from the project root, and a non-zero exit is refused. The output is saved with a hash, and an
edited output stops counting. Quote the output in your claims. Never touch production.

## What no script checks

No script can check these, so the reviewer does:

- whether claims are labelled with the right kind;
- whether each quote fits its claim;
- dates;
- whether experiment commands are honest;
- hand checks and reviews;
- park reasons;
- sources that were read but never recorded.
