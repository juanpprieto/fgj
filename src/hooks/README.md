# hooks

The harness-neutral gate and the approvals that harness adapters use.

- [`gate.ts`](gate.ts) decides what a harness does with one shell command: pass, ask, or block.
  It judges only the commands that run fgj, from the command words that [`shell.ts`](shell.ts)
  finds, and a command word that shell expansion builds when `destroy` or `auth` is
  among its words; every other command passes, whatever its text. It holds the rules for fgj
  calls (destroy, auth, and calls that shell expansion can change), the destroy
  effect text from the manifest, the rule that a bound lane cannot change its account
  in a command that runs fgj, and the env that binds a lane to its profile.
- `shell.ts` reads shell text into simple commands and their words, as the shell reads
  quotes, so the gate can tell a command word from quoted text. It also finds the
  commands that a command runs for it (a shell's `-c` string, `env`'s command,
  `find -exec`), and it marks a `$(…)` or backtick in the word around it. It is not a
  full shell parser: it expands nothing.
- [`command.ts`](command.ts) runs `fgj hook <harness>`. An adapter sends one event on stdin, and fgj
  prints the decision. It sends no request and reads no token.
- [`approval.ts`](approval.ts) checks the one-time approvals for `fgj destroy` in pi: fresh, and used
  once. The pi adapter writes an approval after the human says yes.

Every adapter (the pi extension today, a Claude Code hook later) calls `fgj hook`, so
the rules live in one tested place and ship with the binary.

This directory guards against accidents, not a model that sets out to hide a call:
every lane runs as the same OS user that owns the token file. It does not own the
adapters' files or their install; `rules/` owns those.
