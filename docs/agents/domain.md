# Domain docs

**Layout: single-context.**

- `GLOSSARY.md` at the repo root holds the domain language. Read it before naming anything, and
  add terms when you resolve one.
- `docs/adr/NNNN-slug.md` records surprising decisions (sequential numbers, created when needed).
  Read the related ADRs before changing behaviour they cover.
- The behaviour spec is `docs/superpowers/specs/2026-11-27-document-review-design.md`. When the
  spec and an ADR disagree, the newer one wins, and the older one must be updated in the same
  change.
