const fetch = require('node-fetch');

const LEETCODE_API_ENDPOINT = 'https://leetcode.com/graphql';

// Array of your friends' usernames, fetched from .env just like your Telegram bot!
const USERNAMES = process.env.LEETCODE_USERS 
    ? process.env.LEETCODE_USERS.split(',').map(u => u.trim())
    : [];

async function checkUserSolvedToday(username) {
    const query = `
    query recentAcSubmissions($username: String!, $limit: Int!) {
        recentAcSubmissionList(username: $username, limit: $limit) {
            title
            timestamp
        }
    }`;

    try {
        const response = await fetch(LEETCODE_API_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Referer': 'https://leetcode.com'
            },
            body: JSON.stringify({
                query: query,
                variables: { username: username, limit: 1 }
            })
        });

        const data = await response.json();
        
        if (data.errors) {
            console.error(`Error fetching for ${username}:`, data.errors[0].message);
            return null; // Null means error or unavailable
        }

        const submissions = data.data.recentAcSubmissionList;
        
        if (!submissions || submissions.length === 0) {
            return null; // Null means private profile or literally zero submissions ever
        }

        // Get the timestamp of the latest submission
        const latestSubmissionTimestamp = parseInt(submissions[0].timestamp) * 1000;
        const now = Date.now();
        
        // Check if the submission was within the last 24 hours (86400000 milliseconds)
        const ONE_DAY = 24 * 60 * 60 * 1000;
        if (now - latestSubmissionTimestamp < ONE_DAY) {
            return true; // Solved today
        }
        
        return false; // Not solved today
        
    } catch (error) {
        console.error(`Failed to fetch LeetCode data for ${username}:`, error);
        return null; // Assume unavailable on error
    }
}

async function generateDailyReport() {
    let completed = [];
    let pending = [];
    let unavailable = [];
    
    for (const username of USERNAMES) {
        const status = await checkUserSolvedToday(username);
        
        if (status === true) {
            completed.push(username);
        } else if (status === false) {
            pending.push(username);
        } else {
            unavailable.push(username);
        }
    }
    
    let report = `🚀 *LeetCode Daily Status* 🚀\n_Keep the streak alive!_ 💯\n\n`;
    
    report += `🏆 *Completed Today*\n`;
    if (completed.length > 0) {
        completed.forEach(u => report += `✅ ${u}\n`);
    } else {
        report += `_No completions yet._ 🥲\n`;
    }
    
    report += `\n😴 *Still Pending*\n`;
    if (pending.length > 0) {
        pending.forEach(u => report += `❌ ${u}\n`);
    } else {
        report += `_Everyone has completed it!_ 🔥\n`;
    }
    
    if (unavailable.length > 0) {
        report += `\n🔒 *Unverified / Hidden Profiles*\n`;
        unavailable.forEach(u => report += `🥷 ${u}\n`);
        report += `_(Recent submissions may be hidden)_\n`;
    }
    
    report += `\nLet's get those green dots! 🟩`;
    
    return report;
}

module.exports = { generateDailyReport, USERNAMES };
