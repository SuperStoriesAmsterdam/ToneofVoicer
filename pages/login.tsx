import { useState, FormEvent } from 'react';
import { useRouter } from 'next/router';

export default function LoginPage() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    const res = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });

    if (res.ok) {
      router.push('/voice');
    } else {
      setError('Wrong password');
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-amber-50 text-black font-mono flex items-center justify-center p-6">
      <div className="border-4 border-black bg-white shadow-brutal-lg p-8 w-full max-w-md">
        <h1 className="text-2xl font-black uppercase tracking-tight mb-2">
          Voice Template Builder
        </h1>
        <p className="text-sm mb-6 opacity-70">Enter password to continue</p>

        <form onSubmit={handleSubmit}>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            className="w-full border-2 border-black p-3 font-mono mb-4"
            autoFocus
          />
          {error && (
            <p className="text-red-600 text-sm font-bold mb-4">{error}</p>
          )}
          <button
            type="submit"
            disabled={loading}
            className="w-full border-4 border-black p-3 font-black uppercase bg-green-400 hover:bg-green-500 shadow-brutal-sm hover:shadow-brutal active:shadow-none active:translate-x-1 active:translate-y-1 transition-all"
          >
            {loading ? 'Checking...' : 'Enter'}
          </button>
        </form>
      </div>
    </div>
  );
}
