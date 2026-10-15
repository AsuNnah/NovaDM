# NovaDM: working rules for Claude

Every request (feature, idea, fix) follows the pipeline in `docs/pipeline.md` (kept on the maintainer's
PC; Part 1 is the short version), stage by stage, and stops at each gate that needs the user (size and
bundle, chosen approach, plan approval, merging).

- Start every request with stage 0: say its size (hotfix / minor / major) and the version it
  will become.
- **Minor request:** before building, suggest 2–4 backlog features that fit with it (same area or
  same code), from `docs/roadmap.md` and the user's earlier unbuilt ideas, with
  their size, and let the user choose. Don't release one small feature alone unless the user says so.
- Report the result of every test and security stage with the numbers, including what failed and
  what was not run.
- Never publish personal data: run `node tools/check-private.js` before every push and release.
- **Ideas are held.** A new idea goes into `docs/roadmap.md` with a proposed version and size; build it only
  when the user says to. Update the roadmap when a feature ships or an idea is decided against.
- **Releasing is automatic:** the user merges a pull request that raises the version in `package.json`;
  `.github/workflows/auto-release.yml` then builds, verifies, tags and publishes. So never tag or publish by
  hand, and write the version's `CHANGELOG.md` section **before** the merge (the workflow stops without it).
- `docs/` is local only and git-ignored: never commit it or link to it from public files.
