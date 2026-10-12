# .githooks

The git hooks of this repository. The `prepare` script in `package.json` points git at
this directory.

- [`pre-commit`](pre-commit) lints the staged files, then typechecks and checks the docs
  of the whole tree. A failure stops the commit. The typecheck and the docs check read
  the working tree, not the staged content, so a partly staged file can pass here. CI
  checks the pushed tree.

This directory does not run tests; `bun run check` and CI run them. Never bypass a hook
unless a maintainer approves an emergency exception.
