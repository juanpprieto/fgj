# fgj design

fgj is a Forgejo command-line interface that humans build for LLM coding agents. This
document explains the problems it answers, the gaps in the Forgejo API and in the tools
around it, and the contract that every fgj command keeps. The README shows how to use
it; this document shows why it works the way it does.

Facts about Forgejo apply to Forgejo 16.0.5, the version that the tests pin, unless a
line names another version. Facts about other tools carry a link and a version or date.
The disposable tests prove fgj behavior against that pinned release. External tool
facts describe their cited versions, not a promise of compatibility.

## 1. The problem for agents

A coding agent (Claude Code, Codex, pi, and others) reaches a forge through a shell or
through tools. Four problems appear on every forge, and Forgejo adds its own gaps
(section 2).

- **Approvals.** A harness asks a human before a command unless a rule allows it. A rule
  matches command text, so it cannot tell a read from a delete when one command does both.
  People approve most prompts without much review: Anthropic reports that users approve
  93% of permission prompts
  ([2026-03](https://anthropic.com/engineering/claude-code-auto-mode)). Many prompts
  teach people to approve, and too few allow rules let dangerous calls through.
- **Context cost.** Every byte that a call returns goes into the model's context. A raw
  Forgejo issue has about 800 tokens of metadata before its body. Tool schemas cost too:
  in one five-server MCP setup, the tool definitions alone took about 55,000 tokens
  ([2025-11](https://www.anthropic.com/engineering/advanced-tool-use)).
- **Identity.** Most tools act with one token. When several agents share a human's
  token, the forge cannot show which agent did what, and every agent can do everything
  that the human can do.
- **Untrusted text.** Issue and comment bodies are written by anyone who can post. A
  malicious public issue made an agent with a GitHub MCP server leak private repository
  data ([Invariant Labs, 2025-05](https://invariantlabs.ai/blog/mcp-github-vulnerability)).
  An agent that reads untrusted text, holds private data, and can send data out is at
  risk ([2025-06](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/)).

fgj does not solve untrusted text. It narrows what an agent does without a human: a
`destroy` call needs a human's approval, and each agent role acts as its own account.

## 2. Gaps in the Forgejo API

Each row is a behavior of Forgejo 16.0.5 that cost agents time, tokens, or correctness,
and what fgj does about it. fgj's real-server tests cover the rows.

### Features with no REST endpoint

| Gap | Effect on an agent | fgj |
|---|---|---|
| No REST API for project boards. A projects API is in review ([PR #13714](https://codeberg.org/forgejo/forgejo/pulls/13714)); Gitea 28 has one ([2026-09-30](https://blog.gitea.com/release-of-28.0.0/)). | Agents drive the web UI with browser automation, or cannot use boards. | `board` verbs send a few defined requests to Forgejo's web routes. |
| No REST re-run for Actions. Forgejo 17 adds one ([PR #13924](https://codeberg.org/forgejo/forgejo/pulls/13924)). | An agent cannot re-run a failed job without a browser. | `run rerun` uses the web route. A move to the REST route on Forgejo 17 is planned. |
| Web routes refuse API tokens and redirect to the sign-in page. | Each web operation needs a signed-in session. | A human signs in each profile once (`fgj auth web`). fgj keeps only the remember-me cookie, and opens a short session from it for each call. It never stores the password. |
| A board move places the cards that it names and packs every other card of the column after them. The add route answers ok for an issue that it skips. | A move can reorder a column, and an add can report a change that did not happen. | fgj names the whole column in its current order, and reads the board back after an add. |
| The attachment download URL is a web route. | An agent with a token gets the sign-in page, not the file. | `comment get --attachment-text` reads the file with the read token, which this route accepts. |

### Actions

| Gap | Effect on an agent | fgj |
|---|---|---|
| A run has a web number, an API run id, job ids, and task ids, and they differ. A web number used as an API id can return a different run. | An agent reads the wrong run with no error. | `run` verbs take the web number, a run URL, or `--pr`, and fgj finds the ids. |
| `actions/runs` applies `limit` only with `page`, and each run carries the event payload and the repository, about 17 KB per run. | One call returned 41 runs and 683 KB. | fgj pages each call and returns a small shape. |
| A job log has a timestamp and color codes on every line, and lines can reach 65,000 characters. | A log does not fit in context. | `run log` removes timestamps, colors, and lines with a masked `***`, cuts long lines, and returns the error lines with context, the lines that match a text, or the tail. |
| The combined commit status ranks `warning` above `pending`, counts only one page of checks, and answers the same for "no checks" and "no such ref". | A wait loop stops early, or never stops. | `status get` reads up to 20 pages of checks and shows each check with its Actions run. `status wait` keeps waiting while any check is pending, for up to 90 s, then gives `next`. `run wait` does the same for a run. |

### Pull requests, issues, and comments

| Gap | Effect on an agent | fgj |
|---|---|---|
| The create and edit APIs have no draft field. A title prefix (`WIP:`, `[WIP]`) marks a draft, and the `draft` that the API returns comes from it ([config](https://forgejo.org/docs/latest/admin/config-cheat-sheet/)). | Agents send `draft:true`, and the server ignores it. | `pr create --draft` and `pr edit` add or remove the prefix. |
| `mergeable` stays true while branch protection refuses the merge. | A merge fails after the agent reports it as ready. | `pr merge --dry-run` shows the checks of the head, and the merge pins the head SHA. |
| Every collaborator with write access can edit or delete every comment. | One agent can change another author's text with no prompt. | `comment edit`, `comment attach`, and `comment delete` change only the caller's own comments. |
| Unknown label names, a close of a closed issue, and an unchanged body all answer success. A duplicate dependency add answers HTTP 500. | An agent cannot tell a change from a no-op, and a retry can fail. | fgj checks names before it sends, and each write returns `changed`. `changed:false` means the state is already so, and a retry is safe. |
| Label names are not unique, and case-only duplicates are allowed. | A repeated create makes duplicates, and an edit by name can change the wrong label. | `label create` and `label edit` match the name without case, and refuse duplicates. |
| A label edit saves `exclusive:true` on a name with no scope. Turning a label exclusive moves no labels: an issue keeps every label of the scope. A later add of an exclusive label removes only the other exclusive labels of its scope. | An agent can save a label that cannot act as exclusive, and can expect a cleanup that does not happen. | `label edit --exclusive` needs a scoped name, and its help names the effect on issues. |
| The server stores bodies byte for byte. | A tool that changes line endings or trailing spaces changes the text. | fgj sends a body file byte for byte, and compares exact bytes for a repeat. |
| The comments endpoint has no paging, and the server's page size can be smaller than the `limit` that a client asks for. | An agent reads every comment, or misses items at a page end. | fgj reads the server's page size and returns windows with `next`. |
| Attachments: the server checks the file type but not the size, and a file name with `"` answered HTTP 500. | An upload fails late or with an unclear error. | `comment attach` checks the size and type first, and sends the name in a query parameter. |

### Milestones

| Gap | Effect on an agent | fgj |
|---|---|---|
| Milestone titles are not unique, and the API saves an empty or 300-character title. The web form saves at most 50 characters. | A repeated create makes duplicates, and a long title cannot be edited in the web UI. | `milestone create` matches the title without case, reports a conflict, and takes 1 to 50 characters. |
| An issue edit takes the milestone as an id. `null` changes nothing with no error, `0` removes it, and an unknown id answers HTTP 500. | An agent cannot remove a milestone, or gets a server error. | `--milestone` takes a title or an id and checks it before it sends. `none` removes the milestone. |
| A milestone's `open_issues` and `closed_issues` change about 1 s after an issue edit. The issue filter `milestones` reads a title before an id, and ignores a value that names no milestone. | A list right after an edit shows old counts. A filter can count another milestone, or every issue. | `milestone list` counts with the filter value that names only that milestone, checks the first issue, and else uses the server's counts. |
| The milestone list with no `state` returns open and closed milestones. A state change to the same state still changes `updated_at`. | A default list mixes states, and a repeat looks like a change. | fgj always sends `state`, and sends nothing when the state is already so. |

### Tokens and output

| Gap | Effect on an agent | fgj |
|---|---|---|
| Token scopes are read or write. Write covers delete ([token scopes](https://forgejo.org/docs/latest/user/token-scope/)). | A token that can comment can also delete. | fgj's `destroy` class makes the harness ask a human. This is a client-side guard, not a server boundary. |
| Forgejo can echo a token in an error message. | A token can reach the model's context and its logs. | Every output line passes a redactor that removes known tokens. |
| The server reads `token`, `access_token`, and `sudo` from the query. | A passthrough call can change the acting account. | `api get` refuses these parameters. |
| A raw issue has about 800 tokens of metadata. A comment add answers with about 330 tokens. | Each call costs context. | fgj returns about 100 tokens of metadata for an issue, and about 35 for a comment add. |

## 3. The tools that exist

Several tools reach Forgejo today. Each one fits some work well.

| Tool | What it is | Output | Identity | How a harness rule sees it |
|---|---|---|---|---|
| [tea](https://gitea.com/gitea/tea) 0.16.0 (2026-09-10) | Gitea's official CLI. Wide coverage, `tea api` for any endpoint. Its README does not name Forgejo. | Several formats, `--output json` among them, on many commands | Named logins, each with one token, SSH key, or OAuth | One rule per subcommand. `tea api` is one command for GET and DELETE alike. |
| [fj](https://codeberg.org/forgejo-contrib/forgejo-cli) 0.6.0 (2026-07-19) | The Forgejo community CLI: issues, pull requests, repositories, organizations, releases. | No JSON output in its docs | One token per host | One rule per subcommand |
| [fgj (romaintb)](https://codeberg.org/romaintb/fgj) 0.5.0 (2026-07-20) | A Go CLI "like `gh`" for Forgejo, aimed at AI coding agents. It has `fgj api` and an Actions re-run. Unrelated to this repository; the names collide. | JSON on most list and view commands | Its own login | One rule per subcommand |
| [gitea-mcp](https://gitea.com/gitea/gitea-mcp) 1.8.0 (2026-09-30) | Gitea's MCP server: 57 tools, with project and re-run tools. Some tools run several operations through a `method` parameter. A read-only mode hides the write tools. | Tool results | One token, a header per request over HTTP, or OAuth 2.1 so that each user acts as their own account | One approval per tool, in the MCP client |
| [forgejo-mcp](https://git.b4mad.industries/agentic-forges/forgejo-mcp) 3.2.0 (2026-09-16; [GitHub mirror](https://github.com/goern/forgejo-mcp)) | A community MCP server for Forgejo with 100+ tools, Actions logs included. | Tool results | One token, a header per request over HTTP, or an OAuth resource-server mode (OIDC, Forgejo 16+) so that each user acts as their own account | One approval per tool, in the MCP client |
| curl and the [REST API](https://forgejo.org/docs/latest/user/api-usage/) | Every endpoint, with Swagger docs. | Raw JSON | Any token in a header | Hard to allow: URLs, quotes, and pipes vary per call |
| Browser automation | Playwright, agent-browser, and similar tools on the web UI. | Page snapshots | A browser session | Usually one broad rule, often with `eval` |

Design constraints for these paths:

- **Shell scripts complicate allow rules.** Wrappers, pipelines and shell expansion can
  hide the target command from a prefix rule. fgj returns runnable plain commands.
- **HTTP errors must fail.** A caller must not mistake a missing object for success.
  fgj maps HTTP failures to explicit error results and exit codes.
- **Web changes need confirmation.** fgj uses defined requests and checks saved state.
  A browser interaction alone does not prove that Forgejo kept the change.

### What fgj adds

fgj has fewer verbs than tea, fj, or the MCP servers: it covers the issue, milestone, comment,
pull request, CI, and board work that coding agents do most. It adds a safety model and small
output, not coverage:

- **The risk class is the first word.** `fgj read`, `fgj write`, and `fgj destroy` each
  match one harness rule. One rule allows reads and reversible writes with no prompt; one
  rule asks a human before a change with no undo.
- **Two tokens per account.** `read` calls send GET only, with a read-scoped token.
- **One account per agent role.** The harness binds each role to a profile, and a bound
  profile cannot be reached by an agent's own choice.
- **Generated harness rules.** `fgj rules install` writes the rules for Codex, Claude Code,
  and pi from the same manifest as the help.
- **Small output, one call per intent.** Each result is one line of JSON with names, not
  objects. A long list ends with `next`, the exact command for the rest.
- **Defined web operations only.** fgj sends a few web requests that it defines, and has
  no raw browser or `eval` passthrough.

fgj does not support Gitea, and its tests cover only Forgejo 16.0.5.

## 4. Principles

1. LLM agents inside a harness are the primary user. Optimize for token flow: small
   outputs, no echo, one call per intent, actionable errors.
2. Every command is allowlist-friendly in every supported harness.
3. fgj owns the generic Forgejo mechanism. A team's workflow policy lives in its own skills
   and prompts, which compose fgj commands.
4. Use the web routes only for an operation with no REST endpoint, through defined
   operations.

## 5. Command contract

- Grammar: `fgj <read|write|destroy> <noun> <action> <plain args> [--flags]`.
  - argv[1] is the risk class. No global flag or alias comes before it.
  - `read` = GET only, read-scoped token. `write` = a change that a later call can
    reverse. `destroy` = no undo.
  - Meta commands (`help`, `version`, `auth`, `rules`, `skill`, `hook`) sit outside the risk
    classes. A human runs the ones that change tokens or harness config.
- Arguments never need shell metacharacters. Bodies: `--body-file PATH` only.
  Milestone edits accept exact UTF-8 text through `--description-file PATH`.
  This file can be empty and cannot be combined with `--description`.
  - An issue argument is `157`, `'#157'`, or the issue or PR URL. `next` and hints
    repeat it as `157` or the clean URL.
  - Flags: `--name value` or `--name=value`, long flags only. `--json` is accepted and
    ignored, because the output is always JSON.
- Repo: git `origin` of cwd; trailing `--repo owner/name` overrides owner and name only.
  A trailing `.git` is dropped.
- Host: an issue URL argument names the host and the repository. Otherwise the first
  source that gives one, else a usage error with a `hint`:
  1. `origin`: https for an ssh remote, the URL scheme for an http(s) remote. It counts
     only when its host is stored or is `FGJ_URL`, so a GitHub clone is skipped.
  2. The host that `fgj auth` stored, when exactly one exists.
  3. `FGJ_URL`.
- Identity: each agent role acts as its own Forgejo account through a named profile.
  - A profile is one account on one host: a read token and a write token in
    `~/.config/fgj/hosts.json` (directory 0700, file 0600), and after `fgj auth web`
    the remember-me cookie for the board verbs and `run rerun`. fgj refuses the file when
    other users can read it.
  - The harness binds a role with `FGJ_PROFILE`; a call can name one with a trailing
    `--as <profile>`. When both are set and differ, the call fails with
    `identity_mismatch` (exit 7) before any request, so a model cannot switch the
    identity that the harness set.
  - A human can mark a profile bound only (`fgj auth bound <profile>`). It then acts
    only through `FGJ_PROFILE` from a harness binder, never as the host's default or
    through `--as`. In a bound pi lane, the adapter blocks commands that set or
    remove `FGJ_PROFILE`. A lane that still loses its binding acts as the host's
    default, unless that default is bound only or no default exists (exit 3).
  - Binders guard against accidents and drift, not a model that sets out to act as
    another role: every lane runs as the same OS user that owns the token file.
  - An issue URL or a known origin names the host first; a selected profile supplies
    it when neither does. The target host must match the selected profile.
  - With no selection, fgj uses the host's default profile. Only a human sets it: `fgj
    auth` asks `[y/N]` after it saves a profile, and `fgj auth default <profile>` changes
    it later. No command unsets it; removing the profile does. fgj never sets a default
    by itself, even for a host with one profile. With no default, the call fails closed
    (exit 3) before any request. The hint is `fgj auth default <profile>` for a host with
    one profile, and `fgj auth status` for more. The error does not suggest `--as`: an
    agent must not choose its own account.
  - With no profile for the host, `FGJ_READ_TOKEN` and `FGJ_WRITE_TOKEN` apply only when
    `FGJ_URL` names it; the identity is then `env`.
  - Every result carries `as`, and so does every error after fgj picks the identity.
    `next`, `apply`, and `hint` repeat `--as` only when `--as` chose the profile.
  - Each write or destroy call that gets an identity, and each refused `--as`, appends one
    line to `~/.local/state/fgj/audit.jsonl` (mode 0600): time, profile, user, host, repo,
    argv, cwd, result or error, and the harness and session id when the env shows them.
  - `fgj auth [--profile <name>] [<url>]` needs a human at a terminal. It names the
    token page and the permission settings, reads each token with echo off, and checks
    the scopes before it saves: the read token must not write, and the write token must
    have `write:issue` and `write:repository`. Without `--profile`, the profile name is
    the user's login in lowercase.
  - `fgj auth status` is safe for agents: profiles, users, a live check, the web login and
    its end date, the default for each host, and the active identity for this directory
    or the reason there is none, with no tokens.
  - `fgj auth web [--profile <name>]` needs a human at a terminal. fgj signs in with the
    password (and TOTP code) and remember-me, and keeps only the remember-me cookie in the
    profile. It never stores the password. Each web call gets a new short session from
    that cookie alone: sending a live session with it would sign out every other agent
    that holds the session. The cookie lasts `LOGIN_REMEMBER_DAYS` (31 by default; 365
    gives about one sign-in per role per year). A password change revokes it. When it
    ends, the board verbs and `run rerun` fail with `auth` and the hint
    `fgj auth web --profile <name>`; there is no early warning.
  - `fgj auth default <profile>` needs a human at a terminal and a `[y/N]`. `fgj auth
    remove` clears the default of the profile it removes.
- Output (stdout): compact JSON.
  - Names, not objects: `author:"alice"`, `labels:["bug"]`. No avatar/API URLs or internal IDs. A color appears only when `--fields` asks for it.
  - `--fields a,b` selects fields; `--fields` alone lists them.
  - Bodies truncate at `--body-max 4000` Unicode characters (at most 20000). Only a cut
    body carries `body_truncated` and `body_chars`. While a larger `--body-max` shows
    more, the result's `hint` is that command; when fgj cannot show the whole body, a
    `note` says how much it shows. One item never passes the output cap: fgj measures
    it after JSON escaping and cuts the body further if needed.
  - Hard cap of 28,000 characters, below the 30,000-character read-back limit of the
    harnesses.
  - Lists: 20 items default, `{items, total, next}`. `next` is the exact fgj command for
    the next page, or `null` at the end. A page ends early when the next item would pass
    the output cap, so `next` uses `--offset N`, not a page number. `--last N` returns
    the latest N items.
  - Multi-ID reads: one ID returns the item itself. Two or more return `{items, missing}`;
    `missing` appears only when an ID does not exist, and `next` only when the output cap
    cuts the result.
- Writes: idempotent; return `{changed, number|id}`, and `url` only for a new object.
  Never echo the body or anything else that the caller sent.
  - A write on many items changes each one it can. Each item is one entry; a failed item
    has `error {code, message, hint}`, and the exit code is the code of the first failure.
    The top-level `changed` is true when any item changed.
  - `comment add`: when the latest comment is yours with the same body, it returns
    `changed:false` and posts nothing, so a retry is safe.
  - `--dry-run` on write/destroy writes nothing and returns
    `{dry_run, changed, …, apply}`: `changed` predicts the result, and `apply` is the
    exact command. A `destroy` dry run still prompts: prefix rules cannot see trailing
    flags.
  - Commands that fgj prints quote any value with unsafe characters, so they stay
    runnable. `--body "text"` fails with a pointer to `--body-file`.
  - No lost-update guard: the last write wins, and Forgejo's edit history is the backstop.
- Errors (stderr): `{error:{code,message,hint}}`; `hint` is a runnable fgj argv. A
  server message keeps its first line only. HTTP 401 means a bad token; 403 means a
  missing scope or no access; 423 (archived or locked) and 412 (for example, a close that
  open dependencies block) are conflicts. `conflict` means that the target's state blocks
  the change, for example another author's comment. Fixed exit codes: usage, auth, not
  found, conflict, risk mismatch, identity mismatch. fgj checks input locally before any
  network call.
- Help: `fgj help` lists every verb, and one entry that points to `fgj help auth`,
  `fgj help rules`, and `fgj help skill` for the setup commands (target under 1,500
  tokens). A test holds it under 6,000 characters with a release version and a full
  40-character SHA. `fgj help <noun> <action>` adds args, fields, exit codes, 1–2
  examples, and the verb's `notes`: its own rules. The skill holds only rules that span
  verbs, under a line limit that a test checks, so it does not grow with each verb. Help
  ignores a leading risk word (`fgj help destroy comment delete`), because agents often
  write it that way.
- Verbs: the README lists every verb, from the same manifest as `fgj help`.

### Example shapes

```
fgj read issue get 157
{"number":157,"title":"…","state":"open","labels":["type/bug"],"body":"…","as":"dev"}

fgj write comment add 157 --body-file /tmp/c.md
{"changed":true,"issue":157,"id":98765,"url":"…#issuecomment-98765","as":"dev"}
```

## 6. Decisions

| Decision | Choice | Why |
|---|---|---|
| Harnesses | Codex, Claude Code, pi | The harnesses that fgj's agents use. Each new harness needs generated rules and match tests. |
| Language / runtime | TypeScript on Bun, pinned to 1.3.14; `bun build --compile` binary per OS | Fast startup on each agent call. Pin the runtime and validate compiled binaries on each supported platform. |
| Tests | `bun test` against a disposable Forgejo 16.0.5: the release binary on Linux, the pinned image through Podman on macOS | Forgejo ships no macOS binary. Mocks do not prove server behavior. |
| REST + auth | Direct `fetch` to `/api/v1`; a read token and a write token per profile in a 0600 file, with an env fallback | No CLI dependency, and exact control of each method. |
| Enforcement | Each verb declares its class; the dispatcher rejects a mismatch; the read path sends GET only, with the read token | Harness rules match text; they are not a boundary. |
| Web operations | Direct requests to Forgejo's web routes, with a remember-me cookie per profile; no browser | Only for operations with no REST endpoint, and only defined operations. |
| Rule delivery | One manifest, rules per harness. `fgj rules show` and `status` are safe for agents; `fgj rules install <harness>` shows a diff and needs a human at a terminal | An agent must not grant itself permissions. |
| Codex target | `~/.codex/rules/fgj.rules` only | Codex loads every `*.rules` file; fgj touches no other rules file. |
| Claude Code target | Merge fgj-owned entries into `~/.claude/settings.json` | No user-level drop-in exists; `managed-settings.d` needs root. Uninstall removes only fgj entries. |
| pi | A generated adapter, `~/.pi/agent/extensions/fgj-gate.ts`, and one role file per role (`fgj rules install pi --role <role>=<profile>`) | pi has no approval prompts of its own ([2025-11](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)), so the adapter owns pi's `bash` tool and asks fgj's gate about each command that could reach fgj. It asks on destroy, on every `fgj auth` form except `status`, and on any fgj call whose words the shell can change. After a yes, it gives that call a one-time approval, so a destroy that a script hides from the gate still fails. A role file sets `FGJ_PROFILE` on each bash call and blocks an account change. |
| Discovery | Two-level help with per-verb `notes`, and a generated skill of at most 70 lines | The skill points at help; it holds no copy of the manifest. |
| Composite flows | Not in fgj | A team's skill composes verbs; fgj holds no one's policy. |
| License | MIT OR Apache-2.0 | Retain both license texts and required attribution in source and package exports. |
| Rejected | Building on tea or fj; a raw browser passthrough; a lost-update guard | fgj needs exact control of each request and its output, and no `eval` path. |

## 7. Harness facts

- Claude Code: `Bash(fgj read *)` glob; splits `&& || ; |`, and each part must match;
  deny > ask > allow; does not unwrap a `bash -c` that the model writes. Inline env
  assignments break allow matches.
  ([permissions](https://code.claude.com/docs/en/permissions))
- Codex 0.155.1: token prefix rules; forbidden > prompt > allow; `match` and `not_match`
  load-time tests. It wraps every command in `zsh -lc` itself and splits plain scripts.
  ([rules](https://learn.chatgpt.com/docs/agent-configuration/rules))
- pi 0.85.1 and 0.87.1: no built-in approval; needs a `tool_call` extension. A handler
  returns nothing or `{block:true}`; the first block wins, so no extension can pre-approve
  a call.
- opencode: anchored glob, last match wins, default bash = allow; `fgj read x > file`
  matches `fgj read *`. fgj generates no opencode rules yet.

## 8. Token store: why not the Keychain

fgj uses a 0600 file for unattended token access. OS credential stores can require
interactive consent when an executable's identity changes. Such prompts conflict
with unattended agent calls.

The controls are two narrow tokens, a scope check at `fgj auth`, a mode check on each
read, and a dedicated bot account. A file-mode check does not provide OS isolation.
The store stays in one module so a future credential backend can replace it.

## 9. Known risks

- The board verbs and `run rerun` depend on Forgejo's web pages, so a Forgejo upgrade can
  break them. Each reader fails when a page lacks the parts that it reads, and the
  real-server tests pin 16.0.5.
- The `destroy` guard is in the harness, not on the server. A token with write scope can
  delete through any other tool.
- fgj does not filter untrusted text in issue and comment bodies. It returns them as data.
