# Frame, then map

## Frame

Read the project first (README, manifests, configs, the code involved), so the user mostly confirms. Then ask one
round of at most four questions, with your recommended option first:

- What is the answer for: to decide, to build, to learn, or to review?
- What is the context: stack, versions, scale, team, deadline? For example "Postgres 16, multi-tenant SaaS, 50
  tenants" or "Node 22 API on Kubernetes, 2k req/s".
- What does good look like: how fast, secure against whom?
- What is already known or tried?
- Which depth?

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
UR source --dir <dir> --url <survey URL> --kind survey --title "<title>" --date <YYYY>
UR topic --dir <dir> --text "Row-level security" --from S1
UR question --dir <dir> --topic T1 --text "What does row-level security cost per query, and how is it measured?"
UR park --dir <dir> --topic T7 --reason "cross-region sharding: the user runs one Postgres instance"
```

- Ask every topic as a question, or park it.
- A question covers at most 2 topics, and parked topics don't count toward the map.
- Ask expert questions: mechanisms, trade-offs, limits, measurements.
- `--parent` nests a question under another. `--quantitative` marks a question whose answer is a number.
- Show `evidence/map.md` to the user so they can pick branches. Park the rest with their reason.
- Keep adding the questions sources raise, with `--from S<n>`.
