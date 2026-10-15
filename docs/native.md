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
Permanent installation, native harness callbacks, replacement and the complete download-to-first-read path still need validation.
The [additional setup guide](setup.md) covers account bindings and other harnesses.

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
