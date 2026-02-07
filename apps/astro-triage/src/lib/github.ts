// ── GitHub API helpers ────────────────────────────────────────────

export interface GitHubIssue {
	number: number;
	title: string;
	body: string;
	labels: Array<{ name: string }>;
	state: string;
}

const HEADERS = (token: string) => ({
	Authorization: `Bearer ${token}`,
	Accept: 'application/vnd.github+json',
	'User-Agent': 'flue-astro-triage',
});

export async function fetchIssue(
	repo: string,
	issueNumber: number,
	token: string,
): Promise<GitHubIssue> {
	const res = await fetch(`https://api.github.com/repos/${repo}/issues/${issueNumber}`, {
		headers: HEADERS(token),
	});
	if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
	return res.json() as Promise<GitHubIssue>;
}

export async function postComment(
	repo: string,
	issueNumber: number,
	token: string,
	body: string,
): Promise<void> {
	const res = await fetch(`https://api.github.com/repos/${repo}/issues/${issueNumber}/comments`, {
		method: 'POST',
		headers: HEADERS(token),
		body: JSON.stringify({ body }),
	});
	if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
}
