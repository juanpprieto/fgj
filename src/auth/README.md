# auth

Identity and tokens.

- [`store.ts`](store.ts) keeps named profiles and the default profile for each host in
  `~/.config/fgj/hosts.json` (directory 0700, file 0600, atomic writes). A profile is
  one Forgejo account on one host, with a read token and a write token, and, after
  `fgj auth web`, the remember-me cookie that the board verbs and `run rerun` use. It refuses the
  file when other users can read it.
- [`identity.ts`](identity.ts) picks the profile for a call: `FGJ_PROFILE`, a trailing `--as`, or the
  default profile that a human set for the host. With no default, it fails closed, even
  when the host has one profile.
- [`audit.ts`](audit.ts) appends each write, and each refused `--as`, to a 0600 audit log.
- [`command.ts`](command.ts) and [`verify.ts`](verify.ts) run `fgj auth`: the prompts, the scope checks, `web`,
  `status`, `default`, and `remove`.

This directory does not send verb requests, and it never prints or logs a token, a
password, or a cookie.
