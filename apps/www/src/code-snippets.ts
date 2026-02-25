export const HERO = `// .flue/workflows/issue-triage.ts
export default async function triage(flue, { issueNumber }) {
  const details = await flue.shell(\`gh issue view \${issueNumber} --json number,title,body,comments\`)
  const result = await flue.skill('triage', { args: { issue: details } })
  const comment = await flue.prompt(\`Summarize the triage for issue #\${issueNumber}: \${result}\`)
  await flue.shell(\`gh issue comment \${issueNumber} --body-file -\`, { stdin: comment })
}`;

export const ISSUE_TRIAGE = `// .flue/workflows/issue-triage.ts
export default async function triage(flue, { issueNumber, branch }) {
  const details = await flue.shell(\`gh issue view \${issueNumber} --json number,title,body,comments\`)
  const result = await flue.skill('triage/reproduce.md', {
    args: { issue: details },
    result: v.object({ reproducible: v.boolean(), verdict: v.picklist(['bug', 'intended-behavior', 'unclear']) }),
  })
  if (result.reproducible) {
    const fix = await flue.skill('triage/fix.md', { args: { issue: details } })
    if (fix.fixed) {
      await flue.shell(\`git add -A && git commit -m "\${fix.commitMessage}"\`)
      await flue.shell(\`git push -f origin \${branch}\`)
    }
  }
  const comment = await flue.skill('triage/comment.md', {
    args: { issue: details, result, branch },
    result: v.string(),
  })
  await flue.shell(\`gh issue comment \${issueNumber} --body-file -\`, { stdin: comment })
}`;

export const CODE_REVIEW = `// .flue/workflows/code-review.ts
export default async function review(flue, { prNumber }) {
  await flue.shell(\`gh pr checkout \${prNumber}\`)
  const details = await flue.shell(\`gh pr view \${prNumber} --json number,title,body,comments\`)
  const review = await flue.skill('review/analyze.md', {
    args: { details },
    result: v.object({
      comments: v.array(v.object({ path: v.string(), line: v.number(), body: v.string() })),
      body: v.string(),
    }),
  })
  await flue.shell(\`gh api repos/{owner}/{repo}/pulls/\${prNumber}/reviews --method POST --input -\`, {
    stdin: JSON.stringify({ event: 'COMMENT', body: review.body, comments: review.comments }),
  })
}`;

export const SECURITY_SCAN = `// .flue/workflows/security-scan.ts
export default async function securityScan(flue) {
  const checks = await flue.shell('ls .agents/skills/security/references/')
  const findings = []
  for (const check of checks) {
    const result = await flue.skill(\`security/references/\${check}\`, {
      result: v.array(v.object({
        severity: v.picklist(['critical', 'high', 'medium', 'low']),
        file: v.string(),
        line: v.number(),
        description: v.string(),
      })),
    })
    findings.push(...result)
  }
  if (findings.length > 0) {
    await flue.skill('security/fix.md', { args: { findings } })
    const report = await flue.prompt(\`Summarize these security findings:\\n\${JSON.stringify(findings)}\`)
    await flue.shell('gh api repos/{owner}/{repo}/security-advisories --method POST --input -', {
      stdin: JSON.stringify({ summary: 'Automated security scan findings', description: report }),
    })
  }
}`;

export const AI_ASSISTANT = `// .flue/workflows/assistant.ts
export default async function assistant(flue, { issueNumber, commentId, prompt }) {
  const details = await flue.shell(\`gh issue view \${issueNumber} --json number,title,body,comments\`)
  const reaction = await flue.shell(\`gh api repos/{owner}/{repo}/issues/comments/\${commentId}/reactions --method POST -f content=eyes\`)
  const runUrl = \`\${process.env.GITHUB_SERVER_URL}/\${process.env.GITHUB_REPOSITORY}/actions/runs/\${process.env.GITHUB_RUN_ID}\`
  const result = await flue.skill('assistant.md', {
    args: { issue: details, prompt },
    result: v.object({
      summary: v.string(),
      actions: v.array(v.string()),
    }),
  })
  await flue.shell(\`gh api repos/{owner}/{repo}/issues/comments/\${commentId}/reactions/\${reaction.id} --method DELETE\`)
  await flue.shell(\`gh issue comment \${issueNumber} --body-file -\`, {
    stdin: \`\${result.summary}\\n\\n\${result.actions.map(a => \`- \${a}\`).join('\\n')}\\n\\n[View run](\${runUrl})\`,
  })
}`;
