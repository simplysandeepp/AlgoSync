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
            return false;
        }

        const submissions = data.data.recentAcSubmissionList;
        
        if (!submissions || submissions.length === 0) {
            return false; // No submissions ever
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
        return false; // Assume not solved on error so they get reminded!
    }
}

async function generateDailyReport() {
    let report = `*📊 Daily LeetCode Report*\n\n`;
    
    let allSolved = true;
    
    for (const username of USERNAMES) {
        // You can change 'username' to 'Real Name' here if you want a mapping
        const hasSolved = await checkUserSolvedToday(username);
        
        if (hasSolved) {
            report += `✅ ${username}\n`;
        } else {
            report += `❌ ${username}\n`;
            allSolved = false;
        }
    }
    
    report += `\n`;
    
    if (allSolved) {
        report += `🔥 Excellent work team! Everyone solved a problem today!`;
    } else {
        report += `⚠️ Reminder for those with '❌': Please complete your daily LeetCode challenge!`;
    }
    
    return report;
}

module.exports = { generateDailyReport, USERNAMES };
