# GitHub execution and protection proof

This guide describes how to verify contributor CI execution, approval and merge protection.
Primary sources were checked on **2026-10-05**.
The [contributor workflow](../.github/workflows/README.md) defines the jobs under test.
The [release guide](release.md) keeps release authority separate.

## Verification limits

Local checks cannot prove hosted runner images, saved GitHub settings or actual approval behavior.
Do not treat unavailable settings as secure defaults.
A trial in a private repository does not prove a public repository's outside-contributor approval policy.
A workflow-only trial cannot replace execution of the reviewed source.
Use the intended repository and exact source commit for each runtime check.

## Acceptance gates

| Gate | Required evidence | Failure condition |
| --- | --- | --- |
| Source binding | Approved source inventory, workflow bytes, public commit SHA, run ID and attempt. For a PR, record its head SHA and tested merge SHA. | The tested source differs from the reviewed source, or the run identity is missing. |
| Hosted execution | Both `check` and `package-macos` complete successfully on the documented hosted arm64 runners. Retain job and step records. | A required job or step fails, skips or uses an owner machine. |
| Saved permissions | API records and UI verification show restricted actions, required SHA pins, read-only default token permissions and disabled automatic PR approval. | A required setting is absent, inaccessible or broader than the reviewed policy. |
| Outside-contributor approval | A controlled PR from a genuine outside contributor waits for owner approval. After approval, both jobs run successfully. | The run starts before approval or the test actor is a repository collaborator. |
| Merge protection | An active rule requires the actual job checks. A controlled failing-test PR remains blocked without attempting a merge. | A failed required check does not block merging, or a broad undocumented bypass exists. |

Record all five gates before you claim that the contributor boundary passed.
A green run alone proves neither outside-contributor approval nor merge protection.

## Saved settings to verify

Use **Settings → Actions → General** in the intended repository.
GitHub documents all-external-contributor approval and full-SHA enforcement at this location.
Select these controls before contributor execution:

1. Require approval for **all external contributors**.
2. Allow selected actions and require full-length commit SHA pins.
3. Set workflow token defaults to read-only.
4. Disable GitHub Actions creation and approval of pull requests.
5. Keep self-hosted runners and privileged repository secrets out of contributor execution.

The workflow action allowlist is:

```text
actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803
actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38
actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a
actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c
```

Contributor jobs use checkout and Node setup. The manual release workflow also uses the two artifact actions.

Do not enable all GitHub-owned or all verified-creator actions as a substitute for this list.
GitHub's selected-action policy still allows local actions and owner actions.
It does not restrict arbitrary shell commands or npm packages. The disposable runner and lack of release authority remain necessary boundaries.
Default read-only permissions do not prevent a workflow author from requesting broader job permissions.
Review the actual workflow permissions and the job setup log as well.

Protect `main` with an active ruleset or branch protection rule.
Require the actual check names observed after the first hosted run.
Select GitHub Actions as the expected check source where GitHub supports that choice.
Block force pushes and deletion. Record the enforcement and every bypass actor.
A disabled ruleset is not protection. An administrator bypass can invalidate a negative merge test.

Required reviews must fit the maintainer model.
GitHub's latest-push approval option requires someone other than the last pusher.
Do not require an unavailable second reviewer for a sole maintainer's own changes.
Owner-only merging, formal required reviews and any owner bypass are different controls. Record the selected rule without claiming equivalence.
The owner controls merging throughout this proof.

## Read-only verification commands

These commands require `gh` authenticated with access to the intended repository and its settings.
Use the account's normal authentication flow. Do not print or share tokens.
All commands below read data. None creates a repository, changes a setting or transfers source.
The REST permission schemas were checked against GitHub's documented API version `2026-03-10`.

```sh
REPO=OWNER/REPOSITORY

gh api --hostname github.com --method GET -H 'X-GitHub-Api-Version: 2026-03-10' "repos/$REPO/actions/permissions"
gh api --hostname github.com --method GET -H 'X-GitHub-Api-Version: 2026-03-10' "repos/$REPO/actions/permissions/selected-actions"
gh api --hostname github.com --method GET -H 'X-GitHub-Api-Version: 2026-03-10' "repos/$REPO/actions/permissions/workflow"
gh api --hostname github.com --method GET -H 'X-GitHub-Api-Version: 2026-03-10' "repos/$REPO/actions/permissions/fork-pr-contributor-approval"
```

Expected permission records:

