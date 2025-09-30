import { NextRequest, NextResponse } from 'next/server';
import { put, head } from '@vercel/blob';
import TurndownService from 'turndown';

const turndown = new TurndownService();

// Helper to avoid rate limiting (Resend allows 2 calls per second)
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface Audience {
  id: string;
  name: string;
  created_at: string;
}

interface Broadcast {
  id: string;
  audience_id: string;
  name?: string;
  subject?: string;
  from?: string;
  created_at: string;
  sent_at: string | null;
}

interface Email {
  id: string;
  from: string;
  subject: string;
  html?: string;
  created_at: string;
}

export async function GET(request: NextRequest) {
  // Verify this is a legitimate cron request
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const apiKey = process.env.RESEND_API_KEY;
  const audienceId = process.env.RESEND_AUDIENCE_ID;

  if (!apiKey || !audienceId) {
    return NextResponse.json(
      { error: 'Missing RESEND_API_KEY or RESEND_AUDIENCE_ID' },
      { status: 500 }
    );
  }

  try {
    // 1. Fetch and store audiences
    const audiences = await fetchAudiences(apiKey);
    await put('rss_audiences', JSON.stringify(audiences), { access: 'public', addRandomSuffix: false, allowOverwrite: true });
    for (const audience of audiences) {
      await put(`rss_audience_${audience.id}`, JSON.stringify(audience), { access: 'public', addRandomSuffix: false, allowOverwrite: true });
    }

    // 2. Fetch and store broadcasts
    const broadcasts = await fetchBroadcasts(apiKey, audienceId);
    await put('rss_broadcasts', JSON.stringify(broadcasts), { access: 'public', addRandomSuffix: false, allowOverwrite: true });
    for (const broadcast of broadcasts) {
      await put(`rss_broadcast_${broadcast.id}`, JSON.stringify(broadcast), { access: 'public', addRandomSuffix: false, allowOverwrite: true });
    }

    // 3. Fetch and store emails incrementally
    const { newEmails, allEmails } = await fetchEmailsIncrementally(apiKey);

    // Store updated email list
    await put('rss_emails', JSON.stringify(allEmails), { access: 'public', addRandomSuffix: false, allowOverwrite: true });

    // Store individual new emails
    for (const email of newEmails) {
      await put(`rss_email_${email.id}`, JSON.stringify(email), { access: 'public', addRandomSuffix: false, allowOverwrite: true });
    }

    // Store last email ID for next run
    if (allEmails.length > 0) {
      await put('rss_last_email_id', allEmails[0].id, { access: 'public', addRandomSuffix: false, allowOverwrite: true });
    }

    // 4. Match emails to broadcasts and store with markdown (only new ones)
    await matchAndStore(broadcasts, newEmails, apiKey);

    return NextResponse.json({
      success: true,
      audiences: audiences.length,
      broadcasts: broadcasts.length,
      newEmails: newEmails.length,
      totalEmails: allEmails.length,
    });
  } catch (error) {
    console.error('Cron job error:', error);
    return NextResponse.json(
      { error: 'Failed to sync data', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

async function fetchAudiences(apiKey: string): Promise<Audience[]> {
  const response = await fetch('https://api.resend.com/audiences?limit=100', {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!response.ok) throw new Error(`Failed to fetch audiences: ${response.status}`);

  const data = await response.json();
  await sleep(500); // Rate limit: 2 calls/sec
  return data.data || [];
}

async function fetchBroadcasts(apiKey: string, audienceId: string): Promise<Broadcast[]> {
  const response = await fetch('https://api.resend.com/broadcasts?limit=100', {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!response.ok) throw new Error(`Failed to fetch broadcasts: ${response.status}`);

  const data = await response.json();
  await sleep(500); // Rate limit: 2 calls/sec
  const allBroadcasts = data.data || [];

  // Filter by audience_id
  return allBroadcasts.filter((b: Broadcast) => b.audience_id === audienceId);
}

async function fetchEmailsIncrementally(apiKey: string): Promise<{ newEmails: Email[]; allEmails: Email[] }> {
  // Try to get existing emails and last email ID
  let existingEmails: Email[] = [];
  let lastEmailId: string | undefined;

  try {
    const emailsBlob = await head('rss_emails');
    if (emailsBlob?.url) {
      const response = await fetch(emailsBlob.url);
      existingEmails = await response.json();
    }
  } catch (e) {
    // No existing emails, first run
  }

  try {
    const lastIdBlob = await head('rss_last_email_id');
    if (lastIdBlob?.url) {
      const response = await fetch(lastIdBlob.url);
      lastEmailId = await response.text();
    }
  } catch (e) {
    // No last ID stored
  }

  // Fetch new emails only
  let newEmails: Email[] = [];
  let hasMore = true;
  let currentLastId = lastEmailId;

  while (hasMore) {
    const url: string = currentLastId
      ? `https://api.resend.com/emails?limit=100&before=${currentLastId}`
      : 'https://api.resend.com/emails?limit=100';

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!response.ok) throw new Error(`Failed to fetch emails: ${response.status}`);

    const data = await response.json();
    const emails = data.data || [];

    if (emails.length === 0) break;

    newEmails = newEmails.concat(emails);

    // If we have a lastEmailId, stop when we've fetched enough new emails
    // Otherwise on first run, keep paginating through all
    if (lastEmailId) {
      hasMore = false; // Only fetch one batch of new emails
    } else {
      hasMore = data.has_more || false;
      if (hasMore && emails.length > 0) {
        currentLastId = emails[emails.length - 1].id;
      }
    }

    // Rate limit: 2 calls/sec
    await sleep(500);
  }

  // Merge: new emails first (most recent), then existing
  const allEmails = [...newEmails, ...existingEmails];

  return { newEmails, allEmails };
}

async function matchAndStore(broadcasts: Broadcast[], emails: Email[], apiKey: string) {
  for (const broadcast of broadcasts) {
    // Fetch full broadcast details to get subject and from
    const broadcastDetails = await fetchBroadcastDetails(apiKey, broadcast.id);

    if (!broadcastDetails || !broadcastDetails.subject || !broadcastDetails.from) continue;

    // Find matching email by subject and from
    const matchingEmail = emails.find(
      (email) => email.subject === broadcastDetails.subject && email.from === broadcastDetails.from
    );

    if (!matchingEmail) continue;

    // Fetch full email details to get HTML
    const emailDetails = await fetchEmailDetails(apiKey, matchingEmail.id);

    if (!emailDetails || !emailDetails.html) continue;

    // Store the full info with HTML
    await put(
      `rss_broadcast_${broadcast.id}_info`,
      JSON.stringify({ ...broadcastDetails, html: emailDetails.html }),
      { access: 'public', addRandomSuffix: false, allowOverwrite: true }
    );

    // Convert HTML to Markdown
    const markdown = turndown.turndown(emailDetails.html);

    await put(
      `rss_broadcast_${broadcast.id}_info_md`,
      JSON.stringify({ ...broadcastDetails, content: markdown }),
      { access: 'public', addRandomSuffix: false, allowOverwrite: true }
    );
  }
}

async function fetchBroadcastDetails(apiKey: string, broadcastId: string): Promise<Broadcast | null> {
  const response = await fetch(`https://api.resend.com/broadcasts/${broadcastId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!response.ok) {
    await sleep(500); // Rate limit even on error
    return null;
  }

  const data = await response.json();
  await sleep(500); // Rate limit: 2 calls/sec
  return data;
}

async function fetchEmailDetails(apiKey: string, emailId: string): Promise<Email | null> {
  const response = await fetch(`https://api.resend.com/emails/${emailId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!response.ok) {
    await sleep(500); // Rate limit even on error
    return null;
  }

  const data = await response.json();
  await sleep(500); // Rate limit: 2 calls/sec
  return data;
}