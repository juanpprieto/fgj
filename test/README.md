# test

Tests for `fgj`, run with `bun test`.

- [`server/`](server) holds real-server tests. They run `fgj` against the disposable Forgejo that
  `bun run forgejo:start` starts, and they fail if no server runs. Most run the source;
  `binary.test.ts` builds and runs the compiled binary.
- [`unit/`](unit) holds tests that need no server: parsing, output, identity, rules, and help.
- [`harness/`](harness) holds real harness runs. `pi-adapter.test.ts` runs pi with the generated
  fgj adapter and a scripted model from `support/pi-harness.ts`, in a temporary pi home.
  It skips when `pi` is not on PATH. Its parallel-lane test runs only when
  `FGJ_PI_SUBAGENTS` names the `index.js` of an installed
  [pi-subagents](https://github.com/nicobailon/pi-subagents) package.
- `fixtures/actions/` holds synthetic TypeScript failure, Vitest timeout and passing
  logs. They keep timestamp, color, error, result and post-step cases without private
  run recordings. The test Forgejo has no runner; unit tests read these fixtures.
- [`support/`](support) holds test helpers. The helpers create fixtures through the admin's basic
  auth, so the fgj tokens keep their narrow scopes. Make temporary directories with
  `tempDir`: `bunfig.toml` preloads it, and it removes them after the whole run.
  Give a spawned `fgj` or shell `cleanEnv(home)` as its base env. It carries `TMPDIR`,
  so the leak check in `bun run check` also sees the child's temp files.

## Package validation

[`unit/package.test.ts`](unit/package.test.ts) tests one reviewed tarball through
npm, npx and Bun, with lifecycle scripts enabled and disabled. Each route uses a
private home, prefix, cache and non-Git working directory. The suite checks hostile
startup files, callback replay, paths with spaces, absent Bun, a renamed runtime,
invalid package metadata and absent or corrupt bundles. It prints the platform,
runtime versions, full commit, inventory and archive SHA-256. A final digest check
makes sure that no suite member changes the reviewed archive. Packaging failure
tests use separate fixture roots, so they cannot replace that archive.
[`unit/native-package.test.ts`](unit/native-package.test.ts) checks host-only native candidates in synthetic clean Git checkouts.
It verifies both license texts, the runtime reference, version and source identity, archive digests and execution without other runtimes on PATH.
These local candidate checks do not establish hosted builds, release approval or runtime license compliance.
[`unit/public.test.ts`](unit/public.test.ts) scans the archive and generated help,
rules and skill. It checks synthetic scan markers, retained licenses, complete review
rows, exact tree exports, poisoned local-file exclusion and one fresh root without remotes.
[`unit/check-local.test.ts`](unit/check-local.test.ts) checks contributor prerequisites,
fixture ownership, occupied ports and cleanup after success, test failure and provisioning failure.
Synthetic markers do not replace a per-path disclosure review.


[`server/getting-started.test.ts`](server/getting-started.test.ts) executes the documented Bun installation,
human-terminal authentication, Claude Code and Codex setup, and a first read in private homes.
It uses the disposable Forgejo, not a production account or a source checkout for user calls.
Set `FGJ_NATIVE_TARBALL` to a reviewed native archive to reuse that setup test without Bun, Node.js or npm on the child PATH.
This route verifies the archive checksum, isolated installation, two-token authentication and all three harness installations.
It replays the installed pi callback and reads the intended repository with the selected profile under hostile startup files.
Set `FGJ_NATIVE_PREVIOUS_TARBALL` to an earlier reviewed archive to test replacement at the same installation path.
The test automates terminal answers in disposable homes. It does not claim a human performed acceptance or that real harness sessions ran.
Set `FGJ_PACKAGE_TARBALL` to an absolute archive path to reuse exact reviewed bytes.
Without it, the tests build an archive. Compare the printed hashes across macOS
arm64 and Linux arm64 before acceptance. Use Bun 1.3.14 in both environments.
Run `bun test test/unit/package.test.ts test/unit/public.test.ts` for the focused
matrix. For full source validation, use the guarded fixture setup in
[CONTRIBUTING.md](../CONTRIBUTING.md#run-the-complete-check).
Never provision on a shared or default port, or stop another person's service.

CI runs `bun run check`, the focused installation and privacy matrix, and then
`bun test ./test/server/package.test.ts` with the same archive. The direct matrix
step keeps passing runtime and digest records visible in the CI log. The server test
installs through npm with scripts disabled. The installed CLI reads a synthetic
issue through the disposable Forgejo API, with no checkout or write token.

[`unit/release.test.ts`](unit/release.test.ts) checks release refusals with synthetic local Git repositories and archives.
It tests source, tag, event, workflow and checkout matching, dirty trees, metadata and credential guards.
It also checks private staging refusal and exact archive binding to the source, workflow, run and attempt.
It executes the literal staging step with a fake npm binary, then checks configuration isolation and cleanup.
The fake binary sends no registry request. These probes do not prove GitHub protections, npm permissions or registry provenance.

[`unit/release-workflow.test.ts`](unit/release-workflow.test.ts) checks the manual release workflow structure.
It tests default dry-run, protected stage-only OIDC, successful job dependencies and same-run artifact IDs.
Mutation cases reject unsafe triggers, disabled checks, inherited npm configuration, ignored failures and direct publication.
They check explicit provenance requests, not real attestations. Hosted execution and registry proof remain separate.

[`unit/contributor-workflow.test.ts`](unit/contributor-workflow.test.ts) checks the public contributor workflow structure.
It tests triggers, hosted runner labels, read-only permissions, pinned actions and runtimes, candidate reuse and fixture cleanup.
Changed fixtures show that the assertions reject privileged triggers and unsafe job settings.
They also reject explicit Node setup caching, disabled checks, ignored failures and checks before candidate creation.
These tests do not prove GitHub's saved approval settings or hosted execution.

The test server serves API pages of 5 items (`apiPage` in the server state), so a
paging test crosses a page with 6 items, not 51. Build such a fixture from
`server.apiPage`, never from Forgejo's default of 50. `bun run check` runs several test
files at a time: two fewer than the CPUs, at most 4, or `FGJ_TEST_WORKERS`. The test
Forgejo stores data in SQLite, which takes one write at a time, so more files make
write-heavy tests slower, not the run faster. Each test file uses its own repositories
and owner projects, and deletes an owner project when it ends. CI sets 1: its runner is
slower, and with 4 files there a test ran past the 5 s limit.

A test has a 5 s limit. Build a fixture that needs many writes, such as a pull request
or a pushed branch, in `beforeAll`, and give every `beforeAll` that writes to the server
a 60 s limit (`}, 60_000);`). A slow runner then delays the setup, not the test. A test
that must build its own fixture with several writes or a wait for an Actions run, such
as a fresh branch to open a pull request from, gets an explicit limit of at least 20 s
(`}, 20_000);`).

Tests never touch the user's token file or harness config. Each `fgj` run gets a
temporary `HOME`, so it has no token file, and the test tokens come through `FGJ_URL`,
`FGJ_READ_TOKEN`, and `FGJ_WRITE_TOKEN`.

The wait verbs (`status wait`, `run wait`) wait up to 90 s per call. Their tests set
`FGJ_WAIT_TIMES=cap,poll,grace` in milliseconds (for example `2000,250,1000`), so a
call ends in seconds. fgj reads it for tests only; help does not name it. A test that
the grace must end uses a cap of 3 times the grace (`3000,250,1000`): with a smaller
cap, slow reads under load let the cap end the wait first.

This directory does not own the test server itself; `scripts/` owns it.
