# skill

The generic fgj agent skill: [`fgj/`](fgj/README.md) holds its `SKILL.md`. It teaches an agent how to call fgj, read
its results, and handle its errors. It points to `fgj help` for the verbs, so it lists
none and cannot go stale. The build puts the text into the binary; `fgj skill install`
copies it into a harness.

This directory does not hold any team's workflow policy. A team skill, such as one
for an issue lifecycle, uses this one and adds its own rules.
