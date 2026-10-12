# Security reporting

Do not put a vulnerability, token, password, cookie or private log in a public issue.
Do not test a vulnerability against someone else's Forgejo or account.

## Private reports

Open the repository's **Security** tab and select **Report a vulnerability** if the option is available.
If that option is absent, ask the maintainer who supplied the checkout for a private channel.
Confirm the channel before you send sensitive information.
A link or a source checkout does not prove that a reporting channel is active.
Do not send vulnerability details in a public thread.

After the maintainer verifies that channel, send the affected version or commit,
OS and architecture, reproduction steps, expected behavior, impact and a proposed
fix if available. Use synthetic data. Remove credentials and personal paths.
Coordinate disclosure with the maintainer before publishing details.

## Supported scope

Tests cover Bun 1.3.14 and Forgejo 16.0.5. This candidate makes no support-window
or response-time promise. Other Forgejo versions and Gitea are not verified.
See the [design](docs/design.md) for the risk model and its limits.
Harness approvals and profile bindings guard against accidents; they are not an
OS isolation boundary. Untrusted issue text remains untrusted.

For ordinary defects, follow [CONTRIBUTING.md](CONTRIBUTING.md).
