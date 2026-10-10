# NovaDM: working rules for Claude

Every request (feature, idea, fix) follows the pipeline in [docs/pipeline.md](docs/pipeline.md),
stage by stage, and stops at each gate that needs the user (size and bundle, chosen approach,
plan approval, publishing).

- Start every request with stage 0: say its size (hotfix / minor / major) and the version it
  will become.
- **Minor request:** before building, suggest 2–4 backlog features that fit with it (same area or
  same code), from `docs/feature-requests-research.md` §3 and the user's earlier unbuilt ideas, with
  their size, and let the user choose. Don't release one small feature alone unless the user says so.
- Report the result of every test and security stage with the numbers, including what failed and
  what was not run.
- Never publish personal data: run `node tools/check-private.js` before every push and release.
- Update the backlog table when a feature ships or a new idea is postponed.
