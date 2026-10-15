<!-- What changes, and why? Link the issue it resolves ("Resolves #123"). -->

## Checklist

- [ ] `npm test` passes, and the feature's in-app self-test passes (numbers in the description)
- [ ] `node tools/check-private.js` is clean
- [ ] The security questions are answered: does anything new leave the PC, is anything new stored, can a web page reach the new code, does it download or run anything?
- [ ] README updated if a feature or a network connection changed (the privacy list)
- [ ] **A release?** The version is raised in `package.json` and `package-lock.json` **and** `CHANGELOG.md` has its `## [x.y.z]` section: merging releases it automatically. Not a release? Leave the version alone.

## What was not tested, and the risks

<!-- Be specific: what you could not run, and what could still go wrong. -->
