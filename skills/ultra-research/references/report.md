# The report

`research.md` holds the report and nothing else, so replace the stub. `UR check-report` checks that:

- each section the depth needs is there, with real content;
- every `[C<n>]` names a live claim;
- every question has a claim cited;
- every debate is cited under "Where experts disagree";
- every input that could not be read is named;
- the Evidence section links `evidence/ledger.md` and names every quote that was checked by hand or never checked.

Text in comments and code blocks doesn't count. `check-report` also warns about each sentence of the Answer that
states a measure ("12 ms", "40%", "2.1×") and cites no claim.

## Sections

Use `##` headings. `quick` needs only Answer and Evidence. `standard` drops Next steps and Reading path. Any run
with a debate needs "Where experts disagree".

1. **Answer.** The recommendation for the user's context first, then why, and how sure you are.
2. **Glossary.** 10 to 20 terms, one plain sentence each.
3. **Map of the field.** The families of approaches, and what each is for and not for.
4. **Decision guide.** A table: option, when to use it, gains (with numbers), costs, pitfalls, claims.
5. **Where experts disagree.** Both sides, who holds each, and when each is right.
6. **Next steps.** In order, each with how to tell it worked.
7. **Reading path.** 5 to 10 sources, from beginner to advanced.
8. **Open questions.** What is still unsettled, and what would settle each. After a `wrap-up`, every question the
   budget left open goes here.
9. **Evidence.** Link [the ledger](evidence/ledger.md), [the cited claims](evidence/cited.md) and
   [the map](evidence/map.md). Give the sources by tier, the inputs not read, the quotes not checked, what the
   probes searched for, and the reviewer.

## Rules

- **Cite every fact:** "Keyset pagination kept page 1,000 under 5 ms, where OFFSET took 480 ms in our test [C14]".
  `[C3, C7]` is a citation; `[RFC 9110 §9.2]` is not. In a table cell, write the ids in brackets too. A sentence
  without a citation is your own reasoning, so say so.
- **Numbers keep their conditions:** "2.1× the throughput on Postgres 16, with 1M rows and 50 connections [C22]".
- **Say how sure you are, and why.**
- **Use plain words (B2 level)** in the Answer and the Glossary.
- **Add no new facts here.** Record them in the ledger first.

## Before the last round

The claims the Answer cites are the ones the reader acts on, so they are tested once the draft stands
(`depth.md`): `probe` each of them, and have each claim cited in the Answer and the Decision guide audited. A claim
that fails changes the report, so do this before the steps below.

1. `UR render` writes `evidence/cited.md`: only the claims the report cites, each with its quote and its source.
2. `UR check-report` must pass.
3. `UR link-report` turns each `[C14]` into a link to that claim in `evidence/cited.md`. Run it once the text is
   final; running it again changes nothing.
4. Record the final `UR round`.
