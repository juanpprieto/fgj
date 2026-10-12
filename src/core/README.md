# core

The command contract that every verb shares.

- [`dispatch.ts`](dispatch.ts) runs one command. It checks the risk class before it parses the
  arguments, and it checks the arguments before any network call. It gives read verbs
  the read token and a web client that cannot POST, and write verbs the write token and
  a web client that can.
- [`args.ts`](args.ts) parses flags. [`output.ts`](output.ts) shapes results: fields, body limits, the output
  cap, and paged lists. [`errors.ts`](errors.ts) holds the error shape and the fixed exit codes.
- [`trace.ts`](trace.ts) writes the `FGJ_TRACE` JSON lines. [`redact.ts`](redact.ts) removes known tokens from
  every line fgj prints, the trace included.
- [`help.ts`](help.ts) builds `fgj help` from the manifest: the top level, one noun, or one verb.
- [`version.ts`](version.ts) holds the build version that `bun run build` stamps in.
- [`verb.ts`](verb.ts) defines the verb shape. The dispatcher finds verbs through the manifest.

This directory holds no Forgejo endpoint and no verb logic.
