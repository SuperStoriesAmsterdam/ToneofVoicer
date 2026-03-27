import type { NextApiRequest, NextApiResponse } from 'next';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { provider, apiKey, messages, system } = req.body as {
    provider: 'claude' | 'openai';
    apiKey: string;
    messages: { role: 'user' | 'assistant'; content: string }[];
    system?: string;
  };

  if (!apiKey || !messages?.length) {
    return res.status(400).json({ error: 'Missing apiKey or messages' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    if (provider === 'claude') {
      const client = new Anthropic({ apiKey });
      const stream = client.messages.stream({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: system || undefined,
        messages,
      });

      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          res.write(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`);
        }
      }
    } else {
      const client = new OpenAI({ apiKey });
      const openaiMessages = system
        ? [{ role: 'system' as const, content: system }, ...messages]
        : messages;

      const stream = await client.chat.completions.create({
        model: 'gpt-4o',
        messages: openaiMessages,
        stream: true,
      });

      for await (const chunk of stream) {
        const text = chunk.choices[0]?.delta?.content;
        if (text) {
          res.write(`data: ${JSON.stringify({ text })}\n\n`);
        }
      }
    }

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
    res.end();
  }
}
