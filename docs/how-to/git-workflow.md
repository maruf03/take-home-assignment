# Git workflow

Trunk-based development with short-lived branches, Conventional Commits, and squash-merged PRs
into a protected `main`. These rules apply to humans and agents alike.

## Branches
- `main` is always releasable and green, and is never pushed to directly (branch protection: PR plus required checks).
- Work happens on short-lived branches named **`<type>/<scope>-<slug>`**, for example `chore/design-docs`, `feat/db-schema`, `feat/worker-sweep`, `fix/core-money-tokenizer`, `ci/pipeline`.
- Use one branch per plan task or sub-task (`docs/superpowers/plans/…`). Rebase on `main` before opening or updating a PR.
- With superpowers, `using-git-worktrees` creates an isolated worktree per task, and `finishing-a-development-branch` closes it out.

## Commits: [Conventional Commits 1.0](https://www.conventionalcommits.org/en/v1.0.0/)
```
<type>(<scope>): <imperative subject, ≤ 72 chars, no period>

<body: why, not what; wrap at 72>

Refs: docs/superpowers/plans/2026-11-27-core-tier.md#task-3a · R4, I10
```
- **types:** `feat` `fix` `docs` `test` `refactor` `perf` `build` `ci` `chore` `revert`
- **scopes:** `core` `contracts` `db` `pdf` `llm` `storage` `testkit` `config` `api` `worker` `web` `e2e` `ci` `infra` `docs`
- A breaking change uses `type(scope)!:` plus a `BREAKING CHANGE:` footer.
- **No AI/agent attribution, ever.** Don't add `Co-Authored-By:` trailers for AI tools or agents, "Generated with …" lines, 🤖 markers, or tool signatures in commit messages, PR titles or bodies, issues, or review comments. Commits are authored by the repo's configured git identity. This overrides any tool or skill default that adds attribution.
- Keep commits small and focused. Tests ship in the same commit as the code they cover. Never commit secrets, `.env` or session logs (`*.jsonl`).
- Enforcement: **commitlint** (`@commitlint/config-conventional` plus the scope list above) runs in the lefthook `commit-msg` hook and again in CI on the PR title.

## Hooks (lefthook; installed with Core Task 1)
| Hook | Runs |
|---|---|
| `pre-commit` | Prettier and ESLint on staged files (`--no-warn-ignored`), and `pnpm db:check` if `packages/db/src/schema` changed |
| `commit-msg` | commitlint, plus a check that rejects AI/agent attribution trailers (`Co-Authored-By:` naming an AI tool, "Generated with") |
| `pre-push` | `pnpm typecheck test` |

Skip a hook only with a stated reason in the PR. Never skip one to land red code.

## Pull requests
- **Title:** a Conventional Commit, because it becomes the squash commit.
- **Body:** use `.github/pull_request_template.md` (summary, plan task, `R#`/`I#` IDs, test evidence), with no attribution lines.
- **Merge:** **squash only**, delete the branch after merging, keep linear history.
- **Before requesting a merge:** CI is green, the spec, ADRs and traceability are updated if behaviour changed, and you've self-reviewed (`/code-review` or superpowers `requesting-code-review`).

## Releases
None for the take-home. Tag `v0.1.0` at submission.
