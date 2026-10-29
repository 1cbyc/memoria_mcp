# Retrieval evaluation

Memoria publishes a ranking formula:

```
score     = 0.1 · recency + 0.1 · importance + 0.8 · relevance
relevance = 0.7 · vector cosine + 0.3 · FTS5 BM25
```

Five hand-chosen constants. Until this harness existed there was no evidence
any of them were right. This is phase 0 and 1 of the plan: a gold set, a
harness, and the baselines that make a score mean something.

```bash
npm run build
npm run eval              # local MiniLM, ~23MB model download on first run
npm run eval:hash         # no download; measures far less, see below
node eval/run.mjs --json  # machine-readable
```

## What it measures

| Metric          | Why it is here                                                                                                                                        |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **nDCG@10**     | Primary. Ranking quality with position discounting — right at rank 1 beats right at rank 9.                                                           |
| **Recall@20**   | Safety metric. Did the correct memory reach the candidate set at all, before ranking got a say? Separates a retrieval failure from a ranking failure. |
| **MRR**         | Rank of the first correct hit. Tracks the single-answer case an agent actually consumes.                                                              |
| **p95 latency** | Guards against buying accuracy with unusable speed.                                                                                                   |

Queries are grouped by what they test: **temporal** (an older answer reads as
correct, only the newer one still holds — the only queries that exercise
recency), **hard-negative** (two near-identical memories differing in one
load-bearing detail), and **paraphrase** (reworded so keyword overlap does not
carry the answer). A separate **unanswerable** set has no correct answer.

## Current results

### 2026-10: recency made real, default re-weighted

Until 2026-10 the index dated every memory by the time it was indexed, not
by its frontmatter, so every document in this corpus had the same recency
and the "temporal" group never exercised it (caveat 4 below understated
this: the recency weight was a constant). Recency now comes from the
memory's own `updated` date, and the shipped weights moved from
0.2 / 0.3 / 0.5 to **0.1 / 0.1 / 0.8**.

Run on the same corpus with `--hash` (the model download was not reachable
from the environment that made the change; **re-run with MiniLM before
quoting a MiniLM number**):

```
  configuration                 nDCG@10   R@20    MRR  stale
  old default (0.2/0.3/0.5)        33.1   80.8   25.4      2
  new default (0.1/0.1/0.8)        60.4   96.2   52.4      2
  hybrid, no priors                68.3   96.2   63.9      3

  nDCG@10 by query kind      temporal  hard-negative  paraphrase
  old default                    76.7           27.2        27.4
  new default                    57.3           51.9        63.2
  hybrid, no priors              55.0           52.6        74.9
```

Keyword matching then moved from FTS5's implicit AND (every query word must
appear in the chunk, so most natural-language queries matched nothing) to
OR, with BM25 still ranking chunks that match more and rarer words first:

```
  configuration                 nDCG@10   R@20    MRR  stale
  new default, AND                 60.4   96.2   52.4      2
  new default, OR                  61.7   96.2   55.1      2
  keyword only, AND                53.8   92.3   47.5      3
  keyword only, OR                 66.5   88.5   59.7      3
  hybrid, no priors, OR            69.9   92.3   65.7      3
```

Recall@20 falls a little for the keyword-heavy configurations (more weak
matches compete for the candidate pool); nDCG and MRR rise everywhere.

With real dates, the old weights buy the temporal queries (76.7) at a price
of roughly 25 to 50 points everywhere else. Relevance scores fall in a
narrow band while recency and importance span 0 to 1, so priors carrying
half the weight decided most rankings. A sweep over recency 0 to 0.2,
importance 0 to 0.3 and vector mix 0.5 to 0.85 ranked every
configuration with priors totalling 0.2 or less above every configuration
with 0.5. The new default keeps priors as tie-breakers rather than
dropping them: this corpus's importance values are invented (caveat 3), so
it cannot show what a real importance signal is worth, only that it must
not outweigh relevance. The vector mix was left at 0.7 on purpose; hash
vectors are lexical, so a hash sweep says nothing about the semantic half.

### Before 2026-10 (recency constant, old weights)

Run on 51 documents, 26 answerable queries, local MiniLM.

