# GitHub workflows

[`contributor.yml`](contributor.yml) checks pushes to `main` and pull requests.
It uses disposable GitHub-hosted runners, read-only repository permissions and full action commit pins.
It stores no checkout credentials and uses no shared cache, release environment or OIDC permission.
It does not stage or publish packages. The [release guide](../../docs/release.md) defines the separate release boundary.

[`release.yml`](release.yml) defines the separate owner-dispatched release workflow.
It defaults to credential-free dry-run, tests one archive on Linux and macOS, and limits OIDC to protected staging.
It does not activate GitHub protections, npm trust or public release authority.

[`native-rehearsal.yml`](native-rehearsal.yml) builds private native candidates only after manual owner dispatch.
Each arm64 job has a 20-minute limit, a read-only token and no publication step.
It binds the source to the approved main commit, uploads once and downloads that exact artifact by immutable ID.
Linux tests the downloaded executable against the disposable Forgejo. The downloaded Mac archive needs the local Mac server test.
This rehearsal uses no version tag and does not establish release approval or runtime license compliance.

## Contributor checks

The Linux arm64 job runs full source, real-server and harness checks.
It records the package installation matrix and an npm-installed Forgejo read.
The provisioning script starts a local Forgejo process. The final step stops only that fixture.
The macOS arm64 job runs package installation and privacy checks without a test server.
Hosted arm64 macOS cannot run the current Podman fixture because it requires nested virtualization.
A release server-read test on macOS requires a separate reviewed environment with Podman.

Each job builds one local archive and reuses the path from package metadata.
The jobs do not share an archive. Their logs record each archive's digest and inventory.
Do not treat these jobs as exact-archive release proof across platforms.
Runtime pins are Node 24.19.0, npm 11.17.0 and Bun 1.3.14.
Linux harness pins are Codex 0.155.1 and pi 0.87.1. No paid model login is required.

## Manual release

The Linux job builds one release archive and runs the existing checks against its exact bytes.
It retains only the archive and its source, workflow, run, attempt and digest evidence.
The macOS job downloads that immutable artifact by ID and tests it without rebuilding or Podman.
The staging job requires both jobs, explicit stage mode and the `npm-stage` environment.
It verifies the same artifact and calls `npm stage publish` with explicit provenance and isolated npm configuration.
Only this protected job has `id-token: write`. No job has writable repository permissions.

[`release-artifact.ts`](../../scripts/release-artifact.ts) checks archive identity and exports its path for the existing tests.
A digest or evidence mismatch fails. An archive from a different run or attempt fails.
The workflow does not consume contributor artifacts or restore caches.
Its concurrency never cancels an active release run.
The owner completes manual Mac server proof before approving staging.
The owner later reviews and approves the npm stage with 2FA.

The [release guide](../../docs/release.md) defines environment setup, action pins, release procedures and validation limits.
Repository settings must restrict the actions to the exact pinned references.
No environment or npm trusted publisher is active merely because the YAML names it.

## Repository settings

Maintainers must verify these GitHub settings before contributor execution:

1. Require workflow approval for all outside collaborators.
2. Allow only the reviewed action repositories with full commit pins.
3. Set the default workflow token to read-only.
4. Do not attach self-hosted runners or repository secrets to contributor execution.
5. Protect `main` and require owner review before merging.

Workflow YAML cannot enforce outside-contributor approval or prove the saved repository settings.
Review workflow and script changes before approving an outside contributor's run.
An approved run still executes untrusted code on a disposable hosted runner.
Do not give that run release authority.

## Validation and sources

[`contributor-workflow.test.ts`](../../test/unit/contributor-workflow.test.ts) parses the YAML with Bun.
It checks triggers, runner labels, permissions, action pins, runtime pins, candidate reuse and cleanup.
It rejects explicit Node setup caching, disabled jobs and required steps, ignored failures and checks before candidate creation.
Changed workflow fixtures prove that the assertions reject these settings, privileged triggers and unsafe job settings.
These are local structural checks, not executed GitHub approval or isolation proof.
Record actual fork approval and both hosted job results after approved repository setup.

Primary sources checked on 2026-10-05:

- [Hosted runner labels and limitations](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
- [Outside-contributor approval](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/approve-runs-from-forks).
- [Pinned checkout inputs](https://github.com/actions/checkout/blob/d23441a48e516b6c34aea4fa41551a30e30af803/action.yml).
- [Pinned Node setup inputs](https://github.com/actions/setup-node/blob/249970729cb0ef3589644e2896645e5dc5ba9c38/action.yml).

[`release-workflow.test.ts`](../../test/unit/release-workflow.test.ts) checks manual triggers, default dry-run, job permissions, artifact transfer and staging isolation.
Mutation cases reject disabled checks, ignored failures, mutable or external artifacts, absent provenance flags and direct publishing.
[`release.test.ts`](../../test/unit/release.test.ts) executes the staging command with a fake npm binary and no registry request.
These tests do not establish saved protection settings, stage-only npm permissions or registry provenance.

The artifact actions run on Node 24 and support the approved GitHub-hosted runners.
They use the same MIT-licensed GitHub artifact interface, without an added package dependency.
The download pin fails on artifact digest mismatches by default. The workflow also requests this behavior explicitly.
GitHub.com supports these action versions. Forgejo and GitHub Enterprise Server do not use this workflow.

- [Pinned upload inputs](https://github.com/actions/upload-artifact/blob/043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/action.yml).
- [Pinned upload license](https://github.com/actions/upload-artifact/blob/043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/LICENSE).
- [Pinned download inputs](https://github.com/actions/download-artifact/blob/3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c/action.yml).
- [Pinned download license](https://github.com/actions/download-artifact/blob/3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c/LICENSE).
- [Artifact transfer](https://docs.github.com/en/actions/tutorials/store-and-share-data).

Maintainers must configure protected staging and the npm trusted publisher, then verify them at runtime.
Local or contributor checks do not establish those controls.
