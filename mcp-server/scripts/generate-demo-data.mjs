#!/usr/bin/env node
/**
 * Generate a self-contained DEMO memory store with made-up data, so the
 * dashboard (and the wiki) can be showcased without touching real memories.
 *
 * Usage:
 *   node scripts/generate-demo-data.mjs [--out <dir>]
 * Default --out: <repo>/demo-store   (memories land in <out>/memories)
 *
 * Persona: "Alex Rivera", an indie developer. Memories cross-link via
 * `related:` frontmatter and [[wiki links]] so backlinks/graph populate, and
 * use rich markdown (headings, lists, code, tables, blockquotes) to show off
 * the renderer.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");

// ── args ─────────────────────────────────────────────────────
const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const OUT = path.resolve(outIdx >= 0 ? args[outIdx + 1] : path.join(repoRoot, "demo-store"));
const MEM = path.join(OUT, "memories");

// ── deterministic RNG so the demo is reproducible ────────────
let _seed = 1337;
const rng = () => (_seed = (_seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = (arr) => arr[Math.floor(rng() * arr.length)];
const chance = (p) => rng() < p;

// ── date helpers (relative to today) ─────────────────────────
const today = new Date();
const ymd = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => {
  const d = new Date(today);
  d.setDate(d.getDate() - n);
  return d;
};
const ampm = (h, m) => {
  const ap = h < 12 ? "AM" : "PM";
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, "0")} ${ap}`;
};

// ── writer ───────────────────────────────────────────────────
function writeMem(rel, fm, body) {
  const created = fm.created || ymd(daysAgo(40));
  const front = [
    "---",
    `name: ${fm.name}`,
    `description: ${fm.description}`,
    `type: ${fm.type}`,
    `importance: ${fm.importance}`,
    `created: ${created}`,
    `updated: ${fm.updated || created}`,
    `last_accessed: ${fm.last_accessed || ymd(daysAgo(Math.floor(rng() * 10)))}`,
    `access_count: ${fm.access_count ?? Math.floor(rng() * 15)}`,
    `tags: [${(fm.tags || []).join(", ")}]`,
    `origin: ${fm.origin || "chat"}`,
    ...(fm.related ? [`related: [${fm.related.join(", ")}]`] : []),
    ...(fm.valid_from ? [`valid_from: ${fm.valid_from}`] : []),
    "---",
    "",
  ].join("\n");
  const full = path.join(MEM, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, front + body.trimStart() + "\n", "utf-8");
}

// ── reset target ─────────────────────────────────────────────
fs.rmSync(MEM, { recursive: true, force: true });
fs.mkdirSync(MEM, { recursive: true });

// ── core memories (authored + cross-linked) ──────────────────

writeMem(
  "user/alex-profile.md",
  {
    name: "Alex Rivera",
    description: "Who Alex is — indie developer, builder of small apps",
    type: "user",
    importance: 9,
    tags: ["identity", "profile"],
    origin: "chat",
    related: ["project/nimbus-notes.md", "feedback/terse-responses.md"],
  },
  `
# Alex Rivera

Indie software developer based in **Lisbon**. Ships small, focused apps solo and
with a rotating cast of contractors. Currently building [[Nimbus Notes]] and the
[[Atlas API]] that powers it.

- **Stack:** TypeScript, React Native, Postgres, a bit of Rust for the hot paths
- **Working hours:** mornings deep work, afternoons meetings/ops
- **Values:** small surface area, fast feedback loops, boring tech that lasts

> "If I can't explain the data model on a napkin, it's too complicated."
`,
);

writeMem(
  "user/preferences.md",
  {
    name: "Preferences",
    description: "Tooling and workflow preferences",
    type: "user",
    importance: 7,
    tags: ["preferences", "tooling"],
    related: ["decisions/postgres-over-mongo.md"],
  },
  `
## Preferences

| Area | Choice | Why |
|------|--------|-----|
| Editor | Neovim + VS Code | muscle memory + extensions |
| Package manager | pnpm | speed, strict deps |
| DB | Postgres | see [[Postgres over Mongo]] |
| Deploys | Cloud Run | scale-to-zero, cheap |
| Notifications | batched, 2×/day | protects focus |
`,
);

writeMem(
  "project/nimbus-notes.md",
  {
    name: "Nimbus Notes",
    description: "Offline-first note-taking app",
    type: "project",
    importance: 8,
    tags: ["app", "react-native", "active"],
    related: ["project/atlas-api.md", "decisions/monorepo.md", "user/alex-profile.md"],
  },
  `
# Nimbus Notes

An **offline-first** note app. Local SQLite, syncs to [[Atlas API]] when online.

### Status — \`beta\`
- [x] Local notes + search
- [x] Sync engine (CRDT-based)
- [ ] Shared notebooks
- [ ] Web client

### Architecture
\`\`\`
RN app ──(local)── SQLite
   │
   └──(sync)── Atlas API ── Postgres
\`\`\`

Biggest risk: conflict resolution at scale. See the [[Monorepo decision]] for how
the client and API share types.
`,
);

writeMem(
  "project/atlas-api.md",
  {
    name: "Atlas API",
    description: "Sync + auth backend for Nimbus Notes",
    type: "project",
    importance: 7,
    tags: ["api", "backend", "active"],
    related: ["project/nimbus-notes.md", "decisions/postgres-over-mongo.md"],
  },
  `
# Atlas API

The backend behind [[Nimbus Notes]]: auth, sync, and sharing.

- **Runtime:** Node + Fastify on Cloud Run
- **Store:** Postgres (\`pg\` + a thin query builder)
- **Auth:** short-lived JWTs + refresh tokens

\`\`\`ts
// sync endpoint shape
type PushRequest = { since: string; ops: Op[] };
type PushResponse = { applied: number; conflicts: Conflict[] };
\`\`\`

Rate limits are per-account. Conflicts bubble back to the client for a
last-writer-wins merge with a user prompt.
`,
);

writeMem(
  "project/wandr-travel.md",
  {
    name: "Wandr (travel)",
    description: "Paused side project — trip planner",
    type: "project",
    importance: 4,
    tags: ["app", "paused"],
  },
  `
# Wandr

A lightweight trip planner. **Paused** to focus on [[Nimbus Notes]].

Lessons before pausing:
1. Maps APIs are expensive — cache aggressively.
2. Nobody wants another login; use device-local first.
`,
);

writeMem(
  "decisions/postgres-over-mongo.md",
  {
    name: "Postgres over Mongo",
    description: "Chose Postgres for Atlas API",
    type: "decision",
    importance: 6,
    tags: ["architecture", "database"],
    related: ["project/atlas-api.md"],
    valid_from: ymd(daysAgo(35)),
  },
  `
## Decision: Postgres over Mongo (for [[Atlas API]])

**Context:** needed relational integrity for shared notebooks + sync cursors.

**Decision:** Postgres. Mongo's flexible schema wasn't worth losing transactions
and joins for the sync model.

**Trade-offs:**
- ✅ Transactions, joins, mature tooling
- ✅ \`jsonb\` covers the flexible bits
- ⚠️ Need migrations discipline

Revisit if write volume 100×'s.
`,
);

writeMem(
  "decisions/monorepo.md",
  {
    name: "Monorepo decision",
    description: "Single repo for app + API + shared types",
    type: "decision",
    importance: 6,
    tags: ["architecture", "tooling"],
    related: ["project/nimbus-notes.md", "project/atlas-api.md"],
  },
  `
## Decision: Monorepo (pnpm workspaces)

Keep [[Nimbus Notes]] and [[Atlas API]] in one repo with a shared \`types\`
package, so sync payload types can't drift.

- \`apps/mobile\`, \`services/atlas\`, \`packages/types\`
- One \`tsc\` to rule the boundary
`,
);

writeMem(
  "feedback/terse-responses.md",
  {
    name: "Prefers terse responses",
    description: "How assistants should communicate with Alex",
    type: "feedback",
    importance: 7,
    tags: ["communication", "style"],
  },
  `
## Communication style

Alex prefers **terse, high-signal** responses.

**Why:** limited focus budget; values skimmable answers.
**How to apply:** lead with the answer, then 1–3 supporting bullets. Skip
preamble. Code over prose when relevant.
`,
);

writeMem(
  "feedback/test-first.md",
  {
    name: "Test-first for risky code",
    description: "Write tests before touching sync/auth",
    type: "feedback",
    importance: 6,
    tags: ["process", "testing"],
  },
  `
## Test-first for risky paths

For anything in **sync** or **auth**, write the failing test first.

**Why:** these are where silent data loss hides.
**How to apply:** a regression test must accompany every sync/auth fix in
[[Atlas API]].
`,
);

writeMem(
  "references/design-tokens.md",
  {
    name: "Design tokens",
    description: "Link to the shared design tokens",
    type: "reference",
    importance: 5,
    tags: ["design", "reference"],
  },
  `
## Design tokens

Shared tokens live in Figma → exported to \`packages/tokens\`.

- Figma: https://figma.com/file/demo-tokens
- Spacing scale: 4 / 8 / 12 / 16 / 24 / 32
`,
);

writeMem(
  "references/oss-licenses.md",
  {
    name: "OSS license cheatsheet",
    description: "Quick license compatibility notes",
    type: "reference",
    importance: 4,
    tags: ["legal", "reference"],
  },
  `
## OSS licenses (cheatsheet)

- **MIT / ISC / Apache-2.0** — safe for shipping
- **GPL/AGPL** — avoid linking into closed-source apps
- Always check transitive deps before a release
`,
);

writeMem(
  "sessions/q2-themes.md",
  {
    name: "Q2 themes",
    description: "Synthesized themes from recent work",
    type: "reflection",
    importance: 8,
    tags: ["reflection", "planning"],
    related: ["project/nimbus-notes.md", "feedback/test-first.md"],
  },
  `
## Q2 themes (synthesized)

Three patterns kept recurring across recent sessions:

1. **Sync is the whole product.** Every [[Nimbus Notes]] support issue traced
   back to sync edge cases → doubling down on [[Test-first for risky code]].
2. **Boring infra wins.** Cloud Run + Postgres removed more problems than it added.
3. **Focus is the bottleneck**, not ideas — hence batched notifications and
   paused [[Wandr (travel)]].
`,
);

writeMem(
  "sessions/2026-05-28-review.md",
  {
    name: "Session review — 2026-05-28",
    description: "5th-session self-assessment",
    type: "session",
    importance: 6,
    tags: ["review", "meta"],
    created: ymd(daysAgo(8)),
  },
  `
## Self-assessment

- **Duplicates:** none significant.
- **Stale:** [[Wandr (travel)]] hasn't been touched in weeks (expected — paused).
- **Gaps:** no memory yet on the shared-notebooks design → TODO.
- **Promote:** sync learnings promoted into [[Q2 themes]].
`,
);

// ── daily logs (collector-style synthetic events) ────────────

const contacts = ["Sam", "Priya", "Diego", "Mara", "the contractor"];
const subjects = [
  "Re: sync conflict on shared notebooks",
  "Invoice #1042 paid",
  "Beta feedback round-up",
  "Cloud Run bill (it's $7 this month)",
  "Intro: designer for Nimbus",
];
const agents = [
  ["research-agent", "Summarized 6 articles on CRDT conflict resolution"],
  ["marketing-agent", "Drafted the Nimbus beta announcement"],
  ["ops-agent", "All health checks green; p95 latency 180ms"],
  ["test-agent", "Ran sync suite: 142 passed, 0 failed"],
];
const meetings = [
  ["Standup with the contractor", "Conf Room / Meet"],
  ["Beta user interview", "Zoom"],
  ["Design review — shared notebooks", "Figma + Meet"],
  ["1:1 with Priya", "Coffee, Praça do Comércio"],
];

function dailyLog(dayOffset) {
  const d = daysAgo(dayOffset);
  const date = ymd(d);
  const lines = [];
  let fileImportance = 5;
  const ev = (h, m, label, body, meta, imp, privacy = "send") => {
    if (imp > fileImportance && imp >= 7) fileImportance = imp;
    lines.push(`## ${ampm(h, m)} — ${label}`, "", body, "");
    if (meta) {
      lines.push(`> ${meta}`, "");
    }
    lines.push(`*importance: ${imp} | privacy: ${privacy}*`, "");
  };

  // morning calendar
  if (chance(0.8)) {
    const [title, loc] = pick(meetings);
    ev(9, 0, "Calendar", `${title}`, `Calendar: Work | Location: ${loc}`, 5);
  }
  // emails
  for (let i = 0; i < 1 + Math.floor(rng() * 2); i++) {
    const subj = pick(subjects);
    ev(
      10 + i,
      15,
      "Email",
      subj,
      `From: ${pick(contacts)}@example.com`,
      subj.includes("Invoice") ? 6 : 4,
    );
  }
  // imessage
  if (chance(0.7)) {
    ev(
      12,
      30,
      "iMessage",
      `${pick(contacts)}: lunch then pair on the merge bug?`,
      "Chat: direct",
      5,
    );
  }
  // a redacted local-only example (shows privacy enforcement)
  if (dayOffset === 3) {
    ev(
      13,
      5,
      "Email",
      "[redacted — local-only: content classified as sensitive and withheld from the synced/embedded store]",
      "From: bank@example.com",
      5,
      "local-only",
    );
  }
  // orchestrator agent results
  for (let i = 0; i < 1 + Math.floor(rng() * 2); i++) {
    const [agent, msg] = pick(agents);
    const failed = chance(0.15);
    ev(
      14 + i,
      40,
      "orchestrator",
      `${agent}: ${failed ? "FAILED — " + msg : msg}`,
      `> meta: agent_id=${agent}`,
      failed ? 8 : 6,
    );
  }
  // fused activity
  if (chance(0.4)) {
    ev(
      15,
      20,
      "Activity (fused)",
      "Cross-source: design review meeting + 3 Figma comments + a follow-up email within 30 min.",
      "sources: calendar, email",
      6,
    );
  }
  // a manual journal entry on some days
  if (chance(0.5)) {
    const mood = pick(["great", "good", "neutral", "tired"]);
    ev(
      18,
      0,
      `Journal *(${mood})*`,
      pick([
        `Shipped the sync retry fix for [[Nimbus Notes]]. Felt good — the test I wrote first caught a real edge case.`,
        `Long day of meetings. Need to protect mornings better. Paused [[Wandr (travel)]] guilt is fading.`,
        `Talked to two beta users. Both want shared notebooks. That's the next bet for [[Atlas API]].`,
      ]),
      "tags: reflection",
      6,
    );
  }

  const header = [
    "---",
    `name: Daily log ${date}`,
    `description: Auto-collected events for ${date}`,
    "type: session",
    `importance: ${fileImportance}`,
    `created: ${date}`,
    `updated: ${date}`,
    `last_accessed: ${date}`,
    "access_count: 0",
    "tags: [daily, auto-collected]",
    "origin: collector",
    "---",
    "",
    `# Daily Log — ${date}`,
    "",
  ].join("\n");

  // one day carries an append-only annotation to showcase "add note"
  if (dayOffset === 1) {
    lines.push(
      `> **Note — ${date} (via dashboard):** Reminder: demo this to the team Friday. Links back to [[Q2 themes]].`,
      "",
    );
  }

  fs.mkdirSync(path.join(MEM, "daily"), { recursive: true });
  fs.writeFileSync(
    path.join(MEM, "daily", `${date}.md`),
    header + lines.join("\n") + "\n",
    "utf-8",
  );
}

for (let i = 0; i < 16; i++) dailyLog(i);

// ── summary ──────────────────────────────────────────────────
const count = (dir) =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith(".md")).length
    : 0;
console.log(`Demo memory store written to: ${MEM}`);
console.log(`  ${count(MEM)} markdown memories (core + 16 daily logs).`);
console.log("");
console.log("Run the dashboard against it:");
console.log(`  node scripts/demo.mjs            # generates + launches`);
console.log(`  # or manually:`);
console.log(
  `  MEMORIA_API_KEY=demo-key-123 MEMORIA_DIR="${OUT}" MEMORIA_EMBEDDINGS=hash PORT=3110 node dist/http.js`,
);
console.log(`  # then open http://127.0.0.1:3110/dashboard  (key: demo-key-123)`);
