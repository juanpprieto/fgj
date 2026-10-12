# Repository board creation

This reference describes the Forgejo 16.0.5 web contract and the proposed projects REST API.
It does not guarantee that the proposal will ship in a specific release.

## Web and REST paths

| Concern | Forgejo 16.0.5 web path | Proposed REST path |
| --- | --- | --- |
| Creation | Repository web form with `template_type` and `card_type`. | `POST /repos/{owner}/{repo}/projects` in the upstream proposal. |
| Columns | A configured server template supplies the saved column names. | The proposal has separate column creation requests. |
| Login | A web session, including TOTP when required. API tokens alone do not authenticate web creation. | The proposal describes a `write:project` token scope. Final scopes need release verification. |
| Permission | Projects enabled, Projects write access, and an unarchived repository. | The proposal requires project write permission. Final checks need release verification. |
| Upgrade | Defined web operations need layout and route checks after a server upgrade. | Use a REST implementation only after its release and real-server validation. |

fgj uses defined web operations because the tested release has no projects REST endpoint.
It does not expose a raw browser or an arbitrary web request command.

## Routes and response checks

| Operation | Route or result |
| --- | --- |
| Project list | `/{owner}/{repo}/projects` |
| New project form | `/{owner}/{repo}/projects/new` |
| Board view | `/{owner}/{repo}/projects/{number}` |
| Successful creation | HTTP 303 to the repository project list. |
| Token-only web request | HTTP 303 to `/user/login`, without a board. |
| Absent projects REST endpoint | HTTP 404 from `POST /api/v1/repos/{owner}/{repo}/projects`. |

A successful redirect does not prove the saved board contents.
Read the project list and the saved board after creation.
Do not repeat an uncertain creation request after a lost response or failed read-back.

Use the saved column names, not names inferred from a template identifier.
A configured `template_type=1` can provide Backlog, To Do, In Progress, and Done.
This does not establish arbitrary column creation or the same configuration on every server.

## Public upstream references

These sources describe the upstream state checked on 2026-10-02.
A schedule is not a projects API delivery guarantee.

- [Forgejo releases](https://forgejo.org/releases/) lists released versions.
- [The v16 announcement](https://forgejo.org/2026-07-release-v16-0/) describes the release schedule.
- [The projects API proposal](https://codeberg.org/forgejo/forgejo/pulls/13714) was open and unmerged at that date.
- [The proposal metadata](https://codeberg.org/api/v1/repos/forgejo/forgejo/pulls/13714) provides its state and release association.
- [The draft API documentation](https://codeberg.org/telekom-mms/forgejo-docs/src/branch/project-api-ideas/docs/user/project-api/index.md) describes project, column and token operations.
- [The project model](https://codeberg.org/forgejo/forgejo/src/tag/v16.0.5/models/project/project.go) defines template behavior for the tested release.
- [The repository routes](https://codeberg.org/forgejo/forgejo/src/tag/v16.0.5/routers/web/web.go) define the released web operations.

## Validation boundaries

Use the guarded fixture setup in [CONTRIBUTING.md](../CONTRIBUTING.md#run-the-complete-check).
The [real-server matrix](../test/server/board-write.test.ts) tests creation, reuse, templates, denied access and uncertain responses.
The [unit matrix](../test/unit/board-write.test.ts) checks the refusal contract at the client boundary.
The [harness guide](uat.md) describes separate no-prompt checks in Codex, Claude Code and pi.

Do not copy passwords, tokens, cookies or server state into evidence.
Stop only the disposable fixture that the validation started.
A local result does not establish a different server version or a harness approval boundary.
