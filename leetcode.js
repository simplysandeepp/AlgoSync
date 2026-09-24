const fetch = require('node-fetch');

const LEETCODE_API_ENDPOINT = 'https://leetcode.com/graphql';
// LeetCode's public API caps recentAcSubmissionList at 20.
const RECENT_SUBMISSION_LIMIT = 20;
const REQUEST_TIMEOUT_MS = 15000;
const MAX_ATTEMPTS = 3;

const USERNAMES = [...new Set(
    (process.env.LEETCODE_USERS || '')
        .split(',')
        .map((u) => u.trim().replace(/^@/, ''))
        .filter(Boolean)
)];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function leetCodeGraphQL(query, variables = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const response = await fetch(LEETCODE_API_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Referer': 'https://leetcode.com/',
                'User-Agent': 'Mozilla/5.0 (compatible; leetcode-daily-reminder/1.0)'
            },
            body: JSON.stringify({ query, variables }),
            signal: controller.signal
        });
        if (!response.ok) {
            throw new Error(`LeetCode returned HTTP ${response.status}`);
        }
        const body = await response.json();
        if (body.errors?.length) {
            throw new Error(body.errors.map((e) => e.message).join('; '));
        }
        return body.data;
    } finally {
        clearTimeout(timer);
    }
}

async function withRetries(label, fn) {
    let lastError;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            console.error(`${label} failed (attempt ${attempt}/${MAX_ATTEMPTS}): ${error.message}`);
            if (attempt < MAX_ATTEMPTS) await sleep(2000 * attempt);
        }
    }
    throw lastError;
}

async function getActiveDailyChallenge() {
    const data = await withRetries('Daily challenge fetch', () => leetCodeGraphQL(`
        query activeDailyCodingChallengeQuestion {
            activeDailyCodingChallengeQuestion {
                date
                question { title titleSlug }
            }
        }
    `));
    const daily = data.activeDailyCodingChallengeQuestion;
    const startMs = Date.parse(`${daily?.date}T00:00:00Z`);
    if (!daily?.question?.titleSlug || Number.isNaN(startMs)) {
        throw new Error('LeetCode did not return an active daily challenge.');
    }
    // The daily challenge rolls over at 00:00 UTC (5:30 AM IST).
    return {
        title: daily.question.title,
        titleSlug: daily.question.titleSlug,
        startUnixSeconds: Math.floor(startMs / 1000)
    };
}

// Returns 'completed', 'pending', or 'unverified'.
async function checkUserSolvedToday(username, daily) {
    let submissions = [];
    try {
        // LeetCode intermittently returns an empty list for public profiles,
        // so an empty result is retried instead of being trusted.
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            const data = await withRetries(`Submissions fetch for ${username}`, () => leetCodeGraphQL(`
                query recentAcSubmissions($username: String!, $limit: Int!) {
                    recentAcSubmissionList(username: $username, limit: $limit) {
                        titleSlug
                        timestamp
                    }
                }`,
                { username, limit: RECENT_SUBMISSION_LIMIT }
            ));
            submissions = data.recentAcSubmissionList || [];
            if (submissions.length) break;
            if (attempt < MAX_ATTEMPTS) await sleep(2000 * attempt);
        }
    } catch (error) {
        console.error(`Could not check ${username}: ${error.message}`);
        return 'unverified';
    }

    const solvedDaily = submissions.some((submission) =>
        submission.titleSlug === daily.titleSlug
        && Number(submission.timestamp) >= daily.startUnixSeconds
    );
    if (solvedDaily) return 'completed';
    return submissions.length ? 'pending' : 'unverified';
}

async function generateDailyReport() {
    if (!USERNAMES.length) throw new Error('LEETCODE_USERS is not configured.');
    const daily = await getActiveDailyChallenge();

    const statuses = await Promise.all(
        USERNAMES.map(async (username) => [username, await checkUserSolvedToday(username, daily)])
    );
    const completed = statuses.filter(([, s]) => s === 'completed').map(([u]) => u);
    const pending = statuses.filter(([, s]) => s === 'pending').map(([u]) => u);
    const unverified = statuses.filter(([, s]) => s === 'unverified').map(([u]) => u);

    let report = `🚀 LeetCode Daily Status @all\n\n`;
    report += `Today's challenge: ${daily.title}\n\n`;

    report += `🏆 Completed Today\n`;
    if (completed.length > 0) {
        completed.forEach(u => report += `✅ ${u}\n`);
    } else {
        report += `_No completions yet._\n`;
    }

    report += `\n⏳ Still Pending\n`;
    if (pending.length > 0) {
        pending.forEach(u => report += `❌ ${u}\n`);
    } else {
        report += `_Everyone has completed it!_\n`;
    }

    if (unverified.length > 0) {
        report += `\n🔒 Couldn't verify (LeetCode didn't return submissions)\n`;
        unverified.forEach(u => report += `🥷 ${u}\n`);
    }

    report += `\n━━━━━━━━━━━━━━\n`;
    report += `💪 Keep the streak alive!\n`;
    report += `🟩 Let's get those green dots!`;

    return report;
}

module.exports = { generateDailyReport, USERNAMES };
