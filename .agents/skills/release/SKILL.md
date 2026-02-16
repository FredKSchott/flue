---
name: release
description: Release new versions of public npm packages in this monorepo. Use when the user asks to publish, release, or bump package versions.
---

# Release

Publish new versions of the public packages (`@flue/client`, `@flue/cli`). Private packages (`@flue/core`, `@flue/cloudflare`) are never published.

## Steps

1. **Commit.** If there are uncommitted changes, commit them with an appropriate message following the repo's conventions (e.g. `feat:`, `fix:`). If the working tree is clean, skip this step.

2. **Version.** Bump the `version` field in `packages/client/package.json` and/or `packages/cli/package.json` for whichever packages have changed since their last publish. Use patch bumps unless the user specifies otherwise. Then commit the version bump with the message format: `bump @flue/client@X.Y.Z @flue/cli@X.Y.Z` (include only the packages being bumped).

3. **Build.** Run `pnpm build` from the repo root. Fix any build errors before continuing.

4. **OTP.** Ask the user for their npm one-time password if one hasn't been provided yet.

5. **Publish.** For each bumped package, run `pnpm publish --otp <OTP> --access public --no-git-checks` from that package's directory. Publish `@flue/client` before `@flue/cli` since cli depends on client.

6. **Push.** Run `git push` to push the version bump commit(s) to the remote.
