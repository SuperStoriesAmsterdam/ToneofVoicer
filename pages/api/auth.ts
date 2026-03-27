import type { NextApiRequest, NextApiResponse } from 'next';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { password } = req.body;
  const expected = process.env.APP_PASSWORD;

  if (!expected || password !== expected) {
    return res.status(401).json({ error: 'Wrong password' });
  }

  res.setHeader(
    'Set-Cookie',
    `tov-auth=${password}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${7 * 24 * 60 * 60}`,
  );
  return res.status(200).json({ ok: true });
}
