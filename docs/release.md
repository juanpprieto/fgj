# Release constraints

This reference describes release builds, protected staging and provenance checks.
Repository settings and npm permissions require runtime verification.
Maintainers must review and approve release actions before execution.

## npm requirements

Primary sources checked on **2026-10-05**:

| Source | Requirement | Effect on the release |
| --- | --- | --- |
| [Staged publishing](https://docs.npmjs.com/staged-publishing/) | npm 11.15.0 or later and Node 22.14.0 or later. Staging and approval are separate operations. | CI stages the tested archive. The owner approves it with 2FA. |
| [Trusted publishers](https://docs.npmjs.com/trusted-publishers/) | GitHub trusted publishing requires GitHub-hosted runners. The publisher can have stage-only permissions. | Allow staging only. Refuse direct publishing and distribution-tag changes in CI. |
| [Trusted publisher configuration](https://docs.npmjs.com/trusted-publishers/#configuring-trusted-publishing) | The package settings identify the repository, workflow filename and optional environment. | Verify the saved settings after owner-approved setup. YAML alone does not prove these controls. |
| [Provenance](https://docs.npmjs.com/generating-provenance-statements/) | Provenance requires a public source repository and matching package repository metadata. `npm audit signatures` verifies installed attestations. | Retain the approved repository identity inside the packed manifest. Verify registry provenance before announcement. |
| [Bun semver](https://bun.sh/docs/runtime/semver) | Bun provides version comparisons and range checks compatible with node-semver. | Use the existing runtime parser instead of a new version engine. |
| [GitHub manual events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch) | A dispatch names a branch or tag. `GITHUB_SHA` identifies its last commit. | Require the version tag and bind its commit to checkout HEAD. |
| [GitHub context variables](https://docs.github.com/en/actions/reference/workflows-and-actions/variables#default-environment-variables) | GitHub supplies workflow identity, workflow SHA, the retry actor and the runner environment. | Check these values before a release build. Verify authority through the actual workflow and repository settings. |

Local preparation checks used Bun 1.3.14, Node 24.19.0 and npm 11.17.0.
The npm help lists archive input, distribution-tag selection, provenance and dry-run options for `npm stage publish`.
Local archive tests cover stable and prerelease metadata and npm installation.
These checks do not prove live OIDC, hosted execution or registry provenance.
Select final CI tool pins only after focused checks of the release path.

An npm publish dry-run can attempt authentication before it refuses a mutation.
Give dry-run no OIDC access or publishing credentials.
A dry-run flag alone does not isolate credentials.

## First-package bootstrap

Trusted publisher settings belong to an existing npm package.
[npm documents](https://docs.npmjs.com/staged-publishing/) staging for a package that does not yet exist.
It creates a public `0.0.0-stage` placeholder before the owner approves the candidate.
Recheck the registry name before setup.
Obtain separate owner approval before creating that placeholder.

A local bootstrap archive does not establish a GitHub-built release.
The final candidate must come from the approved public source and include verified provenance.
Do not add a publishing-token fallback without a new owner decision.

## Runner and macOS proof method

[GitHub runner documentation](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) lists hosted Linux and macOS arm64 runners.
It states that arm64 macOS runners do not support nested virtualization.
The existing macOS Forgejo fixture requires Podman virtualization.
Do not claim that fixture works on hosted arm64 Macs without an executed proof.

Use a separate reviewed arm64 Mac environment for the release server-read test.
Verify the digest of the exact reviewed CI archive before the test.
Reuse the existing disposable Podman fixture and temporary test homes.
Record help, version, server-read results and cleanup.
Do not rebuild or repack the archive for this proof.
Temporary homes do not sandbox code.
Never run external contributor jobs on owner machines.

Keep full server checks on hosted Linux.
Keep package installation checks on the supported hosted platforms.
Manual macOS proof applies only to reviewed release code.
A local preparation archive does not replace proof of the eventual CI candidate.

## Repository identity and version names

Derive the release repository from the public GitHub URL in `package.json`.
The release guard also requires the repository owner to start or retry the workflow.
Use Git tags named `v<package version>`.
Prerelease versions use the `rc` distribution tag. Stable versions use `latest`.
A version name does not grant publication authority.

## Manual workflow contract

The manual release workflow accepts only `workflow_dispatch`.
Its mode defaults to `dry-run`. Its explicit distribution tag defaults to `rc`.
A stable version requires `latest` and separate owner approval.
A staging request requires the public GitHub target. Private dry-run preparation remains possible.
Neither a source merge nor a tag push starts the workflow.
Release concurrency does not cancel an active run.

The workflow has three jobs:

| Job | Inputs and authority | Required proof |
| --- | --- | --- |
| Linux candidate | Reviewed version tag, complete Git history, read-only token and no OIDC. | Build one archive. Run full source, server, harness, installation and privacy checks against its exact bytes. |
| macOS package | The Linux job's immutable artifact ID and archive digest from this run. No OIDC. | Verify the source and archive identity. Run installation and privacy checks without Podman or a new build. |
| npm stage | Both successful jobs, explicit stage mode and the protected `npm-stage` environment. Only this job has OIDC. | Verify the exact archive and run identity. Stage it with provenance through isolated npm configuration. |

The artifact contains only the candidate tarball and its source, workflow, run, attempt and digest record.
Consumers use its immutable ID from the Linux job, never a name search, external run or contributor artifact.
The tarball digest remains separate from the outer GitHub artifact digest.
An artifact digest mismatch must fail, not warn.
A rerun must build and test a new candidate within the same attempt.
Do not rerun only the staging job with an archive from a prior attempt.

Before approving `npm-stage`, the owner must download and inspect the exact candidate.
The owner must also complete the Mac server-read test and record its digest.
The hosted Mac package job does not replace that manual server proof.
Configure the environment with the owner as required reviewer, self-review allowed and administrator bypass disabled.
Allow only reviewed version tags in that environment.
Verify the saved controls after setup. YAML does not establish them.

Configure npm trusted publishing for the repository in `package.json`, `release.yml` and `npm-stage`.
Permit staging only. Disable direct publishing and distribution-tag management.
CI must not approve or reject stages, create a bootstrap package, or use a publishing-token fallback.
The owner performs stage review and 2FA approval through supported npm tools.
No staging request is authorized by preparation of the workflow.

## Release action allowlist

The release workflow needs these exact action references:

```text
actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803
actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38
actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a
actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c
```

Restrict the action policy to these exact references.
An action allowlist does not grant permission to execute a release.
Keep broad GitHub-owned and verified-creator permissions disabled.
Keep the full-SHA requirement enabled.
The [workflow reference](../.github/workflows/README.md) records artifact action qualification and sources.

## Owner release procedure

Confirm repository protections, the version tag and npm permissions before these steps.
Stop if any required check remains incomplete.
The workflow file must exist on the default branch and on the reviewed version tag.
Replace `OWNER/REPOSITORY` and `VERSION` with the package repository and reviewed prerelease version.

1. Start the credential-free dry-run for the reviewed version tag.

   ```sh
   gh workflow run release.yml --repo OWNER/REPOSITORY --ref vVERSION -f mode=dry-run -f dist_tag=rc
   ```

2. Inspect both successful jobs, all required steps, the candidate digest and the source and workflow evidence.
3. After separate staging approval, start a new stage-mode run for that same reviewed tag.

   ```sh
   gh workflow run release.yml --repo OWNER/REPOSITORY --ref vVERSION -f mode=stage -f dist_tag=rc
   ```

   This run builds and tests its own candidate. It does not reuse the dry-run's artifact.
   Do not approve `npm-stage` before the checks pass.

4. Before approving the environment, record manual Mac server proof against this run's exact candidate and digest.
5. After staging, review the stage through supported npm tools before separate 2FA publication approval.

   ```sh
   npm stage view STAGE_ID --json --registry https://registry.npmjs.org
   npm stage download STAGE_ID --json --registry https://registry.npmjs.org
   ```

The owner must authenticate for these npm review commands.
Stage-only OIDC cannot read or approve stages. Do not give CI a token to bypass this limit.
Compare the downloaded stage tarball's digest with the tested candidate.
Refuse approval if the required provenance is absent or names different source, artifact or workflow information.
Explicit `--provenance` requests npm-generated provenance. It does not replace registry verification.
If supported tools cannot establish the required stage proof, stop before approval.

After separate publication approval, the owner approves the verified stage with 2FA.

CAUTION: Approving a stage publishes its package version.

```sh
npm stage approve STAGE_ID --registry https://registry.npmjs.org
```

After separately approved publication, install the exact registry version in a private temporary home.
Record help, version and the supported platform server reads.
Run `npm audit signatures` through supported npm tooling.
Record the verified attestation, public source SHA, workflow identity and archive match before announcement.
Passing signature verification alone does not establish that an attestation exists for this package.
Do not add a custom provenance verifier or substitute a local archive for registry proof.

## Failure and retry rules

If staging fails or its result is unclear, inspect the owner's stage list before starting another run.
Do not retry staging blindly after a network error.
If the candidate is incorrect, the owner rejects its pending stage through interactive npm tools.
CI cannot approve or reject that stage.
A new run or attempt needs new artifact checks and manual Mac proof.
Rerun all jobs, not only staging, because the artifact evidence binds the attempt.
If the artifact expires, start a new reviewed run rather than accepting a different artifact by name.

Never overwrite a published version or move an announced release tag.
If a post-publication check fails, stop the announcement and record the failure.
Changed published code requires a new version and separate release approval.
Do not add an automatic retry, token fallback or distribution-tag repair.

## Local proof and limits

The [release tests](../test/unit/release.test.ts) use synthetic GitHub context and Git fixtures.
They test public staging refusal, source matching, archive identity, evidence binding and credential refusal.
They execute the literal staging command with a fake npm binary, not a registry request.
A real npm probe runs the same environment with a read-only configuration command instead of staging.
It checks that npm accepts the isolated user and global configuration files.
The fake npm probe checks configuration isolation, exact archive input, explicit provenance and preservation of npm's GitHub context fields.
It does not generate a real OIDC token or attestation.

The [workflow tests](../test/unit/release-workflow.test.ts) parse YAML and mutate unsafe configurations.
They reject unsafe triggers, ignored failures, disabled checks, alternate artifacts and direct publishing.
They do not prove arbitrary shell behavior, saved environment controls or npm stage-only permissions.
Verify main protection, contributor approval and npm stage-only permissions before staging.

## Release guard boundaries

[`release-check.ts`](../scripts/release-check.ts) checks source and archive inputs without staging or publication.
Use `--release` with the build or package script to enable these checks before a build.
Release packaging also checks the final candidate before it moves the archive to its output path.

The guard requires an owner-dispatched version tag on a GitHub-hosted runner.
It binds the event SHA, workflow SHA, tag commit and checkout HEAD.
The checkout commit must belong to fetched `origin/main` history.
Fetch complete history and tags before this check.
It also refuses dirty trees, incorrect metadata, unexpected files, changed licenses and archive digest mismatches.

The guard checks context values. It does not authenticate the caller or verify GitHub protection settings.
Dry-run refuses known publishing-token and OIDC environment variables without printing their values.
Stage checks require GitHub OIDC context and refuse ambient npm publishing tokens.
The [manual workflow](../.github/workflows/release.yml) also isolates npm configuration and restricts job permissions.
Do not treat environment checks as a credential isolation boundary.

Local package commands without `--release` still allow development candidates without repository metadata.
The release path refuses absent or incorrect source and packed repository metadata.
The guard does not verify provenance attestations. Use supported npm commands for that proof.

The [contributor workflow](../.github/workflows/README.md) separates hosted checks from release authority.
Local tests check its structure and reject changed fixtures with unsafe settings.
These tests do not prove GitHub approval settings or hosted execution.
The [GitHub validation guide](github-validation.md) defines the required hosted runs, saved settings and controlled negative proof.

The manual workflow and its refusal tests provide local checks only.
Verify protected staging, npm permissions, hosted execution and registry provenance through their own interfaces.
Passing local archive tests does not establish a completed release.
