# Security reporting

Do not put a vulnerability, token, password, cookie or private log in a public issue.
Do not test a vulnerability against someone else's Forgejo or account.

## Private reports

Select **Report a vulnerability** through [GitHub's private report form](https://github.com/juanpprieto/fgj/security/advisories/new).
You need a GitHub account to submit a report.
If that option is absent, ask for a private reporting channel without including vulnerability details.
Confirm the channel before you send sensitive information.
Do not send vulnerability details in a public thread.

After the maintainer verifies that channel, send the affected version or commit,
OS and architecture, reproduction steps, expected behavior, impact and a proposed
fix if available. Use synthetic data. Remove credentials and personal paths.
Coordinate disclosure with the maintainer before publishing details.

## Supported scope

Tests cover Bun 1.3.14 and Forgejo 16.0.5. This prerelease makes no support-window
or response-time promise. Other Forgejo versions and Gitea are not verified.
See the [design](docs/design.md) for the risk model and its limits.
Harness approvals and profile bindings guard against accidents; they are not an
OS isolation boundary. Untrusted issue text remains untrusted.

For ordinary defects, follow [CONTRIBUTING.md](CONTRIBUTING.md).
