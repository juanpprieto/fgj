# scripts

Developer and CI tooling. Build and package commands create distribution artifacts;
these scripts do not ship to consumers.

- [`forgejo-test-server.ts`](forgejo-test-server.ts) starts and stops the disposable Forgejo 16.0.5 that the
  real-server tests use. On macOS it runs the pinned rootless image through Podman. On
  Linux it runs the pinned release binary after a sha256 check. `start` writes the URL,
  the admin login, a read-scoped token, and a write-scoped token to
  `.forgejo-test/server.json` (mode 0600, ignored by git) and prints no secret. The
  server needs sign-in for every API call (`REQUIRE_SIGNIN_VIEW`), as private hosts
  often do, so a call without a token gets 403.
- [`forgejo-logs.ts`](forgejo-logs.ts) shows the test Forgejo log as JSON lines: problems only by
  default, or every request with `--all`.
- [`build.ts`](build.ts) builds `dist/fgj` with the version stamped in: the package version, the
  git sha, and `-dirty` for a changed tree. `--bundle` builds `dist/cli.js` for Bun
  instead. Both forms keep the same version stamp.
- [`package.ts`](package.ts) (`bun run package`) builds a Bun bundle before packing
  `dist/fgj-<version>.tgz`. A temporary staging directory allows only the bundle,
  a script-free manifest, an installation guide and both licenses. The command
  removes staging files and prints the SHA-256 and inventory. It never publishes
  or changes the shared installation.
  Archive names and bundle checks use the package version, including prereleases.
  If source metadata names a public GitHub repository, the packed manifest retains it.
  Packing a local candidate without that metadata does not qualify it for release.
  See [release constraints](../docs/release.md) for approval boundaries and proof limits.
- [`release-artifact.ts`](release-artifact.ts) retains and verifies one release archive with its source, workflow, run and attempt evidence.
  It checks the supplied build digest through the release guard and exports the path for the existing tests.
  It transfers no artifact and sends no registry request. The workflow owns transport and staging.
- [`release-check.ts`](release-check.ts) checks an owner-dispatched, version-tagged release against package repository metadata.
  Staging requests require the public repository in the GitHub event. Dry-run can use the private target.
  It checks event, workflow, tag and checkout commits, main ancestry, metadata and archive digests.
  Dry-run refuses publishing credentials and OIDC. Stage checks require OIDC and refuse ambient npm tokens.
  The command reads inputs only. It never stages, publishes or proves repository protections.
  Build and package commands call it with `--release` before any build.
  Release packaging checks the archive again before it writes the final file.
- [`install-local.ts`](install-local.ts) builds fgj and copies it to `~/.local/bin/fgj`. It refuses a dirty
  build unless you pass `--dirty`, and it refuses to replace a file that is not fgj.
- [`install-uat.ts`](install-uat.ts) (`bun run install:uat`) prepares a UAT of the current commit: it runs
  `install-local.ts`, checks the version, then runs `fgj rules install` and `fgj skill
  install` only for the harnesses that are not current. Each install asks `[y/N]` at the
  terminal, so a human runs it.
- [`uat-shell.ts`](uat-shell.ts)
  (`bun run uat:shell --cwd DIR [--profile NAME] -- <command...>`) runs one command,
  such as a harness, against the fgj build of the current commit. It refuses a
  changed work tree, builds `dist/fgj`, and puts `dist` first on the child's PATH.
  It removes the PATH entries and `npm_*` variables that `bun run` adds. It checks
  that the fgj the child resolves names HEAD, then runs the command in `DIR` and
  returns its exit code. `DIR` must be absolute, outside the checkout, and not in
  another clone of this repository, because a call there without `--repo` acts on
  this repository. `bun run` starts in the checkout, so `DIR` is required. `--profile` sets `FGJ_PROFILE` in the child only. Its own failures
  exit 125. It replaces no shared fgj and changes no rules, skill, or token.
- [`check.ts`](check.ts) runs the server start, lint, typecheck, the docs check, and
  tests (several test files at a time), and prints one JSON line per step. It stops
  before the first step with a `bun` line when the Bun that runs it is not the pinned
  Bun, the `@types/bun` version in `package.json`; `mise.toml` pins it for mise. The tests
  get an empty `TMPDIR`, and any file left there fails the check with a `leak` line.
  In CI, a failed step first prints its failure lines (failed test names, errors, and
  timeout notes) as plain lines, so `fgj read run log` shows them whole.
  `bun run check:local` checks contributor prerequisites, refuses an existing fixture,
  selects an unused port, builds one archive and stops its own fixture after the checks.
  It requires real Codex and pi tools. The default CI path keeps fixture reuse unchanged.
- [`docs-check.ts`](docs-check.ts) (`bun run docs:check`) checks the documentation
  rules in `AGENTS.md`: a README in every directory that links each direct child, local
  README links that work, and TSDoc on each exported function and callable type. The
  pre-commit hook and `check.ts` run it. It prints one line per issue, with the fix.
  The `.github` directory uses `overview.md` instead of `README.md` because GitHub
  displays a `.github/README.md` before the root README. The same checks apply to that guide.
  It finds links with Bun's Markdown parser and checks them against the files that git
  lists. It does not find a raw HTML link written as `href = "x"` with spaces, or with
  no quotes, and a quoted `href=` inside another attribute can hide the real one. The
  TSDoc rule does not check getters, setters, namespaces, union function types, or a
  class property that has a function type but no function value.
- [`readme-verbs.ts`](readme-verbs.ts) (`bun run docs:verbs`) writes the verb table in
  the root README from the manifest, between the `verbs:start` and `verbs:end` markers.
  A unit test fails when the table and the manifest differ.
- [`docs-check.json`](docs-check.json) lists the paths that the README rules skip, each
  with its reason.

This directory does not own CLI behavior, tests, fixtures or registry publication.
