# Carry-over: classify by canonical evidence lines, then carry only reviewed `same` values

"Unchanged evidence" means: the extracted values are equal **and** some occurrence of the new quote expands to the same canonical stored line as the baseline's. Carry-over is blocked for weak lines (scalars only), a parser change, hidden text, conflicting lines, or an added line with the same label and a different value. Classification (`new`/`same`/`changed`) never depends on whether the baseline was reviewed. A review carries only onto `same` values whose baseline review isn't a revert. This makes carry-over independent of which span the LLM chose and robust to inserted paragraphs, and it yields exactly {due_date, total_amount} on the fixture.

**Considered options:** a hash of the raw LLM quote (nondeterministic spans); a whole-document diff (breaks when text shifts); an LLM semantic diff (nondeterministic, untestable).
