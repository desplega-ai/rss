import { NextRequest, NextResponse } from 'next/server';
import { head } from '@vercel/blob';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const { id } = params;

  try {
    // Fetch broadcast HTML from blob storage
    const contentBlob = await head(`rss_broadcast_${id}_info`);

    if (!contentBlob?.url) {
      return new NextResponse('Broadcast not found', { status: 404 });
    }

    const response = await fetch(contentBlob.url);
    const data = await response.json();

    if (!data.html) {
      return new NextResponse('HTML content not available', { status: 404 });
    }

    // Return HTML
    return new NextResponse(data.html, {
      headers: {
        'Content-Type': 'text/html',
      },
    });
  } catch (error) {
    console.error('Error fetching broadcast:', error);
    return new NextResponse('Failed to fetch broadcast', { status: 500 });
  }
}