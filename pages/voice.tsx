import { useState, useRef, useCallback, useEffect } from 'react';

// ── Types ──────────────────────────────────────────────────────────────────────

type Provider = 'claude' | 'openai';
type Message = { role: 'user' | 'assistant'; content: string };

interface StepState {
  messages: Message[];
  streaming: boolean;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const PHASES = [
  { id: 'create', title: 'Phase 1', subtitle: 'Post Creation & Feedback' },
  { id: 'analyze', title: 'Phase 2', subtitle: 'Voice Analysis' },
  { id: 'template', title: 'Phase 3', subtitle: 'Create Template' },
  { id: 'test', title: 'Phase 4', subtitle: 'Test & Refine' },
];

interface Step {
  phase: number;
  title: string;
  instructions: string;
  prompt: string;
  placeholders?: string[];
  userInputLabel?: string;
  userInputPlaceholder?: string;
}

const STEPS: Step[] = [
  // Phase 1
  {
    phase: 0,
    title: '1.1 Create a generic post',
    instructions: 'Start by asking the AI for a basic piece of content on your desired topic.',
    prompt: 'Write a LinkedIn post about AI in marketing',
    userInputLabel: 'Topic (optional — edit the prompt below if you want a different topic)',
    userInputPlaceholder: '',
  },
  {
    phase: 0,
    title: '1.2 Provide feedback to refine tone',
    instructions: 'Review the AI\'s output above. Tell the AI how to adjust the tone to be closer to your voice.',
    prompt: 'Revise to sound more natural. Use fewer buzzwords and avoid phrases like "delve into" or "navigate the landscape"',
    userInputLabel: 'Your feedback on the tone',
    userInputPlaceholder: 'e.g. Make it more conversational, less corporate. I never use exclamation marks...',
  },
  {
    phase: 0,
    title: '1.3 Extract current instructions',
    instructions: 'Ask the AI to list the specific tone instructions you\'ve given it so far. We\'ll save these for Phase 3.',
    prompt: 'What tone of voice or formatting instructions have I given you so far?',
  },
  // Phase 2
  {
    phase: 1,
    title: '2.1 Generate attributes list',
    instructions: 'Ask the AI for a list of terms used to describe writing styles (pace, mood, etc.).',
    prompt: 'Can you please generate a list of tone attributes to describe a piece of writing? Things like pace, mood, etc. Respond with nothing else besides the list.',
  },
  {
    phase: 1,
    title: '2.2 Analyze your samples',
    instructions: 'Paste 3-5 examples of your own writing below. The AI will analyze your unique voice using the attributes list.',
    prompt: '',
    userInputLabel: 'Your writing samples (paste 3-5 examples)',
    userInputPlaceholder: 'Paste your LinkedIn posts, blog excerpts, or other writing samples here...',
  },
  // Phase 3
  {
    phase: 2,
    title: '3.1 Create your reusable voice template',
    instructions: 'The AI will compile everything into a single, structured prompt template you can reuse forever.',
    prompt: '',
  },
  // Phase 4
  {
    phase: 3,
    title: '4.1 Test in a fresh context',
    instructions: 'Your template is applied in a clean context. Ask for any content to test it.',
    prompt: 'Using this voice, write a LinkedIn post about AI in marketing.',
    userInputLabel: 'Test content request',
    userInputPlaceholder: 'e.g. Write a LinkedIn post about hiring challenges in startups',
  },
  {
    phase: 3,
    title: '4.2 Refine based on results',
    instructions: 'If the output isn\'t perfect, give specific feedback. The AI will refine the template.',
    prompt: '',
    userInputLabel: 'What\'s missing or off?',
    userInputPlaceholder: 'e.g. The content is close but it\'s missing my usual conversational opening...',
  },
];

// ── Helpers ─────────────────────────────────────────────────────────────────────

function buildPromptForStep(
  stepIndex: number,
  userInput: string,
  stepStates: StepState[],
): string {
  const step = STEPS[stepIndex];

  // Step 1.2: feedback — user input IS the prompt
  if (stepIndex === 1) {
    return userInput || step.prompt;
  }

  // Step 2.2: analyze samples — combine attributes + user samples
  if (stepIndex === 4) {
    const attributeResponse = stepStates[3]?.messages?.find(m => m.role === 'assistant')?.content || '';
    return `Now, using these attributes:\n${attributeResponse}\n\nAnalyze these writing samples:\n\n${userInput}\n\nIdentify and describe the specific characteristics that make this writing voice unique. Focus on sentence structure, vocabulary patterns, rhetorical devices, and overall tone.`;
  }

  // Step 3.1: create template — combine analysis + extracted instructions
  if (stepIndex === 5) {
    const extractedInstructions = stepStates[2]?.messages?.find(m => m.role === 'assistant')?.content || '';
    const analysisResponse = stepStates[4]?.messages?.find(m => m.role === 'assistant')?.content || '';
    const samples = stepStates[4]?.messages?.find(m => m.role === 'user')?.content || '';

    return `Based on your analysis of my writing style, please create a comprehensive voice prompt template that includes:

1. A structured style section that documents my voice characteristics including:
   - Sentence structure and length patterns
   - Vocabulary preferences and word choices
   - Tone and perspective markers
   - Distinctive phrases or rhetorical devices
   - Elements to avoid (incorporate these previously extracted instructions: ${extractedInstructions})

2. A section for examples of my writing (use these samples: ${samples.substring(0, 2000)})

3. A clear instruction for how to apply this voice to new content

4. Also use my extracted instructions: ${extractedInstructions}

Format this as a single, ready-to-use prompt that I can copy/paste whenever I need content in my voice.

Here is the full voice analysis to base it on:
${analysisResponse}`;
  }

  // Step 4.1: test — use template as system, user input as prompt
  if (stepIndex === 6) {
    return userInput || step.prompt;
  }

  // Step 4.2: refine
  if (stepIndex === 7) {
    const template = stepStates[5]?.messages?.find(m => m.role === 'assistant')?.content || '';
    return `${userInput}\n\nPlease refine the voice template to better capture this aspect. Here is the current template:\n\n${template}`;
  }

  return userInput || step.prompt;
}

function getSystemForStep(stepIndex: number, stepStates: StepState[]): string | undefined {
  // Phase 4 uses the generated template as the system prompt
  if (stepIndex === 6 || stepIndex === 7) {
    return stepStates[5]?.messages?.find(m => m.role === 'assistant')?.content;
  }
  return undefined;
}

function getConversationHistory(stepIndex: number, stepStates: StepState[]): Message[] {
  // Phase 1 steps share conversation history
  if (stepIndex <= 2) {
    const history: Message[] = [];
    for (let i = 0; i < stepIndex; i++) {
      history.push(...(stepStates[i]?.messages || []));
    }
    return history;
  }
  // Phase 2 steps share history
  if (stepIndex === 4) {
    return [...(stepStates[3]?.messages || [])];
  }
  // Phase 4 step 4.2 gets 4.1 history
  if (stepIndex === 7) {
    return [...(stepStates[6]?.messages || [])];
  }
  return [];
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function VoiceTemplatePage() {
  const [provider, setProvider] = useState<Provider>('claude');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);
  const [stepStates, setStepStates] = useState<StepState[]>(
    STEPS.map(() => ({ messages: [], streaming: false })),
  );
  const [userInputs, setUserInputs] = useState<string[]>(STEPS.map(s => s.prompt));
  const [finalTemplate, setFinalTemplate] = useState('');
  const [copied, setCopied] = useState(false);
  const responseRef = useRef<HTMLDivElement>(null);

  // Load API key from localStorage
  useEffect(() => {
    const saved = localStorage.getItem('voice-tool-provider');
    const savedKey = localStorage.getItem('voice-tool-apikey');
    if (saved) setProvider(saved as Provider);
    if (savedKey) setApiKey(savedKey);
  }, []);

  const saveSettings = useCallback((p: Provider, k: string) => {
    localStorage.setItem('voice-tool-provider', p);
    localStorage.setItem('voice-tool-apikey', k);
  }, []);

  const runStep = useCallback(async () => {
    if (!apiKey) return alert('Please enter your API key first.');

    const prompt = buildPromptForStep(currentStep, userInputs[currentStep], stepStates);
    if (!prompt.trim()) return alert('Please provide input for this step.');

    const system = getSystemForStep(currentStep, stepStates);
    const history = getConversationHistory(currentStep, stepStates);
    const messages: Message[] = [...history, { role: 'user', content: prompt }];

    // Mark streaming
    setStepStates(prev => {
      const next = [...prev];
      next[currentStep] = {
        messages: [{ role: 'user', content: prompt }],
        streaming: true,
      };
      return next;
    });

    try {
      const res = await fetch('/api/voice-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, apiKey, messages, system }),
      });

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let fullResponse = '';

      if (!reader) throw new Error('No response stream');

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data);
            if (parsed.error) throw new Error(parsed.error);
            if (parsed.text) {
              fullResponse += parsed.text;
              setStepStates(prev => {
                const next = [...prev];
                next[currentStep] = {
                  messages: [
                    { role: 'user', content: prompt },
                    { role: 'assistant', content: fullResponse },
                  ],
                  streaming: true,
                };
                return next;
              });
              // Auto-scroll
              responseRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
            }
          } catch (e) {
            if (e instanceof Error && e.message !== 'Unknown error') {
              console.error('Parse error:', e);
            }
          }
        }
      }

      // Done streaming
      setStepStates(prev => {
        const next = [...prev];
        next[currentStep] = {
          messages: [
            { role: 'user', content: prompt },
            { role: 'assistant', content: fullResponse },
          ],
          streaming: false,
        };
        return next;
      });

      // Save template if this is Phase 3 or the refine step
      if (currentStep === 5 || currentStep === 7) {
        setFinalTemplate(fullResponse);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Something went wrong';
      setStepStates(prev => {
        const next = [...prev];
        next[currentStep] = {
          messages: [
            { role: 'user', content: prompt },
            { role: 'assistant', content: `Error: ${message}` },
          ],
          streaming: false,
        };
        return next;
      });
    }
  }, [apiKey, currentStep, provider, stepStates, userInputs]);

  const step = STEPS[currentStep];
  const state = stepStates[currentStep];
  const assistantResponse = state.messages.find(m => m.role === 'assistant')?.content || '';
  const canProceed = assistantResponse && !state.streaming;
  const currentPhase = step.phase;

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="min-h-screen bg-amber-50 text-black font-mono">
      {/* Header */}
      <header className="border-b-4 border-black p-6">
        <div className="max-w-4xl mx-auto">
          <h1 className="text-3xl font-black uppercase tracking-tight">Voice Template Builder</h1>
          <p className="text-sm mt-1 opacity-70">Create your AI voice template in 4 phases</p>
        </div>
      </header>

      <div className="max-w-4xl mx-auto p-6">
        {/* Settings bar */}
        <div className="border-4 border-black p-4 mb-8 bg-white shadow-brutal">
          <div className="flex flex-wrap gap-4 items-end">
            <div>
              <label className="block text-xs font-bold uppercase mb-1">Provider</label>
              <select
                value={provider}
                onChange={e => {
                  const p = e.target.value as Provider;
                  setProvider(p);
                  saveSettings(p, apiKey);
                }}
                className="border-2 border-black p-2 font-mono bg-white"
              >
                <option value="claude">Claude (Anthropic)</option>
                <option value="openai">GPT-4o (OpenAI)</option>
              </select>
            </div>
            <div className="flex-1 min-w-[250px]">
              <label className="block text-xs font-bold uppercase mb-1">API Key</label>
              <div className="flex gap-2">
                <input
                  type={showKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={e => {
                    setApiKey(e.target.value);
                    saveSettings(provider, e.target.value);
                  }}
                  placeholder={provider === 'claude' ? 'sk-ant-...' : 'sk-...'}
                  className="border-2 border-black p-2 font-mono flex-1"
                />
                <button
                  onClick={() => setShowKey(!showKey)}
                  className="border-2 border-black px-3 hover:bg-black hover:text-white transition-colors"
                >
                  {showKey ? 'Hide' : 'Show'}
                </button>
              </div>
              <p className="text-xs mt-1 opacity-50">Stored in your browser only. Never sent to our server.</p>
            </div>
          </div>
        </div>

        {/* Phase indicators */}
        <div className="flex gap-2 mb-6">
          {PHASES.map((phase, i) => (
            <button
              key={phase.id}
              onClick={() => {
                const firstStep = STEPS.findIndex(s => s.phase === i);
                if (firstStep >= 0) setCurrentStep(firstStep);
              }}
              className={`flex-1 border-2 border-black p-3 text-left transition-colors ${
                i === currentPhase
                  ? 'bg-black text-white'
                  : i < currentPhase
                  ? 'bg-green-200'
                  : 'bg-white hover:bg-gray-100'
              }`}
            >
              <div className="text-xs font-bold uppercase">{phase.title}</div>
              <div className="text-xs mt-0.5 truncate">{phase.subtitle}</div>
            </button>
          ))}
        </div>

        {/* Current step */}
        <div className="border-4 border-black bg-white shadow-brutal-lg mb-6">
          {/* Step header */}
          <div className="border-b-4 border-black p-4 bg-yellow-200">
            <h2 className="font-black text-xl">{step.title}</h2>
            <p className="text-sm mt-1">{step.instructions}</p>
          </div>

          {/* User input area */}
          {step.userInputLabel && (
            <div className="p-4 border-b-2 border-black bg-blue-50">
              <label className="block text-xs font-bold uppercase mb-2">{step.userInputLabel}</label>
              <textarea
                value={userInputs[currentStep]}
                onChange={e => {
                  const next = [...userInputs];
                  next[currentStep] = e.target.value;
                  setUserInputs(next);
                }}
                placeholder={step.userInputPlaceholder}
                rows={step.userInputPlaceholder?.includes('samples') ? 8 : 3}
                className="w-full border-2 border-black p-3 font-mono text-sm resize-y"
              />
            </div>
          )}

          {/* Prompt preview */}
          <div className="p-4 border-b-2 border-black">
            <div className="flex justify-between items-center mb-2">
              <label className="text-xs font-bold uppercase">Prompt that will be sent</label>
              <button
                onClick={() => copyToClipboard(buildPromptForStep(currentStep, userInputs[currentStep], stepStates))}
                className="text-xs border border-black px-2 py-0.5 hover:bg-black hover:text-white transition-colors"
              >
                Copy
              </button>
            </div>
            <pre className="text-xs bg-gray-100 border border-black p-3 whitespace-pre-wrap max-h-40 overflow-y-auto">
              {buildPromptForStep(currentStep, userInputs[currentStep], stepStates) || '(waiting for input...)'}
            </pre>
          </div>

          {/* Run button */}
          <div className="p-4 border-b-2 border-black">
            <button
              onClick={runStep}
              disabled={state.streaming}
              className={`w-full border-4 border-black p-4 font-black text-lg uppercase tracking-wider transition-all ${
                state.streaming
                  ? 'bg-gray-300 cursor-wait animate-pulse'
                  : 'bg-green-400 hover:bg-green-500 shadow-brutal-sm hover:shadow-brutal active:shadow-none active:translate-x-1 active:translate-y-1'
              }`}
            >
              {state.streaming ? 'Generating...' : `Run Step ${step.title.split(' ')[0]}`}
            </button>
          </div>

          {/* AI response */}
          {assistantResponse && (
            <div className="p-4" ref={responseRef}>
              <div className="flex justify-between items-center mb-2">
                <label className="text-xs font-bold uppercase">
                  AI Response {state.streaming && <span className="animate-pulse">●</span>}
                </label>
                <button
                  onClick={() => copyToClipboard(assistantResponse)}
                  className="text-xs border border-black px-2 py-0.5 hover:bg-black hover:text-white transition-colors"
                >
                  {copied ? 'Copied!' : 'Copy Response'}
                </button>
              </div>
              <div className="border-2 border-black p-4 bg-gray-50 prose prose-sm max-w-none whitespace-pre-wrap text-sm max-h-96 overflow-y-auto">
                {assistantResponse}
              </div>
            </div>
          )}
        </div>

        {/* Navigation */}
        <div className="flex justify-between items-center mb-8">
          <button
            onClick={() => setCurrentStep(Math.max(0, currentStep - 1))}
            disabled={currentStep === 0}
            className="border-2 border-black px-6 py-3 font-bold uppercase disabled:opacity-30 hover:bg-black hover:text-white transition-colors"
          >
            &larr; Previous
          </button>

          <span className="text-sm font-bold">
            Step {currentStep + 1} of {STEPS.length}
          </span>

          <button
            onClick={() => setCurrentStep(Math.min(STEPS.length - 1, currentStep + 1))}
            disabled={currentStep === STEPS.length - 1 || !canProceed}
            className="border-2 border-black px-6 py-3 font-bold uppercase disabled:opacity-30 hover:bg-black hover:text-white transition-colors"
          >
            Next &rarr;
          </button>
        </div>

        {/* Final template */}
        {finalTemplate && (
          <div className="border-4 border-black bg-green-100 shadow-brutal-lg mb-8">
            <div className="border-b-4 border-black p-4 bg-green-300">
              <div className="flex justify-between items-center">
                <h2 className="font-black text-xl">Your Voice Template</h2>
                <button
                  onClick={() => copyToClipboard(finalTemplate)}
                  className="border-2 border-black px-4 py-2 bg-white font-bold hover:bg-black hover:text-white transition-colors"
                >
                  {copied ? 'Copied!' : 'Copy Template'}
                </button>
              </div>
              <p className="text-sm mt-1">Save this and paste it at the start of any new AI conversation.</p>
            </div>
            <div className="p-4">
              <pre className="text-sm whitespace-pre-wrap max-h-96 overflow-y-auto">{finalTemplate}</pre>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
