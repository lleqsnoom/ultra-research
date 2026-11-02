# The report

`research.md` holds the report and nothing else, so replace the stub. `UR check-report` checks that:

- each section the depth needs is there, with real content;
- every `[C<n>]` names a live claim;
- every question has a claim cited;
- every debate is cited under "Where experts disagree";
- every input that could not be read is named;
- the Evidence section links `evidence/ledger.md` and names every quote that was checked by hand or never checked.

Text in comments and code blocks doesn't count.

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
8. **Open questions.** What is still unsettled, and what would settle each.
9. **Evidence.** Link [the ledger](evidence/ledger.md) and [the map](evidence/map.md). Give the sources by tier,
   the inputs not read, the quotes not checked, and the reviewer.

## Rules

- **Cite every fact:** "Keyset pagination kept page 1,000 under 5 ms, where OFFSET took 480 ms in our test [C14]".
  `[C3, C7]` is a citation; `[RFC 9110 §9.2]` is not. A sentence without a citation is your own reasoning, so say
  so.
- **Numbers keep their conditions:** "2.1× the throughput on Postgres 16, with 1M rows and 50 connections [C22]".
- **Say how sure you are, and why.**
- **Use plain words (B2 level)** in the Answer and the Glossary.
- **Add no new facts here.** Record them in the ledger first.
