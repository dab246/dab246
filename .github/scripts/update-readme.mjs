// Regenerates the project sections of README.md from live GitHub and pub.dev data.
// Each section lives between <!-- NAME:START --> and <!-- NAME:END --> markers.
// Usage: GITHUB_TOKEN=... node .github/scripts/update-readme.mjs

import { readFile, writeFile } from 'node:fs/promises';

const README = 'README.md';
const CONFIG = '.github/readme-config.json';
const API = 'https://api.github.com';
const SEARCH_DELAY_MS = 2100; // search API allows 30 requests/minute
const SEARCH_CAP = 1000; // search API returns at most 1000 results per query
const RETRY_STATUSES = new Set([202, 403, 429]); // 202: stats still computing; 403/429: rate limited
const MAX_ATTEMPTS = 5;

const cfg = JSON.parse(await readFile(CONFIG, 'utf8'));
const { user, org } = cfg;
const token = process.env.GITHUB_TOKEN;
if (!token) throw new Error('GITHUB_TOKEN is required');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();

// ---------- API clients ----------

function githubFetch(path) {
  return fetch(path.startsWith('http') ? path : API + path, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
}

const isRetryable = (res, attempt) => RETRY_STATUSES.has(res.status) && attempt < MAX_ATTEMPTS;
const retryDelayMs = (res, attempt) => (Number(res.headers.get('retry-after')) || 15 * attempt) * 1000;

async function readJson(res, path, allow404) {
  if (res.status === 404 && allow404) return null;
  if (!res.ok) throw new Error(`GitHub ${res.status} on ${path}: ${await res.text()}`);
  return res.json();
}

async function gh(path, { allow404 = false } = {}) {
  for (let attempt = 1; ; attempt++) {
    const res = await githubFetch(path);
    if (!isRetryable(res, attempt)) return readJson(res, path, allow404);
    await sleep(retryDelayMs(res, attempt));
  }
}

let lastSearch = 0;
async function search(q, page = 1, perPage = 100) {
  const wait = lastSearch + SEARCH_DELAY_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastSearch = Date.now();
  const params = new URLSearchParams({ q, per_page: String(perPage), page: String(page) });
  return gh(`/search/issues?${params}`);
}

async function pub(path) {
  const res = await fetch(`https://pub.dev/api${path}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`pub.dev ${res.status} on ${path}`);
  return res.json();
}

// ---------- data collection ----------

const repoName = (url) => url.replace(`${API}/repos/`, '');

// Adds one page of search hits to `prs` (repo -> Map(url -> pr)) and counts hits per repo in `seen`.
function addSearchHits(items, prs, seen) {
  for (const it of items) {
    const repo = repoName(it.repository_url);
    const repoPrs = prs.get(repo) ?? new Map();
    repoPrs.set(it.html_url, { title: it.title, url: it.html_url, mergedAt: it.closed_at });
    prs.set(repo, repoPrs);
    seen.set(repo, (seen.get(repo) ?? 0) + 1);
  }
}

// Runs one search query through all its pages and returns its total and per-repo hit counts.
async function searchAllPages(q, prs) {
  const seen = new Map();
  let total = 0;
  for (let page = 1; ; page++) {
    const res = await search(q, page);
    total = res.total_count;
    addSearchHits(res.items, prs, seen);
    const lastPage = res.items.length < 100 || page * 100 >= Math.min(total, SEARCH_CAP);
    if (lastPage) return { total, seen };
  }
}

// Collects every merged PR outside the user's own account. A single search stops at
// 1000 results, so the largest repos found are excluded and the search is repeated.
async function mergedPrsByRepo() {
  const base = `author:${user} type:pr is:merged -user:${user}`;
  const prs = new Map();
  const excluded = [];
  let total = null;
  for (let round = 0; round < 10; round++) {
    const q = [base, ...excluded.map((r) => `-repo:${r}`)].join(' ');
    const result = await searchAllPages(q, prs);
    total ??= result.total;
    if (result.total <= SEARCH_CAP) break;
    const biggest = [...result.seen].sort((a, b) => b[1] - a[1]).slice(0, 3);
    excluded.push(...biggest.map(([repo]) => repo));
  }
  return { total, prs };
}

async function mergedPrCount(repo) {
  const res = await search(`repo:${repo} author:${user} type:pr is:merged`, 1, 1);
  return res.total_count;
}

// Returns the user's commit count and contributor rank (1-based) in a repo.
async function contributorStats(repo) {
  for (let page = 1; page <= 5; page++) {
    const list = (await gh(`/repos/${repo}/contributors?per_page=100&page=${page}`, { allow404: true })) ?? [];
    const i = list.findIndex((c) => sameName(c.login ?? '', user));
    if (i >= 0) return { rank: (page - 1) * 100 + i + 1, commits: list[i].contributions };
    if (list.length < 100) break;
  }
  return { rank: null, commits: 0 };
}

async function pubspecName(repo) {
  const file = await gh(`/repos/${repo}/contents/pubspec.yaml`, { allow404: true });
  if (!file?.content) return null;
  const pubspec = Buffer.from(file.content, 'base64').toString('utf8');
  return /^name:[ \t]*([a-z0-9_]+)/m.exec(pubspec)?.[1] ?? null;
}

async function pubPackage(repo) {
  const name = await pubspecName(repo);
  const pkg = name ? await pub(`/packages/${name}`) : null;
  if (!pkg) return null;
  const score = (await pub(`/packages/${name}/score`)) ?? {};
  return {
    name,
    version: pkg.latest?.version,
    likes: score.likeCount ?? 0,
    downloads: score.downloadCount30Days ?? 0,
  };
}

// PRs to other people's personal forks are not upstream work; popular forks still count.
function isListedContribution(info, isOrg) {
  if (info.private) return false;
  if (isOrg) return !info.archived;
  return !info.fork || info.stargazers_count >= cfg.upstream.minForkStars;
}

async function contributedRepos(prs) {
  const out = [];
  for (const repo of prs.keys()) {
    const info = await gh(`/repos/${repo}`, { allow404: true });
    if (!info) continue;
    const isOrg = sameName(info.owner.login, org);
    if (isListedContribution(info, isOrg)) out.push({ repo, info, isOrg });
  }
  return out;
}

const byStarsThen = (key) => (a, b) => b.info.stargazers_count - a.info.stargazers_count || b[key] - a[key];

async function orgProjects(contributed) {
  const out = [];
  for (const c of contributed.filter((x) => x.isOrg)) {
    const prs = await mergedPrCount(c.repo);
    if (prs < cfg.org_projects.minMergedPrs) continue;
    // A fork's contributor list mixes in upstream history, so its rank says nothing about this work.
    const stats = c.info.fork ? { rank: null, commits: 0 } : await contributorStats(c.repo);
    out.push({ ...c, prs, ...stats });
  }
  return out.sort(byStarsThen('commits'));
}

function upstreamProjects(contributed, prs) {
  return contributed
    .filter((c) => !c.isOrg)
    .map((c) => {
      const all = [...(prs.get(c.repo)?.values() ?? [])].sort((a, b) => b.mergedAt.localeCompare(a.mergedAt));
      return { ...c, prs: all.length, recent: all.slice(0, cfg.upstream.prsPerRepo) };
    })
    .filter((c) => c.prs >= cfg.upstream.minMergedPrs)
    .sort(byStarsThen('prs'))
    .slice(0, cfg.upstream.limit);
}

async function ownRepos() {
  const repos = [];
  for (let page = 1; ; page++) {
    const list = await gh(`/users/${user}/repos?type=owner&per_page=100&page=${page}`);
    repos.push(...list);
    if (list.length < 100) return repos;
  }
}

function isListedPersonal(info, exclude) {
  const hidden = [info.fork, info.archived, info.private, exclude.has(info.name.toLowerCase())];
  if (hidden.some(Boolean)) return false;
  return Boolean(info.description || override(info.full_name).description);
}

async function personalProjects() {
  const exclude = new Set(cfg.personal.exclude.map((n) => n.toLowerCase()));
  const packages = [];
  const apps = [];
  for (const info of await ownRepos()) {
    if (!isListedPersonal(info, exclude)) continue;
    const { commits } = await contributorStats(info.full_name);
    const pkg = info.language === 'Dart' ? await pubPackage(info.full_name) : null;
    (pkg ? packages : apps).push({ info, commits, pkg });
  }
  return { packages: packages.sort(byStarsThen('commits')), apps: apps.sort(byStarsThen('commits')) };
}

// ---------- formatting ----------

const compact = (n) => (n < 1000 ? String(n) : `${Math.floor(n / 100) / 10}k`);
const plus = (n) => (n >= 1000 ? `${compact(n)}+` : String(n));
const plural = (n, word) => `${plus(n)} ${word}${n === 1 ? '' : 's'}`;
const escapeMd = (s) => s.replace(/[\\*_[\]<>|]/g, (c) => `\\${c}`);
const truncate = (s, max) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
const shieldsText = (s) => encodeURIComponent(s).replace(/-/g, '--');
const stars = (info) => `⭐&nbsp;${compact(info.stargazers_count)}`;

function badge({ label, message, color, logo }) {
  const logoParams = logo ? `&logo=${logo}&logoColor=white` : '';
  return `https://img.shields.io/badge/${shieldsText(label)}-${shieldsText(message)}-${color}?style=for-the-badge${logoParams}`;
}

// "fix(scope): [Improve] some  title" -> "Some title", cut without breaking a code span.
function prTitle(raw) {
  let t = raw.replace(/\s+/g, ' ').trim();
  t = t.replace(/^[a-z]{2,10}(?:\([^)]{0,40}\))?!?: /i, '').replace(/^\[[^\]]{0,30}\] /, '');
  t = truncate(t, 70);
  if ((t.match(/`/g) ?? []).length % 2) t = t.replace(/`/g, '');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

const override = (repo) => cfg.overrides[repo] ?? {};
const displayName = (repo) => override(repo).name ?? repo.split('/')[1];

function title(repo) {
  return `${override(repo).emoji ?? '🔹'} [**${displayName(repo)}**](https://github.com/${repo})`;
}

function describe(info) {
  const text = override(info.full_name).description ?? info.description ?? '';
  return escapeMd(truncate(text.trim(), 110));
}

function table(headers, rows) {
  const align = headers.map((h) => (h === 'Stars' ? ':---:' : ':---'));
  return [`| ${headers.join(' | ')} |`, `| ${align.join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

function rankLabel(rank) {
  if (!rank || rank > 10) return null;
  if (rank <= 3) return `**#${rank} contributor**`;
  return `Top ${rank <= 5 ? 5 : 10} contributor`;
}

function contributionCell(p) {
  const prsUrl = `https://github.com/${p.info.full_name}/pulls?q=is%3Apr+is%3Amerged+author%3A${user}`;
  const parts = [rankLabel(p.rank), p.commits ? plural(p.commits, 'commit') : null];
  parts.push(`[${plural(p.prs, 'merged PR')}](${prsUrl})`);
  return parts.filter(Boolean).join(' · ');
}

// ---------- sections ----------

function orgSection(projects) {
  const rows = projects.map((p) => [title(p.repo), describe(p.info), stars(p.info), contributionCell(p)]);
  return table(['Project', 'Description', 'Stars', 'My contribution'], rows);
}

function upstreamSection(projects) {
  const rows = projects.map((p) => {
    const archived = p.info.archived ? ' <sub>archived</sub>' : '';
    const links = p.recent.map((pr) => `[${escapeMd(prTitle(pr.title))}](${pr.url})`).join(' · ');
    return [`${title(p.repo)}${archived}`, stars(p.info), links];
  });
  return table(['Project', 'Stars', 'Merged contributions'], rows);
}

function pubStats(pkg) {
  const stats = [`[v${pkg.version}](https://pub.dev/packages/${pkg.name})`, `👍 ${compact(pkg.likes)}`];
  if (pkg.downloads) stats.push(`⬇️ ${compact(pkg.downloads)}/mo`);
  return stats.join(' · ');
}

function packagesSection(projects) {
  const rows = projects.map((p) => [title(p.info.full_name), describe(p.info), stars(p.info), pubStats(p.pkg)]);
  return table(['Package', 'Description', 'Stars', 'pub.dev'], rows);
}

function appsSection(projects) {
  const rows = projects.map((p) => {
    const live = p.info.homepage ? ` · [live](${p.info.homepage})` : '';
    const stack = override(p.info.full_name).stack ?? p.info.language ?? '—';
    return [`${title(p.info.full_name)}${live}`, describe(p.info), stars(p.info), stack];
  });
  return table(['Project', 'Description', 'Stars', 'Stack'], rows);
}

function highlightBadges(top, totalPrs) {
  const name = displayName(cfg.highlightRepo);
  const prsUrl = `https://github.com/search?q=author%3A${user}+is%3Apr+is%3Amerged+-user%3A${user}&type=pullrequests`;
  const out = [];
  if (top?.rank) {
    const rankBadge = badge({ label: name, message: `#${top.rank} contributor`, color: '0F766E', logo: 'github' });
    out.push(`<a href="https://github.com/${cfg.highlightRepo}/graphs/contributors"><img src="${rankBadge}" alt="${name} #${top.rank} contributor" /></a>`);
  }
  if (top?.commits) {
    const commitsBadge = badge({ label: `${name} commits`, message: plus(top.commits), color: '1F6FEB', logo: 'git' });
    out.push(`<img src="${commitsBadge}" alt="Commits" />`);
  }
  const prsBadge = badge({ label: 'Merged PRs', message: plus(totalPrs), color: '8957E5', logo: 'githubactions' });
  out.push(`<a href="${prsUrl}"><img src="${prsBadge}" alt="Merged PRs" /></a>`);
  return out.join(' ');
}

function aboutLine(top) {
  const link = `**[${displayName(cfg.highlightRepo)}](https://github.com/${cfg.highlightRepo})**`;
  const rank = (top?.rank ?? Infinity) <= 3 ? `**#${top.rank} contributor** to ${link}` : `Core contributor to ${link}`;
  const commits = top?.commits ? ` (${plus(top.commits)} commits)` : '';
  return `${rank}${commits}, an open-source, multi-platform email client on the JMAP protocol.`;
}

function replaceSection(md, name, body) {
  const start = `<!-- ${name}:START -->`;
  const end = `<!-- ${name}:END -->`;
  const i = md.indexOf(start);
  const j = md.indexOf(end);
  if (i < 0 || j < i) throw new Error(`Missing ${start} / ${end} markers in ${README}`);
  // Markers on one line (e.g. inside a list item) are filled inline to keep the list intact.
  const sep = md.slice(i, j).includes('\n') ? '\n' : '';
  return `${md.slice(0, i + start.length)}${sep}${body}${sep}${md.slice(j)}`;
}

// ---------- main ----------

async function main() {
  const { total: totalPrs, prs } = await mergedPrsByRepo();
  const contributed = await contributedRepos(prs);
  const orgAll = await orgProjects(contributed);
  const upstream = upstreamProjects(contributed, prs);
  const { packages, apps } = await personalProjects();
  const highlight = orgAll.find((p) => sameName(p.repo, cfg.highlightRepo));

  const sections = {
    ABOUT: aboutLine(highlight),
    HIGHLIGHTS: highlightBadges(highlight, totalPrs),
    ORG_PROJECTS: orgSection(orgAll.slice(0, cfg.org_projects.limit)),
    UPSTREAM: upstreamSection(upstream),
    PACKAGES: packagesSection(packages.slice(0, cfg.personal.packagesLimit)),
    APPS: appsSection(apps.slice(0, cfg.personal.appsLimit)),
  };

  const before = await readFile(README, 'utf8');
  const after = Object.entries(sections).reduce((md, [name, body]) => replaceSection(md, name, body), before);
  if (after === before) {
    console.log('README is up to date');
    return;
  }
  await writeFile(README, after);
  console.log(
    `README updated: ${sections.ORG_PROJECTS.split('\n').length - 2} ${org} projects, ${upstream.length} upstream, ` +
      `${packages.length} packages, ${apps.length} apps, ${totalPrs} merged PRs`,
  );
}

await main();
