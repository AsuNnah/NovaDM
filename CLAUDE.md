# NovaDM: working rules for Claude

Every request (feature, idea, fix) follows the Groundwork framework (`groundwork/GROUNDWORK.md`, imported at the
end of this file; kept on the maintainer's machine, git-ignored like `docs/`). It stops at each gate that needs the
user: size and bundle, chosen approach, plan approval (GATE 1), and merging (GATE 2: the user's merge is the release).
The NovaDM rules below add to Groundwork; where they differ, these win. `docs/pipeline.md` is the older pipeline,
kept for reference.

- Start every request with stage 0 (Groundwork P0): say its size (hotfix / minor / major, mapped to Groundwork's
  trivial or small / small or standard / standard or large tier) and the version it will become.
- **Minor request:** before building, suggest 2–4 backlog features that fit with it (same area or
  same code), from `docs/plan.md` and the user's earlier unbuilt ideas, with
  their size, and let the user choose. Don't release one small feature alone unless the user says so.
- Report the result of every test and security stage with the numbers, including what failed and
  what was not run.
- Never publish personal data: run `node tools/check-private.js` before every push and release.
- **Ideas are held.** A new idea goes into `docs/plan.md` with a proposed version and size; build it only
  when the user says to. Update `docs/plan.md` when a feature ships or an idea is decided against.
- **Releasing is automatic:** the user merges a pull request that raises the version in `package.json`;
  `.github/workflows/auto-release.yml` then builds, verifies, tags and publishes. So never tag or publish by
  hand, and write the version's `CHANGELOG.md` section **before** the merge (the workflow stops without it).
- `docs/` is local only and git-ignored: never commit it or link to it from public files.

## Development machine

- The maintainer develops on Linux (Ubuntu 24.04). NovaDM is still a Windows app: the Windows installer
  is built by `.github/workflows/auto-release.yml` on `windows-latest`. Locally, `npm test` and the in-app self-tests
  (`NOVADM_SELFTEST=tools/selftest-<name>.js NOVADM_USERDATA=<empty dir> xvfb-run npx electron .`) are the checks.
- Tests that call Windows tools (`tar.exe`, `where.exe`, Defender, PowerShell) can fail on Linux for that reason
  alone; say so in the test report rather than changing them.
- Replies to the owner are in English. Coding follows the ponytail skill: the smallest complete change, one test for
  new logic, and a closing line on what was not checked.

## Groundwork framework
@groundwork/GROUNDWORK.md
