# Frame, then map

## Frame

Read the project first (README, manifests, configs, the code involved), so the user mostly confirms. Read the user's
standing rules too (CLAUDE.md, AGENTS.md and the like): the ones that apply to subagents go into every brief. Then ask
one round of at most five questions, with your recommended option first:

- What is the answer for: to decide, to build, to learn, or to review?
- What is the context: stack, versions, scale, team, deadline? For example "Postgres 16, multi-tenant SaaS, 50
  tenants" or "Node 22 API on Kubernetes, 2k req/s".
- What does good look like: how fast, secure against whom?
- What is already known or tried?
- How large may the run be? Offer the depth with its budget: `quick` (12 web sources), `standard` (60), `deep` (150),
  or a number of their own.

When the request already answers a question, don't ask it: state what you took from it and go on.

Never ask the user to judge the domain ("should we look at connection pooling?"). With no web access, say so. The
run can then reach only `quick` depth, on local files.

## Map

Send one scout per source where experts lay out the field:

1. **Surveys and review papers.** Search Google Scholar, Semantic Scholar and arXiv for "survey", "state of the art"
   or "taxonomy".
2. **Textbooks and courses.** Read the tables of contents and university syllabi.
3. **Practitioner talks and guides.** For example QCon, Strange Loop, PGConf, USENIX and re:Invent talks, OWASP cheat
   sheets, and vendor architecture guides.
4. **Official docs.** The tables of contents for the user's stack. These add topics but don't count as map sources.
5. **Reference implementations.** The most-used ones on GitHub.

`deep` needs at least 2 tier B map sources, by different authors.

## Go deeper

- **Follow citations both ways.** Read what a key paper cites, and find who cites it since, through Semantic
  Scholar (`.../graph/v1/paper/arXiv:<id>/citations`) or OpenAlex (`/works?filter=cites:<id>`).
- **Search the critiques:** "<x> pitfalls", "<x> vs", "<x> considered harmful", "<x> benchmark".
- **Follow the people.** Read the newest work of authors whose names recur.
- **Go to the source.** Read the primary source behind every secondary claim.

## Record

```bash
UR source --dir <dir> --url <survey URL> --kind survey --title "<title>" --date <YYYY> --authors "<First Last, First Last>"
UR topic --dir <dir> --text "Row-level security" --from S1
UR question --dir <dir> --topic T1 --text "What does row-level security cost per query, and how is it measured?"
UR park --dir <dir> --topic T7 --reason "cross-region sharding: the user runs one Postgres instance"
```

- Ask every topic as a question, or park it.
- A question covers at most 2 topics, and parked topics don't count toward the map.
- Ask expert questions: mechanisms, trade-offs, limits, measurements.
- `--parent` nests a question under another. `--quantitative` marks a question whose answer is a number.
- Keep adding the questions sources raise, with `--from S<n>`.

## Size the run, then go on

The question budget is the size of the tree, and each open question needs up to 3 independent sources at `deep`.
`UR status` shows both: the budget, and how many independent sources the open questions still lack.

- Park by the user's goal: a topic their context rules out is parked with that reason. Never ask the user to pick
  branches of a field they do not know.
- When the tree needs more than the budget holds, park the branches that matter least to the goal, and say which.
- Show the user `evidence/map.md` and one line on the size ("21 questions, about 60 sources, budget 150"). Then go
  on with the baseline. The user can redirect at any time; don't wait for an answer.
- Only the user raises a budget: `UR budget --max-sources <n> --reason "<who said so>"`.
