# Local native candidate

Native downloads are not published yet. These instructions apply to a reviewed local candidate archive.
The candidate is not proof of a hosted build or approval to publish a release.
Use the existing [release controls](release.md) before any public distribution.

## Supported platforms

| Operating system | Architecture | Archive name |
| --- | --- | --- |
| macOS | arm64 | `fgj-VERSION-macos-arm64.tar.gz` |
| Linux with glibc | arm64 | `fgj-VERSION-linux-arm64.tar.gz` |

No x64, Windows, Alpine or other musl build is supported.
A cross-compiled executable is not target-platform proof.
Bun, Node.js and npm are not required to run the native executable.
Help and version work without Git. Auth and network commands require Git on PATH.
No source checkout is required for user calls.

## Verify and extract

Obtain the reviewed archive and its matching `.sha256` file from the maintainer.
Check the expected version, platform, source commit and archive digest in the candidate record.
Do not use an archive from another source or change the expected digest to make a check pass.
Replace `VERSION` in these examples with the reviewed package version.

On macOS arm64:

```sh
shasum -a 256 -c fgj-VERSION-macos-arm64.tar.gz.sha256
mkdir candidate
tar -xzf fgj-VERSION-macos-arm64.tar.gz -C candidate
./candidate/fgj version
./candidate/fgj help
```

On Linux arm64 with glibc:

```sh
sha256sum -c fgj-VERSION-linux-arm64.tar.gz.sha256
mkdir candidate
tar -xzf fgj-VERSION-linux-arm64.tar.gz -C candidate
./candidate/fgj version
./candidate/fgj help
```

Stop if the checksum, version or platform differs from the reviewed record.
Each archive contains `fgj`, both fgj license texts, this guide and the pinned Bun license reference.
The archive preserves execute permission. Do not extract a different archive over the same candidate directory.

## macOS signatures

The macOS candidate has a local ad-hoc signature over its final executable bytes.
It has no Apple Developer ID signature or Apple notarization.
A browser download can require manual macOS approval.
Do not disable system security to run a candidate.
Use [Apple's documented controls](https://support.apple.com/102445) only after you verify and trust the source.
Ad-hoc signing remains the selected path for the first prerelease. No Apple membership purchase is required by this path.

## Account and first read

Run account and harness setup at a human terminal, not through an agent.
Use one dedicated Forgejo account with separate read and write tokens.
The [main setup guide](../README.md#get-started) lists the required token scopes.
Use the candidate path until the maintainer approves a permanent installation.

```sh
./candidate/fgj auth --profile agent https://your-forgejo.example
./candidate/fgj auth status
./candidate/fgj read issue get https://your-forgejo.example/owner/repository/issues/1
```

Check the account, repository and returned `as` value before any write.
The setup test supports reviewed native archives, isolated replacement and all three harness installations.
Hosted download proof and a human acceptance run remain separate requirements.
The [additional setup guide](setup.md) covers account bindings and other harnesses.

## Isolated installation and harness setup

After archive verification, install into a directory that you own.
These commands replace an earlier installation at that path. They do not select a system-wide installation.

```sh
mkdir -p "$HOME/.local/bin"
install -m 755 ./candidate/fgj "$HOME/.local/bin/fgj.next"
mv "$HOME/.local/bin/fgj.next" "$HOME/.local/bin/fgj"
export PATH="$HOME/.local/bin:$PATH"
fgj version
```

Run the account commands above with the installed executable.
Then install the rules and skill for your harness at a human terminal:

```sh
fgj rules install claude
fgj skill install claude
fgj rules status
fgj skill status
```

Replace `claude` with `codex` or `pi` for those harnesses. Review each proposed change before you confirm it.
For pi, keep the installation path fixed. Its generated callback names the installed executable.
Do not move that executable after setup without reinstalling the pi rules.

## Maintainer preparation

In a clean source checkout, run:

```sh
bun run package:native
```

The command supports only its current host platform. It uses Bun 1.3.14 and the system tar tool.
It checks the extracted executable with no Bun, Node.js or npm on PATH.
It checks the final macOS signature again after extraction.
It prints the source commit, executable version, runtime revision, inventory and both SHA-256 digests.
It refuses existing output files and removes its temporary files on failure.
It does not replace a shared installation, accept release flags, upload files or publish anything.
The archive is a local candidate, not a release artifact approved for distribution.

Before public distribution, verify the pinned [Bun runtime license reference](bun-license.md), linked-library notices and relinking requirements.
That review must cover the actual compiled runtime. The reference alone does not establish license compliance.
Keep this review separate from fgj's MIT OR Apache-2.0 license choice.


## Private hosted rehearsal

Keep the repository private. Obtain owner approval before enabling Actions or starting a run.
Disable the contributor and npm release workflows before enabling the reviewed native rehearsal.
Use the existing full-SHA action allowlist and read-only workflow token settings.

The manual `native-rehearsal` workflow accepts one approved full commit from `main`.
Both jobs build once, retain private artifacts for seven days and download their artifact by immutable ID.
Each job has a 20-minute limit. Neither job creates a tag, publishes a release or requests OIDC.
The Linux job tests the downloaded archive against the disposable Forgejo.
The Mac job checks startup and signatures. Run its downloaded archive against the local disposable Mac fixture without rebuilding.

Reuse the existing setup test with `FGJ_NATIVE_TARBALL` set to the absolute downloaded archive path.
Set `FGJ_NATIVE_PREVIOUS_TARBALL` to an earlier reviewed archive for replacement proof.
Keep the matching `.sha256` file beside the candidate archive.
These tests use private homes and system tools only on fgj's PATH.
They automate terminal answers, verify the selected profile and repository, and replay the installed pi callback.
They do not launch authenticated model sessions or replace human acceptance.

A rehearsal has no version tag and does not approve distribution.
Before release, resolve runtime license materials, select an approved version tag and bind final artifacts to that tag.
Retain the run identifier, attempt, source commit, workflow commit and both platform digests in the release record.
Do not repeat passed checks for unchanged candidates. Test changed behavior and keep the repository-required checks.
