import type { NextApiRequest, NextApiResponse } from 'next';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';

// Load anti-AI phrases at module level (cached across requests)
let antiAiPhrases = '';
try {
  antiAiPhrases = fs.readFileSync(
    path.join(process.cwd(), 'content', 'anti-ai-phrases.md'),
    'utf-8',
  );
} catch {
  // File might not exist in dev
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { provider, apiKey, messages, system, injectAntiAi } = req.body as {
    provider: 'claude' | 'openai';
    apiKey: string;
    messages: { role: 'user' | 'assistant'; content: string }[];
    system?: string;
    injectAntiAi?: boolean;
  };

  if (!apiKey || !messages?.length) {
    return res.status(400).json({ error: 'Missing apiKey or messages' });
  }

  let finalSystem = system || '';
  if (injectAntiAi && antiAiPhrases) {
    const antiAiBlock = `\n\nAVOID THESE AI-TELL PHRASES — they make content instantly recognizable as AI-generated:\n${antiAiPhrases}\nUse natural alternatives instead. If you catch yourself about to use one, rephrase completely.\n`;
    finalSystem = finalSystem ? finalSystem + antiAiBlock : antiAiBlock;
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
        system: finalSystem || undefined,
        messages,
      });

      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          res.write(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`);
        }
      }
    } else {
      const client = new OpenAI({ apiKey });
      const openaiMessages = finalSystem
        ? [{ role: 'system' as const, content: finalSystem }, ...messages]
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
