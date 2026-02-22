export const HERO = `// .flue/workflows/issue-triage.ts
export const proxies = { anthropic: anthropic(), github: github({ policy: 'allow-read' }) }
export const args = v.object({ issueNumber: v.number() })

export default async function triage(flue, { issueNumber }) {
  const issue = await flue.shell(\`gh issue view \${issueNumber} --json title,body,comments\`)
  const result = await flue.skill('triage', { args: { issue } })
  const comment = await flue.prompt(\`Summarize the triage for issue #\${issueNumber}: \${result}\`)
  await flue.shell(\`gh issue comment \${issueNumber} --body-file -\`, { stdin: comment })
}`;

export const ISSUE_TRIAGE = `export default async function triage(flue, { issueNumber, branch }) {
  const issue = await flue.shell(\`gh issue view \${issueNumber} --json title,body,author,labels,comments\`)
  const result = await flue.skill('triage/reproduce.md', {
    args: { issueNumber, issue },
    result: v.object({ reproducible: v.boolean(), verdict: v.picklist(['bug', 'intended-behavior', 'unclear']) }),
  })
  if (result.reproducible) {
    const fix = await flue.skill('triage/fix.md', { args: { issue } })
    if (fix.fixed) {
      await flue.shell(\`git add -A && git commit -m "\${fix.commitMessage}"\`)
      await flue.shell(\`git push -f origin \${branch}\`)
    }
  }
  const comment = await flue.skill('triage/comment.md', {
    args: { issue, result, branch },
    result: v.string(),
  })
  await postGitHubComment(issueNumber, comment)
  await addGitHubLabels(issueNumber, result.labels)
}`;

export const CODE_REVIEW = `export default async function review(flue, { prNumber }) {
  await flue.shell(\`gh pr checkout \${prNumber}\`)
  const diff = await flue.shell(\`gh pr diff \${prNumber}\`)
  const details = await flue.shell(\`gh pr view \${prNumber} --json body\`)
  const review = await flue.skill('review/analyze.md', {
    args: { diff, details },
    result: v.object({
      verdict: v.picklist(['approve', 'request-changes', 'comment']),
      comments: v.array(v.object({ path: v.string(), line: v.number(), body: v.string() })),
      summary: v.string(),
    }),
  })
  await flue.shell(\`gh api repos/{owner}/{repo}/pulls/\${prNumber}/reviews --method POST --input -\`, {
    stdin: JSON.stringify({ event: review.verdict.toUpperCase(), body: review.summary, comments: review.comments }),
  })
}`;

export const SECURITY_SCAN = `export default async function securityScan(flue) {
  const checks = await flue.shell('ls .agents/skills/security/references/')
  const findings = []
  for (const check of checks) {
    const result = await flue.skill(\`security/\${check}\`, {
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

export const AI_ASSISTANT = `export default async function assistant(flue, { issueNumber, commentId, prompt }) {
  const reaction = await flue.shell(\`gh api repos/{owner}/{repo}/issues/comments/\${commentId}/reactions --method POST -f content=eyes\`)
  const runUrl = \`\${process.env.GITHUB_SERVER_URL}/\${process.env.GITHUB_REPOSITORY}/actions/runs/\${process.env.GITHUB_RUN_ID}\`
  const result = await flue.skill('assistant.md', {
    args: { issueNumber, prompt },
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
