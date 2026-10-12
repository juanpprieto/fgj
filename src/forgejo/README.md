# forgejo

The connection to one Forgejo server.

- [`client.ts`](client.ts) sends REST requests to `/api/v1`; `getText` reads a plain-text body, such
  as a job log. `ReadApi` can only send GET, and the
  dispatcher gives it the read token. `WriteApi` gets the write token; its `upload`
  sends one text file as a multipart POST, with the same secret check as a body. Both
  map HTTP errors to fgj errors.
- [`target.ts`](target.ts) picks the host and the repository from an issue URL, the git `origin`,
  the hosts of stored profiles, `FGJ_URL`, and `--repo`.
- [`web.ts`](web.ts) reads web pages for operations with no REST endpoint. `signIn` runs the
  sign-in form once for `fgj auth web` and finds the remember-me cookie. `WebReader`
  gets a short session from that cookie alone on each call, and sends GET only. It
  follows a redirect only inside the same `/{owner}/{repo}/`. `WebWriter` adds POST for
  write verbs (the board writes and the run re-run); the dispatcher gives read verbs a `WebReader`, which cannot POST.
- [`actions.ts`](actions.ts) reads Actions job logs, which are plain text: it removes timestamps,
  colors, and masked lines, and finds the error lines by their anchors, because the
  runner marks only the first step.
- [`board.ts`](board.ts) reads the project list and board pages. Each reader fails when the page
  lacks the parts it reads, so a Forgejo layout change gives an error. It never reads
  an issue page: a view of one marks the caller's notifications for it as read.

This directory does not store tokens or cookies, and it does not shape output. It has
no raw browser: fgj sends only the requests that these modules define.
