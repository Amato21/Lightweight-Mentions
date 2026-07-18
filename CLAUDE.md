# Working agreements for this repo

## Git & PRs

- Always `git fetch origin main` before branching off — avoids working from a stale local ref.
- One PR per fix/feature, with a description that covers: root cause, fix, verification.
- After opening a PR: subscribe to its activity, and if a check has to wait on CI or review, schedule a check-in (~1h) rather than polling.
- Once merged: unsubscribe, `git fetch origin main` and reset the working branch before starting the next change.
- After resetting the working branch to `origin/main`, immediately re-sign its tip: PR merges made through the GitHub API produce a merge commit committed by `GitHub <noreply@github.com>`, which the local stop hook flags as unverified. Fix it right away with `git config user.email noreply@anthropic.com && git config user.name Claude && git commit --amend --no-edit --reset-author`, rather than waiting for the hook to complain. This only rewrites the local/pushed feature branch tip, never `main`.
- Resolve review threads once addressed.

## Testing discipline (the most important part)

- Write a regression test for every fix.
- Prove the test actually catches the regression: temporarily revert the fix, confirm the test fails, then restore the fix and confirm it passes. Never assume a test is valid without this proof.
- Before saying "done": full test suite, `tsc -noEmit`, lint, and build must all be clean.
- Verify empirically (a quick script, a direct run) rather than reading the code and assuming it works — especially for any cross-cutting claim.

## This repo specifically

- `main.js` is committed (not gitignored) so the plugin works straight from a clone/download, without requiring `npm install && npm run build` first. Keep it in sync with `main.ts` on every change — rebuild before committing.
- Ideas that get set aside during discussion should be tracked as GitHub issues, not just dropped.

## Communication

- Replies in French, direct, no filler.
- Exploratory questions ("what do you think?") get a short answer (2-3 sentences) with a recommendation and the main tradeoff — no wall of text, and no code until it's confirmed.
- Be upfront about limitations; correct course myself if something was oversold.
- Sparing with GitHub comments — only post when genuinely necessary.
