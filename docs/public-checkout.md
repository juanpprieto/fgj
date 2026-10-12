# Reviewed public source checkout

This guide prepares a source candidate internally. It does not authorize public
repository creation, transfer, tags, package publication or deletion of internal history.
The maintainer must confirm public repository URLs and a private security contact
before transfer. [Contributing](../CONTRIBUTING.md) and [security reporting](../SECURITY.md)
are the contributor entry points.

## Review and export

Use a clean, committed checkout. Review every tracked path, including comments,
tests, fixtures, examples, old research, artwork, generated content and metadata.
Record each path, SHA-256, disposition and review reason in a separate inventory.
Keep the inventory and validation logs outside the candidate.
Remove private hosts, project and tool names, personal workflows and unapproved
contact metadata. Keep generic Forgejo capabilities and synthetic examples.
Keep both license files byte for byte, including required author attribution.
Automated scans catch markers and credential forms; they do not replace this review.
An inventory gap, changed digest, unexpected path or file type blocks transfer.

Do not copy the working directory or use a commit archive. Git commit archives
carry the original commit ID. A tree archive has no commit-ID metadata:

```sh
# Run from the reviewed checkout. Use a new scratch directory.
set -eu
SOURCE="$PWD"
CANDIDATE=$(mktemp -d)
SNAPSHOT="$CANDIDATE/source.tar"
git diff --exit-code
git diff --cached --exit-code
git archive --format=tar --output="$SNAPSHOT" 'HEAD^{tree}'
# Expect exit 1 and no output: there is no commit ID in a tree archive.
if git get-tar-commit-id < "$SNAPSHOT"; then exit 1; else
  code=$?; test "$code" = 1
fi
mkdir "$CANDIDATE/checkout"
tar -xf "$SNAPSHOT" -C "$CANDIDATE/checkout"
```

Only tracked tree files enter this export. `.git`, local harness settings,
credentials, dependency folders, build output and fixture state must stay excluded.
Review the archive listing and compare its file digests with the inventory.
Reject symlinks, submodules and other unexpected types. Compare the license bytes
with the source. Record the archive SHA-256 with `shasum -a 256 "$SNAPSHOT"`.
Do not export issues, delivery records, CI logs, remotes, author history or local config.

Create fresh history with an explicitly approved public identity. The example below
is synthetic and is only for local validation. Do not push this example identity.

```sh
cd "$CANDIDATE/checkout"
git init -b main
git add .
git -c user.name='Example Contributor' -c user.email=contributor@example.invalid \
  commit -m 'Reviewed source snapshot'
git rev-list --count HEAD  # Expect 1.
git remote -v             # Expect no output.
git log --format='%an <%ae>'  # Expect only the selected identity.
```

## Validate the fresh root

Install the versions in [CONTRIBUTING](../CONTRIBUTING.md#run-the-complete-check).
Keep Git metadata local: docs checks and build versions need the fresh root commit.
Tests use private homes, caches and config, not existing account settings.
Linux uses a local Forgejo process and needs no container runtime.
On macOS, Podman uses the host's configured machine. No private Forgejo login is needed.
Inventory existing services and the shared fgj digest before the run.
On macOS, include Docker and Podman containers. Compare inventories after cleanup.
Never install over the shared binary.

Choose an unused port and make sure its container does not exist. This example
uses port 49378; change it if busy. Use the same shell and port for every step.
On Linux, check the port and absent state file; the fixture uses a local process.
On macOS, also run the Podman guard below. Stop if any guard fails. The shell stops on a failed check and cleans up its fixture.

```sh
set -eu
export FGJ_FORGEJO_PORT=49378
bun -e 'const s=Bun.listen({hostname:"127.0.0.1",port:Number(process.env.FGJ_FORGEJO_PORT),socket:{data(){}}});s.stop();'
if [ "$(uname -s)" = Darwin ]; then
  # Expect exit 1 (absent), not a service or a Podman error.
  if podman container exists "fgj-forgejo-test-$FGJ_FORGEJO_PORT"; then exit 1; else
    code=$?; test "$code" = 1
  fi
fi
test ! -e .forgejo-test/server.json
bun install --frozen-lockfile
bun run package
export FGJ_PACKAGE_TARBALL="$PWD/dist/fgj-0.1.0.tgz"
export CI=1 FGJ_TEST_WORKERS=1
bun run forgejo:start
trap 'bun run forgejo:stop' EXIT
bun run check
bun run build
bun run docs:check
bun test test/unit/public.test.ts test/unit/run.test.ts --only-failures
bun run forgejo:stop
trap - EXIT
```

Keep one absolute, unchanged npm archive for the candidate. Record its digest and
inventory separately from the source archive. The npm inventory is only `cli.js`,
`package.json`, `README.md`, `LICENSE-MIT` and `LICENSE-APACHE`.
Review generated help, rules and skill from that archive as well.
A fresh root changes the build SHA; it does not change CLI capabilities.
Checks need no private forge account. Harness tests use scripted fixtures, not a
paid model login. The full check requires Codex and pi; optional extension tests
can skip when that extension is absent. Record skips rather than claiming proof.

Walk through the README and both contributor guides without internal links or
accounts. Make sure setup, supported versions, contribution, reporting checkpoints
and licensing are discoverable. Public URLs and the security contact remain
maintainer checkpoints, not inferred values.

## Practices adopted from primary sources

Checked on **2026-10-05**. This comparison covers only practices used in these guides;
it does not compare command coverage or claim support for another CLI.

| Source | Practice adopted | fgj application |
| --- | --- | --- |
| [gh security policy](https://github.com/cli/cli/blob/6fc1c29d5477bfe71da7af290eb481c0df7811f1/.github/SECURITY.md) | Keep vulnerability reports out of public issues and use private disclosure. | SECURITY explains private reporting and blocks guessed contact details. |
| [tea contributor guide](https://gitea.com/gitea/tea/raw/commit/bcd62a1fb2ce6fdd51ebea91cc33ddbcae000b68/CONTRIBUTING.md) | Give reproducible defect reports and keep changes focused. | CONTRIBUTING asks for versions, reproduction, tests and one scope. |
| [fj README](https://codeberg.org/forgejo-contrib/forgejo-cli/raw/commit/3cbff95f9a14df353905198fb7c7ed4947f89eaf/README.md) | Make capabilities and licensing easy to find. | README links the tested contract and both retained license texts. |
| [Git archive documentation](https://git-scm.com/docs/git-archive) | A commit archive stores its commit ID; a tree archive does not. | Export `HEAD^{tree}`, then make and verify one new root. |

Do not copy another project's security address, license, governance or release policy.
