# verbs

The fgj verbs. [`manifest.ts`](manifest.ts) lists every verb; help, the harness rules,
and the dispatcher read that list. Each noun has one file:
[`api.ts`](api.ts), [`board.ts`](board.ts), [`comment.ts`](comment.ts),
[`dep.ts`](dep.ts), [`issue.ts`](issue.ts), [`label.ts`](label.ts),
[`milestone.ts`](milestone.ts), [`pr.ts`](pr.ts),
[`run.ts`](run.ts), and [`status.ts`](status.ts). [`common.ts`](common.ts) holds what
several nouns share: flags such as `--repo` and `--dry-run`, and the readers for issue
and comment arguments and body files. [`wait.ts`](wait.ts) holds the poll loop and the
90 s limit that `status wait` and `run wait` share.

A verb declares its risk class, arguments, flags, fields, and examples. Its `notes` hold
the rules an agent needs before the first call; help shows them, so the skill stays
short. A destroy verb also declares its `effect`, which the pi dialog shows. Its `prepare`
step checks the input with no network call. Its `run` step gets a `ReadApi` or a
`WriteApi` that matches its risk class, and a web client for operations with no API: a
`WebReader` (GET only) for read verbs, a `WebWriter` (GET and POST) for write verbs.

This directory does not parse argv, resolve the host, or find tokens.
