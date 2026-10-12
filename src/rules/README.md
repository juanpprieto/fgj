# rules

What fgj installs into each harness: permission rules and the agent skill.

- [`generate.ts`](generate.ts) builds the rules from one list: a Codex `fgj.rules` file with load-time
  `match` examples from the manifest, and fgj's `Bash(fgj …)` entries for the Claude
  Code settings. It also builds the thin pi adapter, in a global form (`fgj-gate.ts`)
  and a role form per role (`fgj-roles/<role>.ts`). The adapter asks `fgj hook pi` for
  each decision; the rules themselves live in `src/hooks/`. The adapter replaces pi's
  bash tool, so it applies pi's `shellCommandPrefix` itself: the project's prefix only
  when pi trusts the project. It takes `shellPath` from the agent settings only.
- [`install.ts`](install.ts) holds the shared install path: harness directories, the diff, the `[y/N]`
  question, and the atomic write.
- [`skill.ts`](skill.ts) runs `fgj skill show`, `status`, and `install` with the skill text from
  the binary.
- [`command.ts`](command.ts) runs `fgj rules show`, `status`, and `install`. An install shows a diff
  and needs a human at a terminal, because an agent must not grant itself permissions.
  For Claude Code it shows and diffs only fgj's entries, since the settings file can
  hold secrets, and it keeps a backup of the file.

This directory does not decide what each verb does; the manifest owns the verbs and
their risk classes. It never touches rules that fgj did not write.
