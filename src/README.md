# src

The `fgj` binary. [`cli.ts`](cli.ts) is the entry point; it passes argv to `core/dispatch.ts`.

- [`core/`](core/README.md) owns the command contract: argv parsing, the risk check, errors and exit
  codes, the output shape, and the trace.
- [`forgejo/`](forgejo/README.md) owns the Forgejo REST client, the web page client for operations with no
  REST endpoint, the Actions log reader, and the host and repository resolution.
- [`auth/`](auth/README.md) owns identity: profiles, token lookup, `fgj auth`, and the audit log.
- [`hooks/`](hooks/README.md) owns the harness-neutral gate that adapters ask through `fgj hook`, and the
  one-time approvals for `fgj destroy` in pi.
- [`rules/`](rules/README.md) owns what fgj installs into harnesses: `fgj rules` and `fgj skill`.
- [`verbs/`](verbs/README.md) owns the manifest and one file per noun.
- [`text.d.ts`](text.d.ts) lets TypeScript accept the Markdown files that the build imports as text,
  such as the skill.

This directory does not own tests or test servers. In each harness, it owns only the
rules that fgj writes.
