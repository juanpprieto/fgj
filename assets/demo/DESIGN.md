# Film baseline

This is the starting point for future `$impeccable` work on [index.html](index.html).
Treat this cut as the baseline. Keep exploration and earlier drafts outside the repository.
This brief applies only to the film, not the CLI or the rest of the documentation.

## Purpose and audience

Developers managing two or more agents, familiar with Git, issues, pull requests,
and kanban. Show that agents can use the same project record as humans: read the
scope AND latest comments, act within their role, and leave updates for the next
agent. The human scopes, prioritizes, monitors, reviews, and decides when to merge.
The film is a product introduction, with a transcript and pause/seek for closer reading.

## Product truth

One human, one illustrative agent organization, two distinct agents: implementation
and review. The opening keeps the scope open: “Two or more agents. One project,
issue, or PR.” The issue and PR are fictional. Moving To do to Ready is this team's
start rule; fgj supplies mechanisms, not scheduling or team policy. A completed
agent review leaves the PR open for the owner. Never imply automatic merge.

## Art direction

Mostly monochrome, monospace, terminal-first: classic CLI/neovim restraint, simple
web controls. Quiet TokyoNight-inspired accents identify actors, not status.
Use the existing white fgj wordmark unchanged, with clear space.

- Background: `#16171b`; surface: `#1a1b20`.
- Text: `#d5d6df`; muted text: `#a1a3b3`; borders: `#373943`.
- Agent A: blue `#8caee0`; agent B: violet `#b7a0dd`.
- Shared issue and PR: neutral, opaque surfaces.
- No traffic-light green/red/yellow, cartoon treatment, decorative cursor,
  floating agent cards, extra dashboards, or competing focal points.

## Story and composition

Logo and descriptor first. Introduce the agents through priority/status questions,
then the cost of acting as their messenger, then the shared record.
The human sets scope and priority, moves the issue to Ready; the card settles
before opening detail or introducing active agents.

Keep A left, shared issue/PR center, B right. A reads board, issue and comments,
posts progress, then posts the implementation handoff to the linked PR.
B reads the PR and latest comments, acknowledges, and later completes review.
Keep the PR and accumulated comments spatially stable through the sequence.
Finish by gently zooming into that same open PR for owner review and merge decision.
The full command roll is followed by `fgj help`.

## Motion and timing

The baseline lasts 62.2 seconds on a 1440 × 810 stage. The source is the single
inline timeline in [index.html](index.html); do not maintain a second engine copy.
Playback and arbitrary seeking must render the same state. Honor reduced motion.

Commands reveal over 380 ms. A directional arrow begins after 720 ms, swipes with
quintic easing for 520 ms, and the corresponding result starts its 420 ms reveal
on arrival. Highlight the active `fgj read` or `fgj write`. Direct arrows connect
agents to the record; never replace them with a bottom legend.

Reading holds add 1 second to the opening claim, 1.4 seconds to A's latest-comment
result, and 0.8 seconds to the issue-to-PR link. Holds occur after content has
settled; do not stretch arrow travel to buy reading time. Keep the active terminal
legible while its result is held. Preserve the owner closeup's reading time.
Credits scroll for six seconds. The separate inventory link supports exploration.

## Future edits and export

Start a future `$impeccable` pass by reading this brief and viewing the current HTML.
Refine the requested aspect while preserving the settled world. Check the opening,
To do → Ready transition, issue → PR relationship, read/write direction, comment
arrival, stable history, and owner closeup. Test pause, replay, seek, reduced motion,
and narrow-screen controls. The film itself remains a scaled 16:9 composition.

Export a fresh MP4 and poster whenever the source changes. See [README.md](README.md)
for the export recipe. Validate the encoded duration, dimensions, and a few decoded
frames. Keep no draft exports, capture frames, or review history in this directory.