| Endpoint suffix | Expected values |
| --- | --- |
| `actions/permissions` | `enabled: true`, `allowed_actions: selected`, `sha_pinning_required: true` |
| `actions/permissions/selected-actions` | `github_owned_allowed: false`, `verified_allowed: false`, exactly the reviewed external action patterns |
| `actions/permissions/workflow` | `default_workflow_permissions: read`, `can_approve_pull_request_reviews: false` |
| `actions/permissions/fork-pr-contributor-approval` | `approval_policy: all_external_contributors` |

Capture the timestamp and repository identity with each record.
A 403 or 404 is not a passing record. Verify access or the UI before continuing.
Confirm self-hosted runner access, repository secrets, environment access and integrations through the owner's settings inventory.
Do not retrieve or print secret values.

Inspect actual active rules, including any inherited rules and bypass actors.
For classic branch protection, use:

```sh
gh api --hostname github.com --method GET "repos/$REPO/branches/main/protection"
```

For rulesets, use:

```sh
gh api --hostname github.com --method GET --paginate "repos/$REPO/rulesets"
# Replace RULESET_ID with an actual returned ID.
gh api --hostname github.com --method GET "repos/$REPO/rulesets/RULESET_ID"
```

Choose the endpoint that matches the configured protection.
A 404 on classic protection does not prove there is no active ruleset.
Listing rulesets alone does not prove their enforcement, branch target or bypass policy. Read their details.

## Execute and record the controlled proof

The workflow accepts `push` to `main` and `pull_request`, not `workflow_dispatch`.
Do not use `gh workflow run contributor.yml`. It cannot dispatch the current workflow.
A reviewed push or test PR supplies the appropriate event.
After an initial run, configure required checks from their actual names before the negative merge test.

Run the following proof only after the owner approves the source and public test actions:

1. Record a successful target run with both hosted jobs and all required steps.
2. Record an outside-contributor test PR while its workflow waits for approval.
3. Approve that reviewed run as the owner.
4. Record both successful jobs on the approved PR source.
5. Record a harmless failing-test PR that branch protection blocks without a merge attempt.

The outside test actor must not be an owner, member or repository collaborator.
A maintainer's own PR cannot prove this approval boundary.
Do not ask an external person to execute unreviewed scripts or share credentials.
A failing-test probe must remain unmerged. Agree on cleanup before creating public test records.
Do not change protection settings to make a proof pass.

Find and inspect runs with these read-only commands:

```sh
gh run list --repo "$REPO" --workflow contributor.yml --json databaseId,event,headSha,status,conclusion,url
# Replace RUN_ID with the exact run ID from the list.
gh run view RUN_ID --repo "$REPO" --json attempt,event,headSha,status,conclusion,jobs,url
gh run view RUN_ID --repo "$REPO" --log
```

Require `status: completed` and `conclusion: success` for the passing run.
Inspect each job and required step, not only the aggregate conclusion.
Keep the runner labels, runtime versions, token permission record, archive inventory and digest from the logs.
The Linux run must show full checks and the installed Forgejo read.
The macOS run must show package and privacy checks without Podman.
Each job has its own archive. Do not claim this proves one release archive across platforms.

For the negative PR, record the failed required check and GitHub's merge-block reason.
A skipped or neutral check can satisfy GitHub's required-check rules. Do not count either as successful execution proof.
Never test enforcement with a real merge, secret exposure or publication attempt.

## Evidence record and scope

Retain repository identity, settings timestamp, approved source inventory, public SHAs, run URLs, run attempts, job results and approval observations.
Retain the negative PR's failed check and merge-block evidence.
Keep settings captures and logs outside the exported public source. Redact private metadata before sharing.
Recheck the saved settings after changes to repository ownership, permissions, runner access or workflows.

These gates cover contributor execution and repository protections only.
They do not prove npm OIDC, release environment approval, exact-release-archive Mac tests, staging or registry provenance.
Those remain separate [release proof](release.md) gates.

## Primary sources

- [GitHub Actions repository settings](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository): approval choices, SHA-pin policy, action patterns and default token permissions.
- [Actions permission API](https://docs.github.com/en/rest/actions/permissions): read-back endpoints and expected policy fields.
- [Fork-run approval procedure](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/approve-runs-from-forks): owner review before approval.
- [Hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners): arm64 labels and macOS virtualization limits.
- [Secure use](https://docs.github.com/en/actions/reference/security/secure-use): immutable pins, untrusted code risks and hosted versus self-hosted runner boundaries.
- [Protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches): required checks, skipped/neutral acceptance, expected check sources and administrator bypasses.
- [Rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets): active enforcement and combined rules.
- [Run listing](https://cli.github.com/manual/gh_run_list) and [run inspection](https://cli.github.com/manual/gh_run_view): exact run, SHA, job and log records.
