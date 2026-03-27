import { useState, useRef, useCallback, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// ── Types ──────────────────────────────────────────────────────────────────────

type Provider = 'claude' | 'openai';
type Message = { role: 'user' | 'assistant'; content: string };

interface StepState {
  messages: Message[];
  streaming: boolean;
}

interface SavedTemplate {
  id: string;
  name: string;
  template: string;
  createdAt: string;
  updatedAt: string;
}

interface PersistedState {
  currentStep: number;
  stepStates: StepState[];
  userInputs: string[];
  finalTemplate: string;
  writingSamples: string[];
  activeTemplateName: string;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'tov-wizard-state';
const LIBRARY_KEY = 'tov-template-library';

const PHASES = [
  { id: 'create', title: 'Phase 1', subtitle: 'Post Creation & Feedback' },
  { id: 'analyze', title: 'Phase 2', subtitle: 'Voice Analysis' },
  { id: 'template', title: 'Phase 3', subtitle: 'Create Template' },
  { id: 'test', title: 'Phase 4', subtitle: 'Test & Refine' },
];

const CONTENT_TYPES = [
  { id: 'linkedin', label: 'LinkedIn Post', prompt: 'Write a LinkedIn post about' },
  { id: 'email', label: 'Professional Email', prompt: 'Write a professional email about' },
  { id: 'website', label: 'Website Copy', prompt: 'Write website copy about' },
  { id: 'social', label: 'Social Media Post', prompt: 'Write a social media post about' },
];

// Steps where the previous response should be visible alongside feedback
const FEEDBACK_STEPS = new Set([1, 7]);
// Maps feedback step index → the step whose response to show
const FEEDBACK_SOURCE: Record<number, number> = { 1: 0, 7: 6 };

interface Step {
  phase: number;
  title: string;
  instructions: string;
  prompt: string;
  userInputLabel?: string;
  userInputPlaceholder?: string;
}

const STEPS: Step[] = [
  {
    phase: 0,
    title: '1.1 Create a generic post',
    instructions: 'Start by asking the AI for a basic piece of content on your desired topic.',
    prompt: 'Write a LinkedIn post about AI in marketing',
    userInputLabel: 'Topic (optional — edit the prompt if you want a different topic)',
    userInputPlaceholder: '',
  },
  {
    phase: 0,
    title: '1.2 Provide feedback to refine tone',
    instructions: 'Review the generated content on the left. Tell the AI how to adjust the tone.',
    prompt: 'Revise to sound more natural. Use fewer buzzwords and avoid phrases like "delve into" or "navigate the landscape"',
    userInputLabel: 'Your feedback on the tone',
    userInputPlaceholder: 'e.g. Make it more conversational, less corporate. I never use exclamation marks...',
  },
  {
    phase: 0,
    title: '1.3 Extract current instructions',
    instructions: 'The AI will list the tone instructions you\'ve given so far. We\'ll use these in Phase 3.',
    prompt: 'What tone of voice or formatting instructions have I given you so far?',
  },
  {
    phase: 1,
    title: '2.1 Generate attributes list',
    instructions: 'The AI generates a list of tone attributes (pace, mood, etc.) for analyzing your voice.',
    prompt: 'Can you please generate a list of tone attributes to describe a piece of writing? Things like pace, mood, etc. Respond with nothing else besides the list.',
  },
  {
    phase: 1,
    title: '2.2 Analyze your samples',
    instructions: 'Add your writing samples one by one below. The AI will analyze your unique voice.',
    prompt: '',
    userInputLabel: 'Your writing samples',
    userInputPlaceholder: 'Paste one writing sample here, then click Add Sample...',
  },
  {
    phase: 2,
    title: '3.1 Create your reusable voice template',
    instructions: 'The AI compiles everything into a structured voice template you can reuse.',
    prompt: '',
  },
  {
    phase: 3,
    title: '4.1 Test across content types',
    instructions: 'Your template is applied in a clean context. Select content types and enter a topic to test.',
    prompt: 'AI in marketing',
    userInputLabel: 'Topic to write about',
    userInputPlaceholder: 'e.g. hiring challenges in startups',
  },
  {
    phase: 3,
    title: '4.2 Refine based on results',
    instructions: 'Review the results on the left. Provide feedback to refine the voice template.',
    prompt: '',
    userInputLabel: 'What\'s missing or off?',
    userInputPlaceholder: 'e.g. The content is close but it\'s missing my usual conversational opening...',
  },
];

// ── Markdown Component ─────────────────────────────────────────────────────────

function Md({ children }: { children: string }) {
  return (
    <div className="prose prose-sm max-w-none text-sm">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

const TENDENCY_INSTRUCTIONS = `
CRITICAL INSTRUCTIONS FOR TEMPLATE GENERATION:
- Express ALL style rules as TENDENCIES with frequency weights, NOT absolute rules
- Instead of "NEVER use exclamation marks" → "Rarely uses exclamation marks — perhaps 1 in 10 posts"
- Instead of "ALWAYS start with a question" → "Often opens with a question (~60% of posts)"
- Use spectrum language: "tends to", "often", "rarely", "occasionally", "about X in Y times"
- For each characteristic, show where it falls on a spectrum (e.g., formal ←→ casual: leans casual, ~70/30)
- Include a "controlled variation" section listing acceptable deviations from the usual patterns
- Real voice has controlled inconsistency — spontaneity comes from occasionally breaking your own patterns
`;

function buildPromptForStep(
  stepIndex: number,
  userInput: string,
  stepStates: StepState[],
  writingSamples: string[],
): string {
  const step = STEPS[stepIndex];

  if (stepIndex === 1) {
    return userInput || step.prompt;
  }

  if (stepIndex === 4) {
    const attributeResponse = stepStates[3]?.messages?.find(m => m.role === 'assistant')?.content || '';
    const samplesText = writingSamples.map((s, i) => `--- Sample ${i + 1} ---\n${s}`).join('\n\n');
    return `Now, using these attributes:\n${attributeResponse}\n\nAnalyze these writing samples:\n\n${samplesText}\n\nIdentify and describe the specific characteristics that make this writing voice unique. Focus on sentence structure, vocabulary patterns, rhetorical devices, and overall tone.`;
  }

  if (stepIndex === 5) {
    const extractedInstructions = stepStates[2]?.messages?.find(m => m.role === 'assistant')?.content || '';
    const analysisResponse = stepStates[4]?.messages?.find(m => m.role === 'assistant')?.content || '';
    const samplesText = writingSamples.map((s, i) => `--- Sample ${i + 1} ---\n${s}`).join('\n\n');

    return `Based on your analysis of my writing style, please create a comprehensive voice prompt template that includes:

1. A structured style section documenting voice characteristics:
   - Sentence structure and length patterns
   - Vocabulary preferences and word choices
   - Tone and perspective markers
   - Distinctive phrases or rhetorical devices
   - Elements to avoid (from these extracted instructions: ${extractedInstructions})

2. A section with examples of my writing (use these samples):
${samplesText.substring(0, 3000)}

3. Clear instructions for applying this voice to new content

4. My extracted tone instructions: ${extractedInstructions}

${TENDENCY_INSTRUCTIONS}

Here is the full voice analysis to base it on:
${analysisResponse}`;
  }

  if (stepIndex === 6) {
    return userInput || step.prompt;
  }

  if (stepIndex === 7) {
    const template = stepStates[5]?.messages?.find(m => m.role === 'assistant')?.content || '';
    return `${userInput}\n\nPlease refine the voice template to better capture this aspect. Here is the current template:\n\n${template}`;
  }

  return userInput || step.prompt;
}

function getSystemForStep(stepIndex: number, stepStates: StepState[], finalTemplate: string): string | undefined {
  if (stepIndex === 6 || stepIndex === 7) {
    return finalTemplate || stepStates[5]?.messages?.find(m => m.role === 'assistant')?.content;
  }
  return undefined;
}

function getConversationHistory(stepIndex: number, stepStates: StepState[]): Message[] {
  if (stepIndex <= 2) {
    const history: Message[] = [];
    for (let i = 0; i < stepIndex; i++) {
      history.push(...(stepStates[i]?.messages || []));
    }
    return history;
  }
  if (stepIndex === 4) return [...(stepStates[3]?.messages || [])];
  if (stepIndex === 7) return [...(stepStates[6]?.messages || [])];
  return [];
}

function downloadFile(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function copyFormatted(markdown: string) {
  const container = document.createElement('div');
  container.innerHTML = markdown
    .replace(/^### (.*$)/gm, '<h3>$1</h3>')
    .replace(/^## (.*$)/gm, '<h2>$1</h2>')
    .replace(/^# (.*$)/gm, '<h1>$1</h1>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/^- (.*$)/gm, '<li>$1</li>')
    .replace(/\n/g, '<br>');

  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([container.innerHTML], { type: 'text/html' }),
        'text/plain': new Blob([markdown], { type: 'text/plain' }),
      }),
    ]);
  } catch {
    await navigator.clipboard.writeText(markdown);
  }
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function VoiceTemplatePage() {
  // Core state
  const [provider, setProvider] = useState<Provider>('claude');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);
  const [stepStates, setStepStates] = useState<StepState[]>(
    STEPS.map(() => ({ messages: [], streaming: false })),
  );
  const [userInputs, setUserInputs] = useState<string[]>(STEPS.map(s => s.prompt));
  const [finalTemplate, setFinalTemplate] = useState('');
  const [isHydrated, setIsHydrated] = useState(false);

  // Writing samples
  const [writingSamples, setWritingSamples] = useState<string[]>([]);
  const [sampleDraft, setSampleDraft] = useState('');

  // Content type testing
  const [selectedTypes, setSelectedTypes] = useState<string[]>(CONTENT_TYPES.map(t => t.id));
  const [contentResults, setContentResults] = useState<Record<string, string>>({});
  const [activeTab, setActiveTab] = useState(CONTENT_TYPES[0].id);
  const [generatingTypes, setGeneratingTypes] = useState(false);

  // Template library
  const [savedTemplates, setSavedTemplates] = useState<SavedTemplate[]>([]);
  const [showLibrary, setShowLibrary] = useState(false);
  const [activeTemplateName, setActiveTemplateName] = useState('');
  const [saveNameInput, setSaveNameInput] = useState('');
  const [showSaveInput, setShowSaveInput] = useState(false);

  // Refinement loop
  const [refinementMode, setRefinementMode] = useState(false);
  const [refinementPosts, setRefinementPosts] = useState<string[]>([]);
  const [refinementFeedback, setRefinementFeedback] = useState('');
  const [refining, setRefining] = useState(false);

  // Follow-up conversation
  const [followUpText, setFollowUpText] = useState('');

  // UI
  const [copied, setCopied] = useState('');
  const responseRef = useRef<HTMLDivElement>(null);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout>>();

  // ── Persistence: hydrate ────────────────────────────────────────────────

  useEffect(() => {
    try {
      const saved = localStorage.getItem('voice-tool-provider');
      const savedKey = localStorage.getItem('voice-tool-apikey');
      if (saved) setProvider(saved as Provider);
      if (savedKey) setApiKey(savedKey);

      const persisted = localStorage.getItem(STORAGE_KEY);
      if (persisted) {
        const data: PersistedState = JSON.parse(persisted);
        setCurrentStep(data.currentStep || 0);
        if (data.stepStates) setStepStates(data.stepStates.map(s => ({ ...s, streaming: false })));
        if (data.userInputs) setUserInputs(data.userInputs);
        if (data.finalTemplate) setFinalTemplate(data.finalTemplate);
        if (data.writingSamples) setWritingSamples(data.writingSamples);
        if (data.activeTemplateName) setActiveTemplateName(data.activeTemplateName);
      }

      const lib = localStorage.getItem(LIBRARY_KEY);
      if (lib) setSavedTemplates(JSON.parse(lib));
    } catch { /* ignore corrupt data */ }
    setIsHydrated(true);
  }, []);

  // ── Persistence: save (debounced) ──────────────────────────────────────

  useEffect(() => {
    if (!isHydrated) return;
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => {
      const data: PersistedState = {
        currentStep, stepStates, userInputs, finalTemplate, writingSamples, activeTemplateName,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    }, 500);
  }, [currentStep, stepStates, userInputs, finalTemplate, writingSamples, activeTemplateName, isHydrated]);

  useEffect(() => {
    if (!isHydrated) return;
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(savedTemplates));
  }, [savedTemplates, isHydrated]);

  // ── Settings persistence ───────────────────────────────────────────────

  const saveSettings = useCallback((p: Provider, k: string) => {
    localStorage.setItem('voice-tool-provider', p);
    localStorage.setItem('voice-tool-apikey', k);
  }, []);

  // ── Stream helper ──────────────────────────────────────────────────────

  const streamChat = useCallback(async (
    messages: Message[],
    system?: string,
    injectAntiAi = false,
    onChunk?: (fullText: string) => void,
  ): Promise<string> => {
    const res = await fetch('/api/voice-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, apiKey, messages, system, injectAntiAi }),
    });

    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    let fullResponse = '';
    if (!reader) throw new Error('No response stream');

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) throw new Error(parsed.error);
          if (parsed.text) {
            fullResponse += parsed.text;
            onChunk?.(fullResponse);
          }
        } catch (e) {
          if (e instanceof Error && e.message !== 'Unknown error') console.error(e);
        }
      }
    }
    return fullResponse;
  }, [provider, apiKey]);

  // ── Run step ───────────────────────────────────────────────────────────

  const runStep = useCallback(async () => {
    if (!apiKey) return alert('Please enter your API key first.');

    const prompt = buildPromptForStep(currentStep, userInputs[currentStep], stepStates, writingSamples);
    if (!prompt.trim()) return alert('Please provide input for this step.');

    const system = getSystemForStep(currentStep, stepStates, finalTemplate);
    const history = getConversationHistory(currentStep, stepStates);
    const messages: Message[] = [...history, { role: 'user', content: prompt }];
    const injectAntiAi = currentStep === 5 || currentStep === 6;

    setStepStates(prev => {
      const next = [...prev];
      next[currentStep] = { messages: [{ role: 'user', content: prompt }], streaming: true };
      return next;
    });

    try {
      const fullResponse = await streamChat(messages, system, injectAntiAi, (text) => {
        setStepStates(prev => {
          const next = [...prev];
          next[currentStep] = {
            messages: [{ role: 'user', content: prompt }, { role: 'assistant', content: text }],
            streaming: true,
          };
          return next;
        });
        responseRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
      });

      setStepStates(prev => {
        const next = [...prev];
        next[currentStep] = {
          messages: [{ role: 'user', content: prompt }, { role: 'assistant', content: fullResponse }],
          streaming: false,
        };
        return next;
      });

      if (currentStep === 5 || currentStep === 7) {
        setFinalTemplate(fullResponse);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Something went wrong';
      setStepStates(prev => {
        const next = [...prev];
        next[currentStep] = {
          messages: [{ role: 'user', content: prompt }, { role: 'assistant', content: `Error: ${message}` }],
          streaming: false,
        };
        return next;
      });
    }
  }, [apiKey, currentStep, provider, stepStates, userInputs, writingSamples, finalTemplate, streamChat]);

  // ── Follow-up within a step ───────────────────────────────────────────

  const sendFollowUp = useCallback(async () => {
    if (!apiKey || !followUpText.trim()) return;

    const currentMessages = stepStates[currentStep]?.messages || [];
    const system = getSystemForStep(currentStep, stepStates, finalTemplate);
    // Build full context: conversation history from prior steps + this step's messages + new follow-up
    const history = getConversationHistory(currentStep, stepStates);
    const allMessages: Message[] = [...history, ...currentMessages, { role: 'user', content: followUpText.trim() }];

    const newUserMsg: Message = { role: 'user', content: followUpText.trim() };
    const updatedMessages = [...currentMessages, newUserMsg];

    setStepStates(prev => {
      const next = [...prev];
      next[currentStep] = { messages: updatedMessages, streaming: true };
      return next;
    });
    setFollowUpText('');

    const injectAntiAi = currentStep === 5 || currentStep === 6;

    try {
      const fullResponse = await streamChat(allMessages, system, injectAntiAi, (text) => {
        setStepStates(prev => {
          const next = [...prev];
          next[currentStep] = {
            messages: [...updatedMessages, { role: 'assistant', content: text }],
            streaming: true,
          };
          return next;
        });
        responseRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
      });

      setStepStates(prev => {
        const next = [...prev];
        next[currentStep] = {
          messages: [...updatedMessages, { role: 'assistant', content: fullResponse }],
          streaming: false,
        };
        return next;
      });

      if (currentStep === 5 || currentStep === 7) {
        setFinalTemplate(fullResponse);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Something went wrong';
      setStepStates(prev => {
        const next = [...prev];
        next[currentStep] = {
          messages: [...updatedMessages, { role: 'assistant', content: `Error: ${message}` }],
          streaming: false,
        };
        return next;
      });
    }
  }, [apiKey, followUpText, currentStep, stepStates, finalTemplate, streamChat]);

  // ── Multi-type content generation ──────────────────────────────────────

  const generateContentTypes = useCallback(async () => {
    if (!apiKey) return alert('Please enter your API key first.');
    const topic = userInputs[6] || 'AI in marketing';
    const template = finalTemplate || stepStates[5]?.messages?.find(m => m.role === 'assistant')?.content;
    if (!template) return alert('No voice template found. Complete Phase 3 first.');

    setGeneratingTypes(true);
    setContentResults({});
    const results: Record<string, string> = {};

    for (const type of CONTENT_TYPES.filter(t => selectedTypes.includes(t.id))) {
      setActiveTab(type.id);
      try {
        const result = await streamChat(
          [{ role: 'user', content: `${type.prompt} ${topic}` }],
          template,
          true,
          (text) => setContentResults(prev => ({ ...prev, [type.id]: text })),
        );
        results[type.id] = result;
        setContentResults(prev => ({ ...prev, [type.id]: result }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Error';
        results[type.id] = `Error: ${msg}`;
        setContentResults(prev => ({ ...prev, [type.id]: `Error: ${msg}` }));
      }
    }

    setGeneratingTypes(false);
    // Also set step 6 state so navigation works
    setStepStates(prev => {
      const next = [...prev];
      const combined = Object.entries(results).map(([id, text]) => {
        const label = CONTENT_TYPES.find(t => t.id === id)?.label || id;
        return `## ${label}\n\n${text}`;
      }).join('\n\n---\n\n');
      next[6] = {
        messages: [
          { role: 'user', content: `Generate content about: ${topic}` },
          { role: 'assistant', content: combined },
        ],
        streaming: false,
      };
      return next;
    });
  }, [apiKey, userInputs, finalTemplate, stepStates, selectedTypes, streamChat]);

  // ── Refinement loop ────────────────────────────────────────────────────

  const generateRefinementPosts = useCallback(async () => {
    if (!finalTemplate) return;
    setRefining(true);
    setRefinementPosts([]);
    const topics = ['the future of remote work', 'lessons from a recent project', 'a counterintuitive business insight'];
    const posts: string[] = [];

    for (const topic of topics) {
      try {
        const result = await streamChat(
          [{ role: 'user', content: `Write a LinkedIn post about ${topic}` }],
          finalTemplate, true,
        );
        posts.push(result);
        setRefinementPosts([...posts]);
      } catch {
        posts.push('(generation failed)');
        setRefinementPosts([...posts]);
      }
    }
    setRefining(false);
  }, [finalTemplate, streamChat]);

  const refineTemplate = useCallback(async () => {
    if (!refinementFeedback.trim() || !finalTemplate) return;
    setRefining(true);
    try {
      const postsContext = refinementPosts.map((p, i) => `Post ${i + 1}:\n${p}`).join('\n\n');
      const result = await streamChat(
        [{
          role: 'user',
          content: `Here are 3 posts generated with the current voice template:\n\n${postsContext}\n\nFeedback: ${refinementFeedback}\n\nPlease refine the voice template to address this feedback. Output the complete updated template.`,
        }],
        undefined, true,
      );
      setFinalTemplate(result);
      setRefinementFeedback('');
      setRefinementPosts([]);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Refinement failed');
    }
    setRefining(false);
  }, [refinementFeedback, finalTemplate, refinementPosts, streamChat]);

  // ── Template library ───────────────────────────────────────────────────

  const saveToLibrary = () => {
    if (!saveNameInput.trim() || !finalTemplate) return;
    const now = new Date().toISOString();
    const template: SavedTemplate = {
      id: crypto.randomUUID(),
      name: saveNameInput.trim(),
      template: finalTemplate,
      createdAt: now,
      updatedAt: now,
    };
    setSavedTemplates(prev => [template, ...prev]);
    setActiveTemplateName(template.name);
    setSaveNameInput('');
    setShowSaveInput(false);
  };

  const loadFromLibrary = (template: SavedTemplate) => {
    setFinalTemplate(template.template);
    setActiveTemplateName(template.name);
    setStepStates(prev => {
      const next = [...prev];
      next[5] = {
        messages: [
          { role: 'user', content: '(loaded from library)' },
          { role: 'assistant', content: template.template },
        ],
        streaming: false,
      };
      return next;
    });
    setShowLibrary(false);
  };

  const deleteFromLibrary = (id: string) => {
    if (!confirm('Delete this template?')) return;
    setSavedTemplates(prev => prev.filter(t => t.id !== id));
  };

  // ── Import template ────────────────────────────────────────────────────

  const importFileRef = useRef<HTMLInputElement>(null);
  const [showImportPaste, setShowImportPaste] = useState(false);
  const [importPasteText, setImportPasteText] = useState('');

  const applyImportedTemplate = (content: string, name: string) => {
    setFinalTemplate(content);
    setActiveTemplateName(name);
    setStepStates(prev => {
      const next = [...prev];
      next[5] = {
        messages: [
          { role: 'user', content: '(imported template)' },
          { role: 'assistant', content: content },
        ],
        streaming: false,
      };
      return next;
    });
    // Jump to test step and auto-open refinement
    setCurrentStep(6);
    setRefinementMode(false);
    setShowImportPaste(false);
    setImportPasteText('');
  };

  const handleFileImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const content = ev.target?.result as string;
      const name = file.name.replace(/\.(md|txt)$/, '');
      applyImportedTemplate(content, name);
    };
    reader.readAsText(file);
    e.target.value = ''; // reset so same file can be re-imported
  };

  // ── Reset ──────────────────────────────────────────────────────────────

  const resetAll = () => {
    if (!confirm('Start over? This will clear all progress (saved templates are kept).')) return;
    localStorage.removeItem(STORAGE_KEY);
    setCurrentStep(0);
    setStepStates(STEPS.map(() => ({ messages: [], streaming: false })));
    setUserInputs(STEPS.map(s => s.prompt));
    setFinalTemplate('');
    setWritingSamples([]);
    setActiveTemplateName('');
    setContentResults({});
    setRefinementMode(false);
    setRefinementPosts([]);
  };

  // ── Copy helper ────────────────────────────────────────────────────────

  const copyText = (text: string, label = 'text') => {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(''), 2000);
  };

  // ── Derived state ──────────────────────────────────────────────────────

  const step = STEPS[currentStep];
  const state = stepStates[currentStep];
  const assistantResponse = state.messages.find(m => m.role === 'assistant')?.content || '';
  const canProceed = (assistantResponse || (currentStep === 6 && Object.keys(contentResults).length > 0)) && !state.streaming && !generatingTypes;
  const currentPhase = step.phase;
  const isFeedbackStep = FEEDBACK_STEPS.has(currentStep);
  const feedbackSourceResponse = isFeedbackStep
    ? stepStates[FEEDBACK_SOURCE[currentStep]]?.messages?.find(m => m.role === 'assistant')?.content || ''
    : '';

  // ── Loading state ──────────────────────────────────────────────────────

  if (!isHydrated) {
    return (
      <div className="min-h-screen bg-amber-50 flex items-center justify-center font-mono">
        <div className="text-lg font-bold animate-pulse">Loading...</div>
      </div>
    );
  }

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-amber-50 text-black font-mono">
      {/* Header */}
      <header className="border-b-4 border-black p-6">
        <div className="max-w-6xl mx-auto flex justify-between items-start">
          <div>
            <h1 className="text-3xl font-black uppercase tracking-tight">Voice Template Builder</h1>
            <p className="text-sm mt-1 opacity-70">
              Create your AI voice template in 4 phases
              {activeTemplateName && <span className="ml-2 bg-black text-white px-2 py-0.5 text-xs">{activeTemplateName}</span>}
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setShowImportPaste(!showImportPaste)}
              className="border-2 border-purple-600 text-purple-600 px-4 py-2 text-sm font-bold hover:bg-purple-600 hover:text-white transition-colors"
            >
              Import Template
            </button>
            <input
              ref={importFileRef}
              type="file"
              accept=".md,.txt"
              onChange={handleFileImport}
              className="hidden"
            />
            <button
              onClick={() => setShowLibrary(!showLibrary)}
              className="border-2 border-black px-4 py-2 text-sm font-bold hover:bg-black hover:text-white transition-colors"
            >
              Library ({savedTemplates.length})
            </button>
            <button
              onClick={resetAll}
              className="border-2 border-red-600 text-red-600 px-4 py-2 text-sm font-bold hover:bg-red-600 hover:text-white transition-colors"
            >
              Start Over
            </button>
          </div>
        </div>
      </header>

      <div className="max-w-6xl mx-auto p-6">
        {/* Template Library Panel */}
        {showLibrary && (
          <div className="border-4 border-black bg-white shadow-brutal-lg mb-8 p-4">
            <h2 className="font-black text-lg mb-4">Template Library</h2>
            {savedTemplates.length === 0 ? (
              <p className="text-sm opacity-60">No saved templates yet. Complete Phase 3 to save one.</p>
            ) : (
              <div className="space-y-3">
                {savedTemplates.map(t => (
                  <div key={t.id} className="border-2 border-black p-3 flex justify-between items-start">
                    <div className="flex-1 min-w-0">
                      <div className="font-bold">{t.name}</div>
                      <div className="text-xs opacity-50">{new Date(t.updatedAt).toLocaleDateString()}</div>
                      <div className="text-xs mt-1 truncate opacity-70">{t.template.substring(0, 120)}...</div>
                    </div>
                    <div className="flex gap-2 ml-4 shrink-0">
                      <button onClick={() => loadFromLibrary(t)} className="border border-black px-3 py-1 text-xs font-bold hover:bg-black hover:text-white transition-colors">Load</button>
                      <button onClick={() => deleteFromLibrary(t.id)} className="border border-red-600 text-red-600 px-3 py-1 text-xs font-bold hover:bg-red-600 hover:text-white transition-colors">Delete</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Import Template Panel */}
        {showImportPaste && (
          <div className="border-4 border-purple-600 bg-white shadow-brutal-lg mb-8 p-4">
            <h2 className="font-black text-lg mb-2">Import Voice Template</h2>
            <p className="text-sm mb-4 opacity-70">Upload a .md file or paste your template below. You&apos;ll jump straight to testing &amp; refinement.</p>
            <div className="flex gap-4 mb-4">
              <button
                onClick={() => importFileRef.current?.click()}
                className="border-2 border-black px-6 py-3 font-bold hover:bg-black hover:text-white transition-colors"
              >
                Upload .md file
              </button>
              <span className="self-center text-sm font-bold opacity-50">or paste below:</span>
            </div>
            <textarea
              value={importPasteText}
              onChange={e => setImportPasteText(e.target.value)}
              placeholder="Paste your voice template markdown here..."
              rows={8}
              className="w-full border-2 border-black p-3 font-mono text-sm resize-y mb-3"
            />
            <div className="flex gap-2">
              <button
                onClick={() => {
                  if (!importPasteText.trim()) return;
                  applyImportedTemplate(importPasteText.trim(), 'Imported Template');
                }}
                disabled={!importPasteText.trim()}
                className="border-2 border-black px-6 py-2 font-bold bg-purple-300 hover:bg-purple-400 disabled:opacity-30 transition-colors"
              >
                Import &amp; Start Testing
              </button>
              <button
                onClick={() => { setShowImportPaste(false); setImportPasteText(''); }}
                className="border-2 border-black px-4 py-2 font-bold text-sm hover:bg-black hover:text-white transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Settings bar */}
        <div className="border-4 border-black p-4 mb-8 bg-white shadow-brutal">
          <div className="flex flex-wrap gap-4 items-end">
            <div>
              <label className="block text-xs font-bold uppercase mb-1">Provider</label>
              <select
                value={provider}
                onChange={e => { const p = e.target.value as Provider; setProvider(p); saveSettings(p, apiKey); }}
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
                  onChange={e => { setApiKey(e.target.value); saveSettings(provider, e.target.value); }}
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
              <p className="text-xs mt-1 opacity-50">Stored in your browser only. Works in any language.</p>
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
                i === currentPhase ? 'bg-black text-white'
                : i < currentPhase ? 'bg-green-200'
                : 'bg-white hover:bg-gray-100'
              }`}
            >
              <div className="text-xs font-bold uppercase">{phase.title}</div>
              <div className="text-xs mt-0.5 truncate">{phase.subtitle}</div>
            </button>
          ))}
        </div>

        {/* Current step — with split-pane for feedback steps */}
        <div className={`mb-6 ${isFeedbackStep ? 'flex gap-4 flex-col md:flex-row' : ''}`}>
          {/* Left pane: previous response (feedback steps only) */}
          {isFeedbackStep && feedbackSourceResponse && (
            <div className="md:w-[60%] border-4 border-black bg-white shadow-brutal mb-4 md:mb-0">
              <div className="border-b-4 border-black p-3 bg-blue-100">
                <label className="text-xs font-bold uppercase">Generated Content (review this)</label>
              </div>
              <div className="p-4 max-h-[70vh] overflow-y-auto">
                <Md>{feedbackSourceResponse}</Md>
              </div>
            </div>
          )}

          {/* Main step panel */}
          <div className={`border-4 border-black bg-white shadow-brutal-lg ${isFeedbackStep && feedbackSourceResponse ? 'md:w-[40%]' : 'w-full'}`}>
            {/* Step header */}
            <div className="border-b-4 border-black p-4 bg-yellow-200">
              <h2 className="font-black text-xl">{step.title}</h2>
              <p className="text-sm mt-1">{step.instructions}</p>
            </div>

            {/* Writing samples manager (step 2.2) */}
            {currentStep === 4 ? (
              <div className="p-4 border-b-2 border-black bg-blue-50">
                <label className="block text-xs font-bold uppercase mb-2">
                  Writing Samples
                  <span className={`ml-2 px-2 py-0.5 text-xs ${
                    writingSamples.length >= 3 ? 'bg-green-300' : writingSamples.length > 0 ? 'bg-yellow-300' : 'bg-red-300'
                  }`}>
                    {writingSamples.length} of 3-5
                  </span>
                </label>

                {writingSamples.map((sample, i) => (
                  <div key={i} className="border-2 border-black p-2 mb-2 flex justify-between items-start bg-white">
                    <div className="text-xs flex-1 truncate mr-2">
                      <span className="font-bold">Sample {i + 1}:</span> {sample.substring(0, 150)}...
                    </div>
                    <button
                      onClick={() => setWritingSamples(prev => prev.filter((_, j) => j !== i))}
                      className="text-red-600 font-bold text-sm px-2 hover:bg-red-600 hover:text-white transition-colors"
                    >
                      X
                    </button>
                  </div>
                ))}

                <textarea
                  value={sampleDraft}
                  onChange={e => setSampleDraft(e.target.value)}
                  placeholder="Paste one writing sample here..."
                  rows={5}
                  className="w-full border-2 border-black p-3 font-mono text-sm resize-y mb-2"
                />
                <button
                  onClick={() => {
                    if (!sampleDraft.trim()) return;
                    setWritingSamples(prev => [...prev, sampleDraft.trim()]);
                    setSampleDraft('');
                  }}
                  disabled={!sampleDraft.trim()}
                  className="border-2 border-black px-4 py-2 font-bold text-sm disabled:opacity-30 hover:bg-black hover:text-white transition-colors"
                >
                  + Add Sample
                </button>
              </div>
            ) : step.userInputLabel && (
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
                  rows={3}
                  className="w-full border-2 border-black p-3 font-mono text-sm resize-y"
                />
              </div>
            )}

            {/* Content type selector (step 4.1) */}
            {currentStep === 6 && (
              <div className="p-4 border-b-2 border-black bg-purple-50">
                <label className="block text-xs font-bold uppercase mb-2">Content Types to Generate</label>
                <div className="flex flex-wrap gap-2">
                  {CONTENT_TYPES.map(type => (
                    <label key={type.id} className="flex items-center gap-1 text-sm cursor-pointer">
                      <input
                        type="checkbox"
                        checked={selectedTypes.includes(type.id)}
                        onChange={e => {
                          setSelectedTypes(prev =>
                            e.target.checked ? [...prev, type.id] : prev.filter(t => t !== type.id)
                          );
                        }}
                        className="w-4 h-4"
                      />
                      {type.label}
                    </label>
                  ))}
                </div>
              </div>
            )}

            {/* Run button */}
            <div className="p-4 border-b-2 border-black">
              <button
                onClick={currentStep === 6 ? generateContentTypes : runStep}
                disabled={state.streaming || generatingTypes || (currentStep === 4 && writingSamples.length === 0)}
                className={`w-full border-4 border-black p-4 font-black text-lg uppercase tracking-wider transition-all ${
                  state.streaming || generatingTypes
                    ? 'bg-gray-300 cursor-wait animate-pulse'
                    : 'bg-green-400 hover:bg-green-500 shadow-brutal-sm hover:shadow-brutal active:shadow-none active:translate-x-1 active:translate-y-1'
                }`}
              >
                {state.streaming || generatingTypes ? 'Generating...' : currentStep === 6 ? 'Generate All Selected' : `Run Step ${step.title.split(' ')[0]}`}
              </button>
            </div>

            {/* Content type results (step 4.1) — tabbed */}
            {currentStep === 6 && Object.keys(contentResults).length > 0 && (
              <div className="p-4" ref={responseRef}>
                <div className="flex border-b-2 border-black mb-3">
                  {CONTENT_TYPES.filter(t => selectedTypes.includes(t.id)).map(type => (
                    <button
                      key={type.id}
                      onClick={() => setActiveTab(type.id)}
                      className={`px-4 py-2 text-xs font-bold uppercase border-2 border-black border-b-0 -mb-[2px] transition-colors ${
                        activeTab === type.id ? 'bg-black text-white' : 'bg-white hover:bg-gray-100'
                      }`}
                    >
                      {type.label}
                    </button>
                  ))}
                </div>
                <div className="border-2 border-black p-4 bg-gray-50 max-h-96 overflow-y-auto">
                  <Md>{contentResults[activeTab] || '(generating...)'}</Md>
                </div>
              </div>
            )}

            {/* AI response thread (non-content-type steps) */}
            {currentStep !== 6 && assistantResponse && (
              <div className="p-4" ref={responseRef}>
                <div className="flex justify-between items-center mb-2">
                  <label className="text-xs font-bold uppercase">
                    Conversation {state.streaming && <span className="animate-pulse">●</span>}
                  </label>
                  <button
                    onClick={() => copyText(assistantResponse, 'response')}
                    className="text-xs border border-black px-2 py-0.5 hover:bg-black hover:text-white transition-colors"
                  >
                    {copied === 'response' ? 'Copied!' : 'Copy Last'}
                  </button>
                </div>
                <div className="border-2 border-black bg-gray-50 max-h-[28rem] overflow-y-auto">
                  {state.messages.map((msg, i) => (
                    <div key={i} className={`p-3 ${i > 0 ? 'border-t border-gray-300' : ''} ${msg.role === 'user' ? 'bg-blue-50' : 'bg-gray-50'}`}>
                      <div className="text-[10px] font-bold uppercase mb-1 opacity-50">
                        {msg.role === 'user' ? 'You' : 'AI'}
                      </div>
                      <div className="text-sm">
                        <Md>{msg.content}</Md>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Follow-up input */}
                {!state.streaming && (
                  <div className="mt-3 flex gap-2">
                    <textarea
                      value={followUpText}
                      onChange={e => setFollowUpText(e.target.value)}
                      placeholder="Continue the conversation... ask a follow-up or give more feedback"
                      rows={2}
                      className="flex-1 border-2 border-black p-2 font-mono text-sm resize-y"
                      onKeyDown={e => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          sendFollowUp();
                        }
                      }}
                    />
                    <button
                      onClick={sendFollowUp}
                      disabled={!followUpText.trim()}
                      className="border-2 border-black px-4 py-2 font-bold text-sm self-end disabled:opacity-30 hover:bg-black hover:text-white transition-colors"
                    >
                      Send
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
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
          <span className="text-sm font-bold">Step {currentStep + 1} of {STEPS.length}</span>
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
              <div className="flex justify-between items-center flex-wrap gap-2">
                <h2 className="font-black text-xl">Your Voice Template</h2>
                <div className="flex gap-2 flex-wrap">
                  <button onClick={() => copyText(finalTemplate, 'raw')} className="border-2 border-black px-3 py-1 bg-white text-sm font-bold hover:bg-black hover:text-white transition-colors">
                    {copied === 'raw' ? 'Copied!' : 'Copy Raw'}
                  </button>
                  <button onClick={() => { copyFormatted(finalTemplate); setCopied('formatted'); setTimeout(() => setCopied(''), 2000); }} className="border-2 border-black px-3 py-1 bg-white text-sm font-bold hover:bg-black hover:text-white transition-colors">
                    {copied === 'formatted' ? 'Copied!' : 'Copy Formatted'}
                  </button>
                  <button onClick={() => downloadFile(finalTemplate, `${activeTemplateName || 'voice-template'}.md`, 'text/markdown')} className="border-2 border-black px-3 py-1 bg-white text-sm font-bold hover:bg-black hover:text-white transition-colors">
                    Download .md
                  </button>
                </div>
              </div>
              <div className="flex items-center gap-2 mt-2">
                {showSaveInput ? (
                  <div className="flex gap-2 flex-1">
                    <input
                      value={saveNameInput}
                      onChange={e => setSaveNameInput(e.target.value)}
                      placeholder="Template name..."
                      className="border-2 border-black px-3 py-1 text-sm font-mono flex-1"
                      autoFocus
                      onKeyDown={e => e.key === 'Enter' && saveToLibrary()}
                    />
                    <button onClick={saveToLibrary} className="border-2 border-black px-3 py-1 text-sm font-bold bg-white hover:bg-black hover:text-white transition-colors">Save</button>
                    <button onClick={() => setShowSaveInput(false)} className="border-2 border-black px-3 py-1 text-sm font-bold hover:bg-black hover:text-white transition-colors">Cancel</button>
                  </div>
                ) : (
                  <button onClick={() => setShowSaveInput(true)} className="text-sm font-bold underline">Save to Library</button>
                )}
              </div>
            </div>
            <div className="p-4 max-h-96 overflow-y-auto">
              <Md>{finalTemplate}</Md>
            </div>
          </div>
        )}

        {/* Refinement Loop */}
        {finalTemplate && !refinementMode && (
          <div className="text-center mb-8">
            <button
              onClick={() => { setRefinementMode(true); setRefinementPosts([]); }}
              className="border-4 border-black px-8 py-4 font-black uppercase bg-purple-300 hover:bg-purple-400 shadow-brutal-sm hover:shadow-brutal transition-all"
            >
              Start Refinement Loop
            </button>
            <p className="text-xs mt-2 opacity-60">Generate test posts, review, and iteratively refine your template</p>
          </div>
        )}

        {refinementMode && (
          <div className="border-4 border-black bg-purple-50 shadow-brutal-lg mb-8">
            <div className="border-b-4 border-black p-4 bg-purple-200 flex justify-between items-center">
              <h2 className="font-black text-xl">Refinement Loop</h2>
              <button onClick={() => setRefinementMode(false)} className="border-2 border-black px-4 py-1 text-sm font-bold hover:bg-black hover:text-white transition-colors">
                Done Refining
              </button>
            </div>

            <div className="flex flex-col md:flex-row gap-4 p-4">
              {/* Left: generated posts */}
              <div className="md:w-[60%]">
                <button
                  onClick={generateRefinementPosts}
                  disabled={refining}
                  className={`w-full border-4 border-black p-3 font-black uppercase mb-4 transition-all ${
                    refining ? 'bg-gray-300 animate-pulse' : 'bg-green-400 hover:bg-green-500 shadow-brutal-sm'
                  }`}
                >
                  {refining ? 'Generating...' : refinementPosts.length > 0 ? 'Regenerate 3 Posts' : 'Generate 3 Test Posts'}
                </button>
                {refinementPosts.map((post, i) => (
                  <div key={i} className="border-2 border-black p-3 mb-3 bg-white max-h-60 overflow-y-auto">
                    <div className="text-xs font-bold uppercase mb-2 opacity-60">Post {i + 1}</div>
                    <Md>{post}</Md>
                  </div>
                ))}
              </div>

              {/* Right: feedback */}
              <div className="md:w-[40%]">
                <label className="block text-xs font-bold uppercase mb-2">Your Feedback</label>
                <textarea
                  value={refinementFeedback}
                  onChange={e => setRefinementFeedback(e.target.value)}
                  placeholder="What needs to change? Be specific..."
                  rows={6}
                  className="w-full border-2 border-black p-3 font-mono text-sm resize-y mb-3"
                />
                <button
                  onClick={refineTemplate}
                  disabled={refining || !refinementFeedback.trim()}
                  className={`w-full border-4 border-black p-3 font-black uppercase transition-all ${
                    refining ? 'bg-gray-300 animate-pulse' : 'bg-yellow-300 hover:bg-yellow-400 shadow-brutal-sm disabled:opacity-30'
                  }`}
                >
                  {refining ? 'Refining...' : 'Refine Template'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
