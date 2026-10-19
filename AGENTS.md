# Repository working agreement

## Contribution destination

[juanpprieto/fgj on GitHub](https://github.com/juanpprieto/fgj) is the canonical
source and contribution repository. Open issues at
[GitHub issues](https://github.com/juanpprieto/fgj/issues) and pull requests at
[GitHub pull requests](https://github.com/juanpprieto/fgj/pulls).
Use GitHub tooling, such as `gh --repo juanpprieto/fgj`, for this project's work.

Check the remote URL before fetching, pushing, or opening an issue or PR. Older
checkouts can still point to Forgejo; that does not make Forgejo the contribution
destination. Fetch GitHub's latest main and branch from it. Do not carry unrelated
Forgejo history into a GitHub PR. fgj targets Forgejo as a product; that is separate
from where this project's source and reviews live.

## Working on a change

- Read [the design](docs/design.md) and [contributor guide](CONTRIBUTING.md) first.
- Use a clean, dedicated checkout and a focused `feat/<issue-number>-<scope>` branch.
  Never implement directly on main. Preserve other contributors' local changes.
- Link the branch and PR from the GitHub issue. Reference it in the PR with `Closes #<issue-number>`.
- Keep the risk class first in every command and preserve the generic Forgejo mechanism.
  Teams own workflow policy. Bodies come from files, not shell arguments.
- Follow the contributor guide's validation and regression-test requirements.
  Keep normal commit hooks enabled. Record failures and infrastructure limits honestly.
- Never run `install:local` or `install:uat` in a delivery lane: they replace the shared executable.
- Before opening a PR, obtain independent read-only subagent review of the exact validated HEAD.
  Findings need severity, evidence, file reference, risk and the smallest safe fix.
  Resolve valid in-scope Medium or higher findings and publish the combined review on the PR.

## Documentation and film

Keep directory documentation and links current. Do not put tracking issue numbers
in README files or code comments. For film edits, read the
[settled design baseline](assets/demo/DESIGN.md) and
[source/export guide](assets/demo/README.md). Preserve only the current baseline,
not exploratory drafts. The interactive HTML is the source of truth for derived media.
