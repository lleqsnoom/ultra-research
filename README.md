# ultraresearch

An agent skill for deep research on a topic you don't know yet. It maps the field, sends agents to read in parallel,
and scores every answer against a depth bar backed by quotes checked on their pages.

```bash
npx skills add lleqsnoom/ultraresearch
```

Then ask your agent: "ultraresearch row-level security vs schema-per-tenant for our Postgres SaaS".

Each run writes `.ultraresearch/<date>-<slug>/research.md`, with its evidence in `evidence/` beside it.

Needs Node.js 20+. Optional: `pdftotext` (poppler), to check quotes in PDFs.

MIT
