const fetch = require('node-fetch');

const LEETCODE_API_ENDPOINT = 'https://leetcode.com/graphql';
const RECENT_SUBMISSION_LIMIT = 20;

// Array of your friends' usernames, fetched from .env just like your Telegram bot!
const USERNAMES = process.env.LEETCODE_USERS
    ? process.env.LEETCODE_USERS.split(',').map(u => u.trim())
    : [];

async function leetCodeGraphQL(query, variables = {}) {
    const response = await fetch(LEETCODE_API_ENDPOINT, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Referer': 'https://leetcode.com'
        },
        body: JSON.stringify({ query, variables })
    });
    const body = await response.json();
    if (body.errors) {
        throw new Error(body.errors[0].message);
    }
    return body.data;
}

async function getActiveDailyChallenge() {
    const data = await leetCodeGraphQL(`
        query activeDailyCodingChallengeQuestion {
            activeDailyCodingChallengeQuestion {
                date
                question { title titleSlug }
            }
        }
    `);
    const daily = data.activeDailyCodingChallengeQuestion;
    if (!daily?.question?.titleSlug || !daily.date) {
        throw new Error('LeetCode did not return an active daily challenge.');
    }
    // daily.date is YYYY-MM-DD; treat it as the start of that UTC day.
    return {
        title: daily.question.title,
        titleSlug: daily.question.titleSlug,
        startUnixSeconds: Math.floor(Date.parse(`${daily.date}T00:00:00Z`) / 1000)
    };
}

async function checkUserSolvedToday(username, daily) {
    try {
        const data = await leetCodeGraphQL(`
            query recentAcSubmissions($username: String!, $limit: Int!) {
                recentAcSubmissionList(username: $username, limit: $limit) {
                    titleSlug
                    timestamp
                }
            }`,
            { username, limit: RECENT_SUBMISSION_LIMIT }
        );

        const submissions = data.recentAcSubmissionList;

        if (!submissions || submissions.length === 0) {
            return null; // Null means private profile or literally zero submissions ever
        }

        // Only count it as done if a submission for TODAY'S daily question
        // was accepted on or after the daily challenge's start.
        const solvedDaily = submissions.some((submission) =>
            submission.titleSlug === daily.titleSlug
            && Number(submission.timestamp) >= daily.startUnixSeconds
        );

        return solvedDaily;

    } catch (error) {
        console.error(`Failed to fetch LeetCode data for ${username}:`, error);
        return null; // Assume unavailable on error
    }
}

async function generateDailyReport() {
    const daily = await getActiveDailyChallenge();

    let completed = [];
    let pending = [];
    let unavailable = [];

    for (const username of USERNAMES) {
        const status = await checkUserSolvedToday(username, daily);

        if (status === true) {
            completed.push(username);
        } else if (status === false) {
            pending.push(username);
        } else {
            unavailable.push(username);
        }
    }

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
    
    if (unavailable.length > 0) {
        report += `\n🔒 Hidden Profile\n`;
        unavailable.forEach(u => report += `🥷 ${u}\n`);
    }
    
    report += `\n━━━━━━━━━━━━━━\n`;
    report += `💪 Keep the streak alive!\n`;
    report += `🟩 Let's get those green dots!`;
    
    return report;
}

module.exports = { generateDailyReport, USERNAMES };
