import { NextRequest, NextResponse } from 'next/server';
import { put } from '@vercel/blob';
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
  html?: string;
  text?: string;
  reply_to?: string | null;
  preview_text?: string;
  status?: string;
  created_at: string;
  sent_at: string | null;
  scheduled_at?: string | null;
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

    // 3. Fetch full broadcast details with HTML and convert to markdown
    await fetchAndStoreBroadcastsWithHtml(broadcasts, apiKey);

    return NextResponse.json({
      success: true,
      audiences: audiences.length,
      broadcasts: broadcasts.length,
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

async function fetchAndStoreBroadcastsWithHtml(broadcasts: Broadcast[], apiKey: string) {
  for (const broadcast of broadcasts) {
    // Fetch full broadcast details including HTML
    const broadcastDetails = await fetchBroadcastDetails(apiKey, broadcast.id);

    if (!broadcastDetails || !broadcastDetails.html) continue;

    // Store the full info with HTML
    await put(
      `rss_broadcast_${broadcast.id}_info`,
      JSON.stringify(broadcastDetails),
      { access: 'public', addRandomSuffix: false, allowOverwrite: true }
    );

    // Convert HTML to Markdown
    const markdown = turndown.turndown(broadcastDetails.html);

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