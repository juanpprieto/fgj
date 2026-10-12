---
name: fgj
description: Use only to read, edit, close, or reopen Forgejo issues and pull requests and set their labels, milestones, and dependencies, create issues and pull requests, list and merge pull requests, read or wait for the checks of a commit or pull request, list, create, and edit a repository's labels, list, create, edit, close, or reopen its milestones, read, add, edit, or delete comments, attach text files to your own comments, create or reuse a repository board, read a board, find the board column of an issue, add issues to a board, or move cards between columns, read an Actions run and its logs, wait for it, or re-run it, or read listed repository endpoints that no verb covers, with the fgj CLI (nouns `issue`, `pr`, `label`, `milestone`, `dep`, `comment`, `board`, `run`, `status`, `api`). `fgj help` lists every fgj verb.
---

# fgj

`fgj` is the Forgejo CLI for agents. For the verbs that `fgj help` lists, it replaces
`tea api` and `curl`: each call is one plain command that returns small JSON. With the fgj rules installed, `read` and `write`
calls run with no approval prompt, and `destroy` calls ask a human.

## Find the command

- `fgj help` lists every verb. `fgj help <noun> <action>`, or `--help` on any call,
  shows the arguments, flags, fields, output, and examples. Help sends no request.
- A verb's `notes` in help are its rules. Read them before you first use the verb.
- The grammar is `fgj <read|write|destroy> <noun> <action> <args> [--flags]`. The risk
  class is always the first word. Take it from help.

## Write each call

- Run one plain fgj command per call. fgj output is already small, so it needs no pipe,
  `jq`, redirect, or `&&` chain.
- Write each body to a file first, then pass `--body-file /absolute/path`.
- Name an issue by its number (`157`) or its URL.
- Before a `destroy` call, run it with `--dry-run` and show the plan to the human.

## Read the result

- stdout is one JSON object. In a verb's result, `as` names the Forgejo account that
  acted. Check that it is the account for your role.
- A result with more to show has `next`. Run `next` exactly as given. When `next` is
  `null` or absent, you have everything.
- A body with `body_truncated` is cut. Run the result's `hint`, or follow its `note`
  when it has no hint.
- A write returns `changed`. `changed:false` means the change is already there, so a
  retry is safe and posts nothing.
- A write on many items returns one entry per item. An entry with `error` failed and the
  others did not; the exit code is the code of the first failure.

## Handle an error

stderr holds `{error:{code,message,hint}}`, and `hint` is a runnable fgj command.

| Exit | Code | Next step |
|---|---|---|
| 1 | `api` | The server or network failed. Report the message. |
| 2 | `usage` | Fix the command from the message, or run the hint. |
| 3 | `auth` | Run `fgj auth status` and report it with the hint. A human fixes tokens and the default. |
| 4 | `not_found` | Check the number and the repository (`--repo owner/name`). |
| 5 | `conflict` | The target's state blocks the change: for example another author's comment, or a locked repository. Report the message. |
| 6 | `risk_mismatch` | Run the hint. It has the correct risk class. |
| 7 | `identity_mismatch` | Remove `--as`. The harness sets your account. |

`fgj write board create Onboarding` creates basic Kanban or reuses one open name match. Run `fgj help board create` for template choices, refusal rules, and login prerequisites.

## Identity

The harness sets your Forgejo account through `FGJ_PROFILE`. Add `--as <profile>` only
when your instructions name a profile. Leave `FGJ_PROFILE` to the harness.

With neither, fgj uses the default profile that a human set for the host. With no
default, the call fails with exit 3. Ask the human to run the hint. Do not add `--as` to
get past it.

## Commands for a human

`fgj auth` (all forms except `status`), `fgj rules install`, and `fgj skill install` need
a human at a terminal, and they fail when an agent runs them. Ask the human to run them.
