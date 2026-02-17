const API_BASE = 'https://api.github.com';

interface GitHubRequestOptions {
	token: string;
	method?: string;
	body?: unknown;
}

async function githubFetch<T>(path: string, options: GitHubRequestOptions): Promise<T> {
	const res = await fetch(`${API_BASE}${path}`, {
		method: options.method ?? 'GET',
		headers: {
			Authorization: `token ${options.token}`,
			Accept: 'application/vnd.github.v3+json',
			'Content-Type': 'application/json',
		},
		...(options.body ? { body: JSON.stringify(options.body) } : {}),
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`GitHub API error (${res.status}) ${options.method ?? 'GET'} ${path}: ${text}`);
	}
	return res.json() as Promise<T>;
}

async function githubPaginate<T>(path: string, token: string): Promise<T[]> {
	const results: T[] = [];
	let url: string | null = `${API_BASE}${path}`;

	while (url) {
		const res = await fetch(url, {
			headers: {
				Authorization: `token ${token}`,
				Accept: 'application/vnd.github.v3+json',
			},
		});
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`GitHub API error (${res.status}) GET ${url}: ${text}`);
		}
		const data = (await res.json()) as T[];
		results.push(...data);

		const link = res.headers.get('Link');
		const next = link?.match(/<([^>]+)>;\s*rel="next"/);
		url = next?.[1] ?? null;
	}

	return results;
}

export interface IssueDetails {
	title: string;
	body: string;
	author: { login: string };
	labels: Array<{ name: string }>;
	createdAt: string;
	state: string;
	number: number;
	url: string;
	comments: Array<{
		author: { login: string };
		authorAssociation: string;
		body: string;
		createdAt: string;
	}>;
}

export interface RepoLabel {
	name: string;
	description: string | null;
}

export async function fetchIssue(
	token: string,
	repo: string,
	issueNumber: number,
): Promise<IssueDetails> {
	interface RawIssue {
		title: string;
		body: string | null;
		user: { login: string };
		labels: Array<{ name: string }>;
		created_at: string;
		state: string;
		number: number;
		html_url: string;
	}
	interface RawComment {
		user: { login: string };
		author_association: string;
		body: string;
		created_at: string;
	}

	const [issue, comments] = await Promise.all([
		githubFetch<RawIssue>(`/repos/${repo}/issues/${issueNumber}`, { token }),
		githubPaginate<RawComment>(`/repos/${repo}/issues/${issueNumber}/comments`, token),
	]);

	return {
		title: issue.title,
		body: issue.body ?? '',
		author: { login: issue.user.login },
		labels: issue.labels.map((l) => ({ name: l.name })),
		createdAt: issue.created_at,
		state: issue.state,
		number: issue.number,
		url: issue.html_url,
		comments: comments.map((c) => ({
			author: { login: c.user.login },
			authorAssociation: c.author_association,
			body: c.body,
			createdAt: c.created_at,
		})),
	};
}

export async function fetchRepoLabels(
	token: string,
	repo: string,
): Promise<{ priorityLabels: RepoLabel[]; packageLabels: RepoLabel[] }> {
	interface RawLabel {
		name: string;
		description: string | null;
	}

	const allLabels = await githubPaginate<RawLabel>(`/repos/${repo}/labels?per_page=100`, token);

	return {
		priorityLabels: allLabels
			.filter((l) => /^- P\d/.test(l.name))
			.map((l) => ({ name: l.name, description: l.description })),
		packageLabels: allLabels
			.filter((l) => l.name.startsWith('pkg:'))
			.map((l) => ({ name: l.name, description: l.description })),
	};
}

export async function postComment(
	token: string,
	repo: string,
	issueNumber: number,
	body: string,
): Promise<void> {
	await githubFetch(`/repos/${repo}/issues/${issueNumber}/comments`, {
		token,
		method: 'POST',
		body: { body },
	});
}

export async function addLabels(
	token: string,
	repo: string,
	issueNumber: number,
	labels: string[],
): Promise<void> {
	if (labels.length === 0) return;
	await githubFetch(`/repos/${repo}/issues/${issueNumber}/labels`, {
		token,
		method: 'POST',
		body: { labels },
	});
}

export async function removeLabel(
	token: string,
	repo: string,
	issueNumber: number,
	label: string,
): Promise<void> {
	const path = `/repos/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`;
	const res = await fetch(`${API_BASE}${path}`, {
		method: 'DELETE',
		headers: {
			Authorization: `token ${token}`,
			Accept: 'application/vnd.github.v3+json',
		},
	});
	if (!res.ok && res.status !== 404) {
		const text = await res.text();
		throw new Error(`GitHub API error (${res.status}) DELETE ${path}: ${text}`);
	}
}
