# Harness check (human UAT)

A pull request that adds or changes a verb needs a no-prompt run of that verb in Codex,
Claude Code, and pi, recorded on the pull request. The rule match tests prove that each
command matches its rule; this run proves that a real agent in a real harness gets no
prompt. Part 1 is done once per machine. Part 2 is done for each pull request. Part 3
removes the setup.

The examples use a sandbox repository `you/sandbox` on
`https://forgejo.example.com`, a bot account `fgj-bot`, and a profile `uat`. Use your
own host and names.

## Source checkout validation

For a source-only change, use the guarded setup in [CONTRIBUTING.md](../CONTRIBUTING.md#run-the-complete-check).
Use Bun 1.3.14 and one absolute, unchanged npm archive for all candidate tests.
Set `CI=1` and `FGJ_TEST_WORKERS=1` for serial server checks.
Choose an unused non-default port with absent fixture state.
Stop only the fixture you started.
Record the source commit, archive digest, checks and cleanup.
A source-only change needs no new verb harness proof.

## Isolated harness runs

Delivery lanes must not run `install:local`, `install:uat`, or install shared rules.
Run each harness command through
`bun run uat:shell --cwd DIR [--profile NAME] -- <command...>` on the clean commit
under test. The script refuses a work tree with changes. It builds `dist/fgj`,
puts `dist` first on the child PATH, and checks that the fgj the child resolves
names HEAD. Then it runs the command in `DIR`, an absolute test folder outside the
checkout and outside any other clone of fgj. `--profile` sets `FGJ_PROFILE` in the
child only. The script's own failures exit 125; a command it cannot find exits 127.

A harness can start its tool shells with another PATH, so the script cannot prove
which fgj they run. Make `fgj --version` the harness's first command, and record
that it names HEAD. The script changes no rules, so the run uses the installed
rules; record `fgj rules status` with the run.
Use test-owned repositories on a disposable Forgejo, never owner boards.

Keep the settings private for each run. Set `CODEX_HOME` for Codex and
`PI_CODING_AGENT_DIR` for pi to separate scratch directories. Use the generated
output from `fgj rules show codex` or `fgj rules show pi` in those directories.

On macOS, Claude Code needs the real `HOME`, `USER`, and `LOGNAME` to read its
login from the login keychain. Use a logged-in `CLAUDE_CONFIG_DIR`, such as
`$HOME/.fgj-uat/claude`. A human prepares that login and runs Claude.
An agent must not request a login. A scratch `CLAUDE_CONFIG_DIR` with `HOME` set to the
test folder returns `Not logged in`. Keep fgj isolated with `XDG_CONFIG_HOME`
and `XDG_STATE_HOME` in the test folder, not with a changed `HOME`.
Use `-p --permission-mode default --setting-sources user` with only the generated
`fgj rules show claude` settings. Check those settings before the run.
Do not copy service credentials into settings or evidence.

Do not use an approval bypass, dangerous permission mode, or blanket tool allow
rule. Keep the harness's service login available without copying it into evidence.
Bind only a disposable Forgejo profile in the child process. Never change the
parent lane's identity or shared credentials. Stop if harness access fails.

For board creation, give each harness its own empty test repository. Ask it to
run `fgj write board create Onboarding`, then
`fgj read board list --project <returned-number>`, then repeat creation.
Record the harness version, clean build version, approval policy, command
transcript, both write audit lines, saved columns, and independent inventory.
Expect one creation, then `changed:false`, and no approval request. The read
must agree with saved column names. Do not treat rule-match tests as a harness run.

The executable server matrix is in `test/server/board-write.test.ts`. It checks
all templates, configured server templates, reuse preservation, conflicts,
accepted-response loss, failed read-back, denied access, and dry-run. Name tests
cover emoji and CJK at 255/256 UTF-8 bytes. Oversized names refuse before any
request, even on repeat or dry-run. Passing controls create once and reuse the
same board. Names must use valid Unicode and satisfy both the 100-character
limit and the 255-byte limit. Run
`bun test test/server/board-write.test.ts` after provisioning. The configured
fixture starts and stops its own separate Forgejo. It does not restart the
standard test server or an owner's service.

## npm candidate validation

Keep the reviewed tarball unchanged across macOS arm64 and Linux arm64. Install
Bun 1.3.14 separately. The package has no npm runtime dependencies.
Installation, help and version work without Git.
Auth and network commands require Git on PATH. No source checkout is required.
Keep Git on PATH for the installed read proof. Network commands also need your
own Forgejo credentials. These system prerequisites are not npm dependencies.
Record `uname -sr`, architecture, `git --version`, `bun --version`,
`node --version`, `npm --version`, full commit, archive SHA-256 and inventory.
The tarball contains only `cli.js`, `package.json`, `README.md`, `LICENSE-MIT`
and `LICENSE-APACHE`. Review every file and the generated help, rules and skill.
Reject private hosts, paths, identities, credentials, unexpected files and maps.

Run `bun run package` on a clean checkout. Then set `FGJ_PACKAGE_TARBALL` to the
absolute archive path and run `bun test test/unit/package.test.ts test/unit/public.test.ts`.
Repeat on the other supported OS with the same bytes, or compare matching hashes
from clean builds of the same commit. Every npm, npx and Bun row must pass with
scripts enabled and disabled. The tests isolate homes, caches and prefixes. They
check help, version, callback replay, hostile startup files and preserved sentinels.
They never replace the shared fgj binary or install shared harness rules.

For manual installation, use the commands in the README's npm candidate section
from a fresh non-Git directory. Set a private HOME and private caches as well as
the private prefix. Check that help and version name the reviewed build. Show
rules with `fgj rules show codex`, `fgj rules show claude` and `fgj rules show pi`.
Do not install them into shared homes. Check `fgj skill show` without a checkout.

CI alone provisions the disposable Forgejo through `bun run check`. It then runs
`bun test ./test/server/package.test.ts` on the same archive. Check the installed
read result and the GET-only trace. An absent or red CI check is not local proof.
No registry publication is part of these checks.

## Part 1: set up once

### 1. Install fgj

In the fgj checkout, on a clean tree:

```sh
bun run install:local
fgj --version
```

The version must end in the commit that you test, for example `0.0.0+de84ba2`.

### 2. Create the bot account

1. Sign in to Forgejo as an admin.
2. Open **Site administration**, then the user accounts page.
3. Create the user `fgj-bot` with its own email and a strong password.
4. In a private browser window, sign in once as `fgj-bot`.

### 3. Give the bot access to the sandbox

1. As a repository admin, open `you/sandbox` → **Settings → Collaborators**.
2. Add `fgj-bot` with the **Write** permission.

### 4. Store the bot's tokens

Before you start, run `fgj auth status`, and find which profile, if any, has
`"default":true` for the host. A call that has no `FGJ_PROFILE` or `--as` uses the
default profile for its host. With no default, only `read`, `write`, and
`destroy` calls fail (exit 3); `help` and `auth status` still work.

Run this in your own terminal. Do not run it through an agent:

```sh
fgj auth --profile uat https://forgejo.example.com
```

1. fgj shows the token page and the exact permission for each token.
2. In the `fgj-bot` browser window, open that page and create the two tokens.
3. Paste the read token first, then the write token, when fgj asks. The input is
   hidden.
4. Do not paste a token anywhere else: not in a chat, a file, or a shell command.
5. When fgj asks `Make uat the default for https://forgejo.example.com? … [y/N]`, type `n`.
   The UAT binds `uat` with `FGJ_PROFILE`. A default would make every unbound agent on
   this host act as `fgj-bot`.

fgj checks the scopes of each token. It refuses a read token that can write. It asks
for each token up to 3 times in total, then stops and saves nothing. The result line
names the profile, the host, and the user.

### 5. Install the rules and the skill

Run these in your own terminal:

```sh
fgj rules install codex
fgj skill install codex
```

1. Read each diff.
2. Type `y` only when the diff changes what you expect.
3. Do the same two commands for `claude`, then for `pi`.

Then check all three harnesses:

```sh
fgj rules status
fgj skill status
fgj auth status
```

Each harness must show `current`. The `uat` profile must show `"read":"ok"` and
`"write":"ok"`.

### 6. Make a work directory

```sh
git clone git@forgejo.example.com:you/sandbox.git ~/uat/sandbox
```

Clone over SSH. For a private sandbox, an HTTPS clone asks for a password.

fgj finds the host and the repository from the `origin` of this clone.

### 7. Check the target issue

The UAT prompt uses issue 1 of the sandbox. In the clone, run:

```sh
FGJ_PROFILE=uat fgj read comment list 1
```

The result must have `"as":"uat"`. If fgj exits 4 (`not_found`), create an open issue
in the sandbox, and use its number in place of `1` in Part 2.

## Part 2: run the check for a pull request

Before the first harness, install the commit under test. In the fgj checkout, on a
clean tree, run this in your own terminal:

```sh
bun run install:uat
```

It installs the build and checks that its version names `HEAD`. Then it runs `fgj rules
install` and `fgj skill install` only for the harnesses that are not current. Read each
diff, and type `y` only when it changes what you expect. The last line shows the version
and each harness's state; every state must be `current`.

Then do these steps once for each harness.

### 1. Start a new session with the profile bound

Start the harness from the work directory, so it loads the new rules, the skill, and
the profile:

```sh
cd ~/uat/sandbox
FGJ_PROFILE=uat codex     # or: FGJ_PROFILE=uat claude, FGJ_PROFILE=uat pi
```

### 2. Give the agent the UAT prompt

Paste this prompt. Change `<harness>` to `codex`, `claude`, or `pi`:

```text
Use fgj for every Forgejo call. Run one command per step and show me each JSON result.
1. Run: fgj auth status
2. List the comments on issue 1.
3. Write the file uat-<harness>.md with one line: "UAT run from <harness> at <date and time now>."
   Then add it as a comment on issue 1.
4. Run the same add command again.
5. Run: fgj destroy comment delete 1 --dry-run
Then tell me the value of "as" and of "changed" in steps 3 and 4.
```

This prompt checks the comment verbs. Add one step for each verb that the pull request
adds or changes.

### 3. Watch for prompts

| Step | Expected |
|---|---|
| Start | Codex and Claude Code can ask to trust the folder on the first start. That dialog is not an fgj prompt. |
| 1–4 | The harness runs each `fgj` command with no approval prompt. |
| 3 | The harness can ask before it writes `uat-<harness>.md`. That prompt is for the file, not for fgj; approve it. |
| 5 | The harness asks before `fgj destroy`. Decline. Never choose an "always allow" option. |

Step 5 is safe: `--dry-run` writes nothing, so an approval only shows the plan. The
harness still asks, because the risk class is `destroy`.

Record any other prompt as a finding. On pi, another extension can add its own
prompts; a prompt on `fgj read` or `fgj write` from such an extension needs an
exemption in that extension.

### 4. Check the results

The agent must report:

- `"as":"uat"` on the results of steps 2–4. In step 1, `auth status` shows it as
  `"active":{"as":"uat",…}`. You decline step 5, so it has no result. If it runs, it
  changes nothing, whatever its result.
- Step 3: `"changed":true`, with a comment id and URL.
- Step 4: `"changed":false`, with the same id. A retry never posts twice.

Then check outside the agent:

1. Open issue 1 in the sandbox. The new comment is there once, by `fgj-bot`.
2. Show the audit lines for the harness. Change `codex` to the harness name:

   ```sh
   grep '"harness":"codex"' "${XDG_STATE_HOME:-$HOME/.local/state}/fgj/audit.jsonl" | tail -n 2
   ```

   Each write has one line with `"as":"uat"`, the user, the command, and `harness`.
   Check that the `ts` time is from this run. Codex and pi lines also have `session`.
   If the command shows nothing, run it without the `grep`, and record the missing
   `harness` field as a finding. If the file has no line from this run, record that
   too: a harness sandbox can block the write to the audit log.

### 5. Record the run on the pull request

Add one comment to the pull request for each harness, with:

- The harness and its version (`codex --version`, `claude --version`, `pi --version`).
- The fgj version (`fgj --version`).
- A screenshot or a transcript excerpt of steps 1–5 that shows where the harness asked.
- The two audit lines.
- Each finding, with its step.

## What to check if a step fails

| Symptom | Check |
|---|---|
| The harness asks for `fgj read` or `fgj write` | `fgj rules status`. Start a new session after an install. |
| `auth` error, exit 3 | `fgj auth status`: the token checks and the active identity. With no `FGJ_PROFILE`, the host needs a default. |
| `identity_mismatch`, exit 7 | The agent passed `--as` with a different profile than `FGJ_PROFILE`. |
| `not_found`, exit 4 | The bot is not a collaborator on the sandbox, or the issue does not exist. |
| Codex cannot reach the server | The Codex sandbox can block the network. Record it as a finding. |

To see what one call did, run it yourself with `FGJ_TRACE=1`. The trace shows the
target, the token source, and each HTTP call, with the tokens redacted.

## Part 3: remove the setup

Do this when you stop these checks for good.

1. In your own terminal, run `fgj auth remove uat`, then type `y`.
2. In the `fgj-bot` browser window, delete the two tokens on the token page.
3. Remove the `uat-*.md` files from the sandbox clone.
