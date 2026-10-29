# Contributing to Memoria

Thanks for your interest. Memoria is maintained by one person in spare time, so
this file is mostly about setting expectations honestly and making it easy for a
PR to be merged without a long back-and-forth.

## Expectations

- **Review is asynchronous.** Issues and PRs get a response, but it may take a
  week. A PR that sits is not being ignored.
- **Open an issue before a large change.** Anything that adds a dependency,
  changes the memory file format, alters the search scoring, or touches the auth
  surface should start as an issue so we can agree on direction before you spend
  an evening on it. Small fixes can go straight to a PR.
- **Questions belong in [Discussions](https://github.com/Agripp87/memoria_mcp/discussions)**,
  not issues. Issues are for bugs and concrete proposals.
- **Security issues never go in a public issue.** See [SECURITY.md](SECURITY.md).

## Never include personal data

This is the one hard rule. Memoria's whole subject matter is somebody's private
memory, which makes it unusually easy to paste something you did not mean to
share.

- No real memory files, daily logs, `MEMORY_INDEX.md` contents, API keys,
  bearer tokens, refresh tokens, or personal identifiers in issues, PRs, test
  fixtures, screenshots or commit messages.
- Redact hostnames and URLs of your own deployment.
- Need realistic data for a repro or a fixture? Generate it:
  ```bash
  cd mcp-server && npm run demo:gen -- --out /tmp/store
  ```
  This writes ~29 cross-linked fake memories (an "Alex Rivera" persona) with no
  connection to anyone real.
- CI runs [gitleaks](https://github.com/gitleaks/gitleaks) over the full history
  on every push and PR, and GitHub push protection is on. If a scan blocks you,
  do not work around it — rotate whatever leaked first.

## Development setup

```bash
git clone https://github.com/Agripp87/memoria_mcp.git
cd memoria_mcp/mcp-server
npm install
npm run build
npm test
```

Node 20+ is required (`better-sqlite3` supports nothing older); CI builds on
Node 22 on both Ubuntu and Windows, and the Docker image runs Node 26. `better-sqlite3` is a native module, so a first install
needs a working toolchain (build-essential / Xcode CLT / MSVC Build Tools).

Useful commands, all from `mcp-server/`:

| Command | What it does |
|---------|--------------|
| `npm test` | Full Vitest suite (no network or API keys needed) |
| `npm run test:watch` | Watch mode |
| `npm run test:coverage` | Suite + the coverage floors CI enforces |
| `npm run lint` | ESLint |
| `npm run format` | Prettier, write mode |
| `npm run format:check` | Prettier, check mode (what CI runs) |
| `npm run demo` | Build, generate a throwaway store, serve the dashboard on `:3110` |
| `npm run build` | `tsc` |

Point `MEMORIA_DIR` at a scratch directory while developing so you never touch a
real store:

```bash
MEMORIA_DIR=/tmp/memoria-dev node dist/http.js
```

## Before you open a PR

1. **`npm test` is green** and you added tests for behavior you changed. The
   coverage floors in `vitest.config.ts` are per-file and CI fails on a
   regression — raise them if your change lifts coverage, never lower them.
2. **`npm run lint` and `npm run format:check` are clean.**
3. **`npm run build` succeeds** (TypeScript is `strict`; no `any` smuggling and
   no `@ts-ignore` without a comment explaining why).
4. **Shell scripts pass `shellcheck --severity=warning`.**
5. **Commits are signed off** — see below.
6. Docs updated if you changed behavior: the env-var table, the tool table and
   `SECURITY.md` are the three that go stale fastest. User-visible changes get
   a line under `[Unreleased]` in [CHANGELOG.md](CHANGELOG.md).

## Sign-off (DCO)

Contributions are accepted under the
[Developer Certificate of Origin](https://developercertificate.org/). It is a
short statement that you wrote the patch or otherwise have the right to submit
it under the project's licence. Certify it by signing off each commit:

```bash
git commit -s -m "Your message"
```

which appends `Signed-off-by: Your Name <your@email>`. Forgot on the last
commit? `git commit --amend -s`. On a branch? `git rebase --signoff main`.

There is no separate CLA. The project is Apache-2.0 and contributions are
licensed the same way.

## Code conventions

- **TypeScript, ESM, Node 20+ APIs.** `type: "module"`, `Node16` resolution —
  relative imports need the `.js` extension.
- **Comments explain *why*.** The codebase's convention is a short paragraph
  above non-obvious code describing the failure it prevents (often with the date
  and the incident). Keep that up — it is the most useful documentation here.
- **Markdown files are the source of truth.** The SQLite index is derived and
  must stay fully rebuildable from the files. Any change that makes the DB
  authoritative for something will be rejected.
- **Fail soft on the sync/collector path, fail loud on the auth path.** A
  collector adapter that throws must not take down ingestion; an auth check that
  cannot be evaluated must deny.
- **No silent data loss.** Events are only marked synced once durably handled;
  daily logs are append-only. If your change can drop a user's entry, it needs a
  test proving it does not.

## Security-sensitive areas

Changes here get a slower, closer review — that is not distrust, it is the blast
radius:

`src/http.ts` (auth, OAuth, rate limits) · `src/collector/crypto.ts` ·
`src/collector/registry.ts` (consent, shell sources) ·
`src/collector/ingestion.ts` (privacy tiers, redaction) · path resolution in
`src/tools.ts` · `src/wiki.ts` (HTML escaping).

## Releasing (maintainer)

Releases are **staged** on npm by
[`.github/workflows/release.yml`](.github/workflows/release.yml) using npm
trusted publishing — no npm token exists anywhere, and every release carries a
provenance attestation linking it to its commit — and go public only when the
maintainer approves them with 2FA. The workflow can stage but never publish on
its own: nothing that can push a tag to this repository can release to npm
without the maintainer's second factor as well.

1. On a branch: bump `version` in `mcp-server/package.json` (and the `version`
   strings in `src/index.ts`, `src/http.ts`, `.claude-plugin/plugin.json`,
   `.claude-plugin/marketplace.json` and `server.json`), and move the
   `[Unreleased]` section of
   [CHANGELOG.md](CHANGELOG.md) under a dated version heading.
2. Merge it to `main` once CI is green.
3. Tag the merge commit and push the tag:

   ```bash
   git tag -a vX.Y.Z -m "Memoria X.Y.Z"
   git push origin vX.Y.Z
   ```

4. Approve the staged release. The workflow's run summary prints the exact
   commands with the staging id filled in; `npx -y npm@11 stage list
   @agrippa87/memoria-mcp` lists it too:

   ```bash
   npx -y npm@11 stage view     <stage-id>   # optional: what is staged
   npx -y npm@11 stage download <stage-id>   # optional: the tarball itself
   npx -y npm@11 stage approve  <stage-id>   # prompts for 2FA
   ```

   These take the staging id, not the package name. Given
   `@agrippa87/memoria-mcp@X.Y.Z` they fail with "stage-id must be a valid
   UUID".

   `npx -y npm@11` runs an npm that has the `stage` command without changing
   your global npm; npm before 11.15 does not have it. `npm stage reject`
   discards a staged release instead.

The tag push runs the release workflow, which refuses to stage if the tag is
not on `main` or does not match `package.json`, and re-runs the full check suite
plus the embedding vector-space guard before staging.

To rehearse without writing anything to the registry, run the **Release**
workflow by hand from the Actions tab: it performs every step, then stages a
throwaway pre-release version with `--dry-run`.

A local `npm publish` still works for the account owner with 2FA, but should be
the exception — a release through the workflow is the one that carries
provenance.

### Publishing to the MCP registry (maintainer)

[`server.json`](server.json) at the repository root is the entry for the
[official MCP registry](https://registry.modelcontextprotocol.io). It is not
part of the npm release, so its `version` is bumped by hand alongside
`mcp-server/package.json` (step 1 above) and must match it exactly.

The registry verifies that the npm package really belongs to the server name
before accepting a publish: it fetches
`https://registry.npmjs.org/@agrippa87/memoria-mcp/<server.json version>` and
compares that version's `mcpName` field with the `name` in `server.json`.
`mcpName` is set in `mcp-server/package.json`, so **publish to the registry only
after the npm release carrying it is live** — the version in `server.json` must
name an already-published npm version.

Validate before publishing; neither command needs credentials:

```bash
mcp-publisher validate                                               # reads ./server.json

curl -s -X POST https://registry.modelcontextprotocol.io/v0/validate \
  -H 'Content-Type: application/json' --data-binary @server.json     # {"valid":true,"issues":[]}
```

Then authenticate and publish (the name is under the `io.github.Agripp87/`
namespace, so GitHub auth is the one that works):

```bash
mcp-publisher login github
mcp-publisher publish
```
