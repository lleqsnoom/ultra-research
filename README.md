# ultraresearch

An agent skill for deep research on a topic you are not an expert in: shader optimization, secure database
patterns, generative life algorithms, whatever you need to understand well enough to decide or build.

Asking an agent to "research X" usually gets you a confident summary of the first sources it found. You can't tell
whether that summary is deep, because you don't know the field. ultraresearch measures depth instead of trusting it:

- **It maps the field first.** Scout agents read the field's surveys, textbooks, courses and talks, and the
  questions come from how experts divide the topic, not from a first guess.
- **Every claim carries an exact quote,** and a script fetches the page (HTML, GitHub files, PDFs) and checks
  that the words are there.
- **Depth is scored per question.** A `deep` question needs three independent authors, a primary source (spec,
  paper, vendor docs, code or a measurement), how it works, where it fails, and a strong source from the last five
  years. A blog never answers a question alone.
- **Disagreements are findings.** Conflicting sources are settled with stronger evidence or a test, or reported as
  an open debate, with both sides cited.
- **It tests claims when it can.** The script runs your experiment itself and stores what it printed, with a hash.
- **It stops when reading stops teaching.** The run ends only when every question meets the bar and the newest
  sources, from five different authors, add nothing new. A round cap is the backstop.
- **An outside reviewer** checks what an expert would say is missing before the run can finish.
- **The report teaches.** It holds the answer for your context, a glossary, a map of the field, a decision table,
  the open debates, next steps and a reading path, and every fact in it is tied to a quoted claim.

## Install

With the [skills CLI](https://skills.sh):

```bash
npx skills add lleqsnoom/ultraresearch
```

Or by hand: clone this repo and copy or symlink `skills/ultraresearch` into your agent's skills folder, for example
`~/.claude/skills/ultraresearch` for Claude Code.

You need Node.js 20 or newer, and web access for the agent. Install `pdftotext` (poppler, e.g.
`apt install poppler-utils` or `brew install poppler`) to check quotes inside PDFs; without it, a PDF's quotes are
marked unverifiable and must be confirmed by hand. The script has no dependencies.

## Use

Ask your agent for it: "ultraresearch the best methods for optimizing fragment shaders on mobile GPUs", or "deep
dive into row-level security patterns for multi-tenant Postgres". The agent asks a few questions about your goal and
context, shows you the field map to choose branches from, and then works in rounds until the run is done or reaches
its cap.

| Depth | For | Cost |
|-------|-----|------|
| `deep` (default) | a topic you must understand to decide or build | high: many agents, dozens of sources |
| `standard` | a bounded comparison you can judge yourself | medium |
| `quick` | one narrow fact | low: no agents |

## What it writes

Each research run gets its own folder in the project. The report is the only file at the top. Everything that
supports it sits in `evidence/`:

```text
.ultraresearch/
  2026-11-02-shader-optimization/
    research.md        the report
    evidence/
      ledger.jsonl     the evidence log the score is computed from
      ledger.md        sources, claims and quotes, readable
      map.md           the field map and the question tree
      rounds.md        each round's score and what came next
      branches/        each researcher's notes
      experiments/     experiment scripts and their saved output
```

Commit the folder if you want to keep the research. A later run can build on it with `start --from`, which keeps
the sources and claims and redoes the quote checks and the review, because pages change.

## Agents

Agents are how the run goes deep. The main agent starts scouts for the field map, a researcher per branch of the
question tree, and a reviewer. Any agent may start its own helpers, at any depth. The one rule is that a delegate
always gets a strictly smaller piece of its parent's work, never the whole task. That rule stops an agent from
re-running the whole research inside itself. All agents write to one shared ledger, which is safe from parallel
writers, and only the main agent records rounds and writes the report. See
[`references/agents.md`](skills/ultraresearch/references/agents.md).

## What no script can check

The scoring closes every gap a script can see. Some it cannot:

- whether a quote actually supports its claim;
- whether a claim labelled "limit" really states a limit;
- whether the dates are right;
- whether a hand-confirmed quote or a review really happened.

These are listed in [`references/depth.md`](skills/ultraresearch/references/depth.md), and the reviewer checks them
by hand.

## Develop

```bash
npm test
```

The tests run the script against a local HTTP server, so they need no network.

## License

MIT
