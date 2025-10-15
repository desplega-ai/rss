import { NextResponse } from 'next/server';
import { head } from '@vercel/blob';

// Force dynamic rendering
export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface Broadcast {
  id: string;
  audience_id: string;
  name?: string;
  subject?: string;
  created_at: string;
  sent_at: string | null;
}

interface BroadcastWithContent extends Broadcast {
  html?: string;
}

export async function GET() {
  try {
    // Read broadcasts from blob storage
    const broadcastsBlob = await head('rss_broadcasts');

    if (!broadcastsBlob?.url) {
      return NextResponse.json(
        { error: 'No broadcasts found. Run the cron job first.' },
        { status: 404 }
      );
    }

    // Fetch the blob content
    const response = await fetch(broadcastsBlob.url);
    const broadcasts: Broadcast[] = await response.json();

    // Fetch HTML content for each broadcast
    const broadcastsWithContent: BroadcastWithContent[] = await Promise.all(
      broadcasts.map(async (broadcast) => {
        try {
          const contentBlob = await head(`rss_broadcast_${broadcast.id}_info`);
          if (contentBlob?.url) {
            const contentResponse = await fetch(contentBlob.url);
            const contentData = await contentResponse.json();
            return { ...broadcast, html: contentData.html };
          }
        } catch (e) {
          // Content not found, skip
        }
        return broadcast;
      })
    );

    // Generate RSS feed
    const rss = generateRSS(broadcastsWithContent);

    return new NextResponse(rss, {
      headers: {
        'Content-Type': 'application/xml',
      },
    });
  } catch (error) {
    console.error('Error generating RSS:', error);
    return NextResponse.json(
      { error: 'Failed to generate RSS feed' },
      { status: 500 }
    );
  }
}

function generateRSS(broadcasts: BroadcastWithContent[]): string {
  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'http://localhost:3001';

  const items = broadcasts
    .map((broadcast) => {
      const title = broadcast.subject || broadcast.name || `Broadcast ${broadcast.id}`;
      const pubDate = new Date(broadcast.sent_at || broadcast.created_at).toUTCString();
      const link = `${baseUrl}/api/broadcast/${broadcast.id}`;
      const description = broadcast.html
        ? `<![CDATA[${broadcast.html}]]>`
        : '';

      return `    <item>
      <title>${escapeXml(title)}</title>
      <link>${link}</link>
      <guid>${link}</guid>
      <pubDate>${pubDate}</pubDate>${description ? `\n      <description>${description}</description>` : ''}
    </item>`;
    })
    .join('\n');

  const feedTitle = process.env.RSS_FEED_TITLE || 'Newsletter Feed';
  const feedDescription = process.env.RSS_FEED_DESCRIPTION || 'RSS feed of newsletter broadcasts';

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeXml(feedTitle)}</title>
    <description>${escapeXml(feedDescription)}</description>
    <link>${baseUrl}</link>
${items}
  </channel>
</rss>`;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}