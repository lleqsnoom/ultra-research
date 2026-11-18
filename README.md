# ultra-research

**A mountain of sources in. Pure knowledge out.**

Your research buddy browses papers, docs, specs and talks, then distills them into one clear report, with every
fact traced to where it came from.

## TL;DR

**Claude Code**

```bash
npx skills add lleqsnoom/ultra-research -g -a claude-code
```

```text
/ultra-research row-level security vs schema-per-tenant for our Postgres SaaS
```

**Codex**

```bash
npx skills add lleqsnoom/ultra-research -g -a codex
```

```text
$ultra-research row-level security vs schema-per-tenant for our Postgres SaaS
```

You get `.ultra-research/<date>-<slug>/research.md`. Needs Node.js 20+. MIT

## What it checks

A script, not the agent, decides when a question is answered:

- **Quotes are read on the page** as each claim is written, by a plain fetch, a headless browser, video captions or
  the Wayback Machine. A misquote is refused.
- **Independent sources are counted by author**, not by web host: two papers that share an author are one voice.
- **A budget bounds the run**: 150 web sources at `deep`, 60 at `standard`, 12 at `quick`, or your own number.
- **The answer is tested**: a search against every conclusion, and every cited quote read against its claim by an
  agent that did not write it.
- **A review counts only when each finding is closed.**

Optional tools let it check more pages: `pdftotext`, `chromium` or `chrome`, `yt-dlp`, `unzip`.

## Changes in 3.0

- New commands: `probe`, `audit`, `audit-queue`, `finding`, `close`, `uncite`, `budget`, `link-report`.
- `--authors` and `--org` replace `--origin`. A flag a command does not know is now refused.
- Runs made by an earlier version keep the rules they were made under.
