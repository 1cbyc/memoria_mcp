import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Force the deterministic n-gram provider in tests so the suite never
    // downloads or loads the MiniLM model. setup.ts must run before any module
    // imports embeddings.ts.
    setupFiles: ["./src/__tests__/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "text"],
      include: ["src/**/*.ts"],
      exclude: ["src/__tests__/**", "src/**/*.d.ts"],
      // Floors set a few points below current coverage so a real regression
      // FAILS CI (the suite was previously green through two prod outages on
      // uncovered code) without small v8 line-counting wobble false-failing.
      // Ratchet these up as coverage grows; never lower them.
      // 2026-07 (Phase 4): global raised 33 -> 50 and per-file floors added for
      // every high-risk module after tools.test.ts + the phase 1-3 suites
      // lifted overall lines 37% -> ~55% (tools.ts 9% -> 56%).
      //
      // 2026-09: RE-BASELINED for vitest 4, which is a different instrument,
      // not weaker tests. v4 makes AST-aware remapping the default, so it
      // counts real syntactic branches and functions instead of v8's coarse
      // ranges. Measured on identical source with the same 248 passing tests:
      //
      //             vitest 3              vitest 4
      //   branches  827/1128  = 73.31%    914/2142 = 42.67%
      //   functions 190/290   = 65.51%    280/489  = 57.25%
      //   stmts     4423/7539 = 58.66%    2133/3885 = 54.90%
      //
      // Absolute covered branches went UP (827 -> 914); the denominator nearly
      // doubled because v4 sees branches v3 never counted. The percentages
      // below are therefore re-derived against the new instrument using the
      // same "a few points under measured" policy. This is the one case where
      // lowering a number is not a relaxation -- do not treat it as licence to
      // lower them again. Against v4, ratcheting up still applies.
      thresholds: {
        lines: 50,
        statements: 50,
        functions: 52,
        branches: 38,
        // Per-file floors, buffered ~4-5pts below measured coverage.
        "src/http.ts": { lines: 52, statements: 52 },
        "src/dashboard.ts": { lines: 40, statements: 40 },
        "src/wiki.ts": { lines: 95, statements: 95 },
        "src/tools.ts": { lines: 50, statements: 50 },
        "src/embeddings.ts": { lines: 44, statements: 44 },
        "src/store.ts": { lines: 88, statements: 88 },
        "src/entities.ts": { lines: 90, statements: 90 },
        "src/lint.ts": { lines: 72, statements: 69 },
        "src/collector/ingestion.ts": { lines: 85, statements: 85 },
        "src/collector/buffer.ts": { lines: 74, statements: 74 },
        // Daemon floor raised 31/28 -> 90/84 after daemon.test.ts (2026-10)
        // measured 95.9 lines / 89.4 statements on the full suite.
        "src/collector/daemon.ts": { lines: 90, statements: 84 },
        "src/collector/provenance.ts": { lines: 80, statements: 80 },
      },
    },
  },
});
