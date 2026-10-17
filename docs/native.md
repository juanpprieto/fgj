# Native installation

Install a native executable from the [v0.1.0 prerelease](https://github.com/juanpprieto/fgj/releases/tag/v0.1.0).
You do not need Bun, Node.js, npm or a source checkout to run it.
Auth and network commands require Git on PATH. Help and version do not require Git.

## Choose a download

Run `uname -sm` at your terminal to check your operating system and architecture.
On Linux, run `getconf GNU_LIBC_VERSION` to check for glibc.

| System | Download |
| --- | --- |
| macOS, Apple Silicon (`Darwin arm64`) | [`fgj-0.1.0-macos-arm64.tar.gz`](https://github.com/juanpprieto/fgj/releases/download/v0.1.0/fgj-0.1.0-macos-arm64.tar.gz) |
| Linux, arm64 (`Linux aarch64`), glibc | [`fgj-0.1.0-linux-arm64.tar.gz`](https://github.com/juanpprieto/fgj/releases/download/v0.1.0/fgj-0.1.0-linux-arm64.tar.gz) |
| Linux, x64 (`Linux x86_64`), glibc | [`fgj-0.1.0-linux-x64.tar.gz`](https://github.com/juanpprieto/fgj/releases/download/v0.1.0/fgj-0.1.0-linux-x64.tar.gz) |

Download the matching `.sha256` file from the same release page.
Do not select GitHub's automatic **Source code** archive for installation.
Intel Macs, Windows, Alpine and other musl systems have no supported native download.

These are early prerelease builds, not a compatibility promise for every OS version.
Linux x64 terminal acceptance passed with glibc 2.39, including authentication, a repository read and a comment.
Manual agent approval behavior on Linux x64 remains unverified.
The release notes distinguish automated checks from human acceptance.

## Verify the download

Open a terminal in the directory that contains both downloaded files.
Run only the checksum command for your archive.

macOS arm64:

```sh
shasum -a 256 -c fgj-0.1.0-macos-arm64.tar.gz.sha256
```

Linux arm64:

```sh
sha256sum -c fgj-0.1.0-linux-arm64.tar.gz.sha256
```

Linux x64:

```sh
sha256sum -c fgj-0.1.0-linux-x64.tar.gz.sha256
```

The result must say `OK`. Stop if it fails.
A checksum detects changed download bytes. It is not an independent signature from the publisher.

## Extract and install

Set `archive` to the exact filename you downloaded. This example uses Linux x64.
Use a new extraction directory. Do not extract over an earlier candidate.

```sh
archive=fgj-0.1.0-linux-x64.tar.gz
mkdir fgj-extracted
tar -xzf "$archive" -C fgj-extracted
./fgj-extracted/fgj version
./fgj-extracted/fgj help
```

The version must be `0.1.0+1924e9a`.
The suffix identifies the application source commit used for all three executables.

CAUTION: The next commands replace an existing executable at `$HOME/.local/bin/fgj`.
Keep a copy of an earlier executable if you need to restore it.

```sh
mkdir -p "$HOME/.local/bin"
install -m 755 ./fgj-extracted/fgj "$HOME/.local/bin/fgj.next"
mv "$HOME/.local/bin/fgj.next" "$HOME/.local/bin/fgj"
export PATH="$HOME/.local/bin:$PATH"
command -v fgj
fgj version
```

`command -v fgj` must show the executable you installed.
Add `export PATH="$HOME/.local/bin:$PATH"` to your shell startup file if that directory is not already on PATH.
For Bash, use the startup file your terminal loads, such as `~/.bashrc` or `~/.bash_profile`.
For Zsh, use `~/.zshrc`. Open a new terminal and check `fgj version` again.

Continue with [account and harness setup](../README.md#get-started).
Run setup at a human terminal, not through an agent.

## macOS security prompts

The macOS executable has an ad-hoc signature over its final bytes.
It has no Apple Developer ID signature or Apple notarization.
A browser download can require manual approval in macOS.

After you verify and trust the download, use [Apple's documented controls](https://support.apple.com/102445).
Do not disable system security or remove quarantine attributes as a routine installation step.

## Upgrade or remove

For an upgrade, verify the new archive before you replace the installed executable.
Keep the installation path fixed. The pi adapter records that path for its callbacks.
If the path changes, reinstall the pi rules with `fgj rules install pi` at a human terminal.
Review the proposed change before you confirm it.

fgj has no automatic uninstall command.
Before removal, inspect `fgj rules status` and `fgj skill status` at a human terminal.
Remove only fgj's rules, skill files and pi adapters from your harness configuration.
Use `fgj help rules` for rule locations. Preserve unrelated Claude Code settings.
Then remove only the executable you installed:

```sh
rm "$HOME/.local/bin/fgj"
```

Removing the executable does not remove profiles or revoke tokens on Forgejo.
Use `fgj help auth remove` before removal if you also want to remove a local profile.
Revoke unwanted tokens through the Forgejo account's token settings.

## Source and licenses

Each published native archive includes both fgj licenses, upstream runtime notices, LGPL texts, the application source archive and rebuild instructions.
The executables use application commit `1924e9a8221707e0aa16868df75189ad186836bc` and Bun 1.3.14.
The release keeps those tested executable bytes unchanged.
Installation documentation can receive later corrections on `main` without rebuilding the executables.

Use the included `REBUILD.md` for an archive-based application build or a modified Bun runtime.
Use [CONTRIBUTING.md](../CONTRIBUTING.md) for development on current source.
The [Bun license reference](bun-license.md) describes the embedded runtime and the limits of its license information.
fgj's MIT OR Apache-2.0 choice does not replace upstream licenses.

## Local native candidate checks

`bun run package:native` prepares a local candidate on macOS arm64 or Linux arm64 with glibc.
It is not a public release command and does not support Linux x64 packaging.
Local candidates contain the executable, both fgj licenses, this guide and the Bun license reference.
They do not include the final release's source and notice bundle.
Use the local candidate record for its version and source commit, not the public release values above.
The first Linux x64 executable used the existing build script with `--target bun-linux-x64-baseline` and separate native acceptance.

The manual `native-rehearsal` workflow builds an approved full commit from `main` on hosted arm64 platforms.
It does not create a version tag or publish a release.
On a public repository, treat its logs and artifacts as public material.
Do not send credentials, private service names or personal paths into a public build.

Set `FGJ_NATIVE_TARBALL` to a reviewed archive's absolute path to test account setup and all three harness installations.
Keep its matching `.sha256` file beside it.
Set `FGJ_NATIVE_PREVIOUS_TARBALL` to an earlier reviewed archive for replacement proof.
These tests use isolated homes and replay the pi callback. They do not replace human acceptance in an actual agent session.

Keep executable, archive and source digests in the release record.
If only documentation or notices change, verify the new archive and unchanged executable digest.
Do not repeat passed executable checks for unchanged bytes.
Keep repository-required checks for source changes and obey the [release controls](release.md).