```
  configuration        nDCG@10   R@20    MRR  p95ms  stale
  shipped default         71.7  100.0   64.3      4      1
  keyword only            53.8   92.3   47.5      4      3
  vector only             96.2  100.0   95.0      4      1
  hybrid, no priors       93.0  100.0   90.7      4      2
  priors only             16.1   53.8   11.8      4      2

  nDCG@10 by query kind      temporal  hard-negative  paraphrase
  shipped default                83.3           69.8        70.3
  keyword only                   56.7           53.9        53.3
  vector only                   100.0           80.4       100.0
  hybrid, no priors              75.4           78.6       100.0
  priors only                    44.4           34.9         6.1
```

### What this suggests

**The recency and importance priors help exactly where they should, and hurt
everywhere else.** The clean comparison is `shipped default` against
`hybrid, no priors` — identical relevance settings, priors on versus off.
Priors on wins the temporal queries (83.3 against 75.4) and loses the other two
kinds badly (70.3 against 100.0 on paraphrase). Aggregated, that trade is
losing: 71.7 against 93.0.

**Abstention is currently impossible.** Mean top score is 0.6097 for answerable
queries and 0.5388 for unanswerable ones, and the ranges overlap — no threshold
separates them. A caller cannot tell "here is your answer" from "I have
nothing" by looking at the score. That is phase 4's problem and this is the
measurement that motivates it.

### What this does NOT establish

The confounds are large enough that the table above is a starting point, not a
verdict. Read these before quoting any number:

1. **The same party wrote the system, the corpus and the queries.** That is the
   weakest possible position for a benchmark. Every number here should be
   treated as provisional until it is reproduced on a corpus this project did
   not author — LongMemEval or similar, which is phase 3.

2. **The paraphrase rule is structurally hostile to BM25.** Queries were
   deliberately written to avoid the answer's wording, because a query sharing
   surface tokens with its answer teaches nothing about the vector half. That
   choice is right for testing semantics and it means `keyword only` (53.8) is
   a floor, not a fair assessment of BM25. Do not conclude that keyword search
   is weak in general; conclude that it cannot carry paraphrased queries alone.

3. **The importance values are invented.** Every document's importance was
   assigned by hand with no underlying reality, so in this corpus importance is
   close to noise. "Priors hurt by 21 points" therefore partly measures "adding
   a noise term hurts", which is unsurprising. In a real store importance
   reflects something. This corpus cannot tell you whether the 0.3 weight is
   right; it can only tell you the weight is not free.

4. **The temporal queries do not isolate recency as cleanly as intended.**
   `vector only` scores 100.0 on them with recency switched off entirely,
   because the superseding documents also happen to be the more semantically
   on-point ones — a memory that says "reversing the earlier decision" matches
   "what did we settle on" on content alone. A sharper temporal set would use
   pairs that are semantically indistinguishable and differ only in date.

5. **The corpus is small.** At 51 documents, Recall@20 is nearly free — most
   configurations score 100 because 20 slots over 51 documents is not a
   selective filter. Growing the corpus is the single highest-value improvement
   to this harness, and it is why the recall column is currently uninformative.

6. **One provider, one run.** Scores from different embedding providers are not
   comparable and must never appear in the same table. The provider is printed
   with every result for this reason.

## Method

- The store is built fresh in a temp directory each run and deleted afterwards,
  so runs cannot contaminate one another.
- The harness calls `MemoryStore.search()` directly rather than going through
  the MCP tool. The tool layer bumps `last_accessed` on every returned file,
  and that feeds the recency signal — benchmarking through it would let each
  query alter the ranking seen by the next one.
- Document dates are relative to the run rather than fixed calendar dates, so
  the recency signal behaves identically whenever this is run.
- Relevance is binary. A document is a correct answer or it is not.

## Gold set construction rules

These are the rules the queries were written to, and the reason to trust the
set as far as it goes:

1. **Paraphrase every query.** No query reuses its answer's distinctive wording.
2. **Plant hard negatives.** Where two memories cover one topic, the query
   targets the detail that separates them.
3. **Include temporal pairs.** Two plausible answers, only the newer true.
4. **Label before tuning.** The gold set was frozen before any configuration was
   swept, so the weights cannot be fitted to answers adjusted afterwards.
5. **Report the failures.** The harness prints its five worst queries every run.
   A benchmark with no visible failures is one nobody should believe.

## Not in CI

This is deliberate. The default provider downloads a ~23MB model on a cold
cache, which is a poor fit for every pull request. `npm run eval:hash` runs
without any download but substitutes the n-gram fallback for real embeddings,
which changes what is being measured rather than merely making it cheaper.

Gating merges on nDCG@10 and Recall@20 floors is phase 3, and should wait until
the corpus is large enough for those numbers to be stable.
