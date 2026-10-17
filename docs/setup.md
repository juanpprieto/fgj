# Additional setup

The [README](../README.md#get-started) covers one agent account and Claude Code.
This guide owns additional harnesses, account bindings, web login and installation alternatives.
It does not own contributor checks or release approval.

## Codex and pi

For Codex, replace `claude` with `codex` in the two README install commands.
The token and first-read steps stay the same.

For pi, run these commands at a human terminal:

```sh
fgj rules install pi
fgj skill install pi
```

The pi adapter asks before destructive calls and human-only setup commands.
It blocks a destructive call when no human can approve it.

## More than one agent role

Create one Forgejo account and one fgj profile per role.
A profile needs a read token and a write token from the same account.

```sh
fgj auth --profile reviewer https://your-forgejo.example
```

A harness binding takes precedence over the host default.
For Claude Code and Codex, set `FGJ_PROFILE=reviewer` in the role's harness configuration.
For a pi role, install its binding:

```sh
fgj rules install pi --role reviewer=reviewer
```

List only that role file in the lane's `extensions:`.
The role file sets `FGJ_PROFILE` on that lane's bash calls.
To prevent a profile from acting through the default or `--as`, mark it bound only:

```sh
fgj auth bound reviewer on
```

This setting applies to every repository on that host.
Use `fgj auth bound reviewer off` to remove it.
Bindings prevent accidents. They do not isolate agents that share an operating-system account.

## Default account

`fgj auth` asks whether its saved profile is the default for the host.
Approve only an account that every unbound agent on that host can use.
Without a default or a harness binding, a call fails before it sends a request.
A human can change the default:

```sh
fgj auth default agent
```

`fgj auth status` shows the default and the active account without exposing tokens.

## Boards and Actions reruns

Only board commands and `run rerun` need the additional web login:

```sh
fgj auth web --profile agent
```

fgj asks for the account password and any TOTP code at a terminal.
It stores only the remember-me cookie, not the password.
The cookie lasts for the server's `LOGIN_REMEMBER_DAYS`, which defaults to 31.
A password change revokes it. Do not change the server's lifetime just to complete basic setup.

## Maintainer package testing

Native downloads are the normal installation path. There is no published npm package for this project.
The commands below apply only to a reviewed local `fgj-0.1.0.tgz` from `bun run package`.
They do not fetch an npm registry release.

Bun 1.3.14 must remain on PATH. The npm alternatives also need Node.js and npm.
Installation, help and version work without Git.
Auth and network commands require Git on PATH.
No source checkout is required.
The package has no npm runtime dependencies.

Use an isolated prefix to evaluate a reviewed candidate without replacing another installation:

```sh
npm install --global --ignore-scripts --prefix ./candidate ./fgj-0.1.0.tgz
./candidate/bin/fgj help
./candidate/bin/fgj version
npx --yes --ignore-scripts --package ./fgj-0.1.0.tgz fgj help
npx --yes --ignore-scripts --package ./fgj-0.1.0.tgz fgj version
```

For an isolated Bun installation:

```sh
BUN_INSTALL="$PWD/candidate-bun" BUN_INSTALL_CACHE_DIR="$PWD/candidate-cache" bun add --global --ignore-scripts "$PWD/fgj-0.1.0.tgz"
./candidate-bun/bin/fgj help
./candidate-bun/bin/fgj version
```

Keep a permanent installation available after you install harness rules.
Generated pi callbacks refer to that executable and preserve its startup flags.
Use npx for evaluation, not as a permanent callback location.

## Check setup

```sh
fgj auth status
fgj rules status
fgj skill status
```

For command-specific details, use `fgj help auth`, `fgj help rules` and `fgj help skill`.

## Common setup problems

| Result | Action |
| --- | --- |
| `fgj: command not found` | Check `command -v fgj` and your shell's PATH. Obey the [native installation steps](native.md). |
| The version is not the one you installed | Check `command -v fgj` for another installation earlier on PATH. Open a new terminal after a PATH change. |
| No default profile | At a human terminal, inspect `fgj auth status`. Approve a default only for an account that unbound agents can use. |
| `identity_mismatch` | Ask the person who configured the harness to check its profile binding. Do not override the binding in an agent command. |
| More than one Forgejo host | Use the full Forgejo issue URL, or work in the correct Forgejo repository checkout. |
| `auth` after a board call | Refresh the profile's web login at a human terminal with `fgj auth web --profile agent`. |
| `risk_mismatch` | Use the command in the error's `hint`. Do not broaden the harness permission rules. |

A first read can return an empty `items` list. That means the repository has no issues matching the request.
An authorization error is different. Confirm the account's repository access and token scopes before a retry.

## First reversible write

Use a test issue that you own or have permission to change.
Create `comment.txt` in a text editor with a short test message.
Replace the URL below with that issue's Forgejo URL:

```sh
fgj write comment add https://your-forgejo.example/owner/repository/issues/1 --body-file comment.txt
```

`changed:true` means fgj added the comment.
`changed:false` means your latest comment already has the same body, so fgj did not add a duplicate.
Check `as` before further writes. A write token can also delete through other tools, so harness rules are not server-side isolation.
