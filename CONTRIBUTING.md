# Contributing to fgj

fgj provides generic Forgejo operations for coding agents.
Use the repository that supplied this checkout for contributions.
Read the [design](docs/design.md) before a change.

## Start a change

Use a dedicated checkout with Bun **1.3.14** and Git on PATH.
`mise.toml` pins Bun if you use mise. No private Forgejo account is required.

Install the locked development dependencies:

```sh
bun install --frozen-lockfile
```

Run fgj directly from source:

```sh
bun --no-env-file --config=/dev/null src/cli.ts help
```

Run a focused test while you work:

```sh
bun test test/unit/target.test.ts
```

These steps do not build or replace a global fgj installation.
A focused test is not the complete validation required before review.

## Run the complete check

The complete check also needs Node.js, npm, Codex and pi on PATH.
Complete checks currently cover macOS arm64 and Linux arm64.
On macOS, install and start Podman first. Linux uses the pinned Forgejo release binary.
The [contributor CI](.github/workflows/README.md) records the tested tool versions:
Bun 1.3.14, Node 24.19.0, npm 11.17.0, Codex 0.155.1 and pi 0.87.1.
Checks need network access for dependencies, runtime probes and fixture provisioning.
No harness login or installation into your harness configuration is required by the automated checks.

```sh
bun run check:local
```

This command checks prerequisites, chooses a free fixture port and builds one npm candidate.
It runs lint, typecheck, documentation checks, real-server tests and harness tests.
It stops its test server after success or failure and reports one JSON line per step.
It refuses existing fixture state, a conflicting container or another local check in the same checkout.
It never replaces your fgj installation or changes your harness configuration.

Use a separate checkout if another check owns the fixture.
An explicit `FGJ_FORGEJO_PORT` must be free and cannot be the legacy port 3917.
The lower-level `bun run check` keeps its existing fixture-reuse behavior for CI and maintainer work.
A success without the real Codex and pi tests is not complete harness proof.

## Report a defect or propose a change

First check existing reports. Include the expected behavior, actual behavior, fgj version and a small reproduction.
Include the operating system, architecture and Bun version.
Remove tokens, cookies, private hosts and personal paths from logs.
Use [SECURITY.md](SECURITY.md) instead of a public issue for a vulnerability.

Agree on scope before a large change. Start a focused branch from current `main`.
Add a failing regression test before a defect fix. Keep dependencies pinned.
A verb change needs its manifest, generated harness rules, match tests, real-server tests, help and skill guidance.
Keep the risk word first. Keep commit hooks enabled.
Record no-prompt proof for changed verbs with the [harness check guide](docs/uat.md).
Include test commands, results and remaining risks in the pull request.

## Maintainer work

The [release guide](docs/release.md) owns candidate inspection, platform proof, release approval and provenance checks.
Do not run `install:local` or `install:uat` during contribution checks.
These commands replace the shared fgj installation.
Use [additional setup](docs/setup.md) for user account and harness configuration.

## License

Contributions use **MIT OR Apache-2.0**, as the project does.
Keep both [MIT](LICENSE-MIT) and [Apache-2.0](LICENSE-APACHE) texts and required attribution.
This guide does not add a contributor agreement or change license terms.
