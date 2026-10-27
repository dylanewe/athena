# Issue tracker: GitHub

Issues and specs live in GitHub Issues for `dylanewe/athena`.
Use the `gh` CLI; the repository is inferred from `origin`.

## Operations

- Create: `gh issue create --title "..." --body "..."`
- Read full requirements, state, labels, and comments:
  `gh issue view <number> --json number,title,body,state,labels,comments`
- List: `gh issue list --state open`
- Comment: `gh issue comment <number> --body "..."`
- Label: `gh issue edit <number> --add-label "..."`
- Remove label: `gh issue edit <number> --remove-label "..."`
- Close: `gh issue close <number> --comment "..."`

Use heredocs for multiline bodies.

When a skill says "publish to the issue tracker", create an issue.
When it says "fetch the relevant ticket", read the full issue and comments.

## Dependencies

Check native GitHub issue dependencies and any `Blocked by: #<number>`
references in the issue body. An issue is unblocked only when every
blocker is closed.

Native blockers:
`gh api repos/dylanewe/athena/issues/<number>/dependencies/blocked_by`

## Pull requests as a triage surface

PRs as a request surface: no.
