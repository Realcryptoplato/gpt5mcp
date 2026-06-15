// GPT-5 via the Codex CLI (ChatGPT auth) — NOT the OpenAI REST API.
//
// We shell out to `codex exec` instead of calling api.openai.com directly:
//   - No OPENAI_API_KEY needed (codex uses the logged-in ChatGPT account).
//   - Defaults to gpt-5.5.
// The `-o <file>` flag writes ONLY the model's final message to a file, which
// we read back as the clean response (stdout also carries codex's own logs).
//
// Invocation:  codex exec -m <model> --skip-git-repo-check -o <tmp> "<prompt>"

import { spawn } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const DEFAULT_MODEL = 'gpt-5.5';
const CODEX_TIMEOUT_MS = 180_000; // 3 min — codex reasoning can be slow

export interface GPT5Options {
  model?: string;
  instructions?: string;
  reasoning_effort?: 'low' | 'medium' | 'high';
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  tools?: Array<{ type: string; [key: string]: any }>;
}

type ChatMessage = {
  role: 'user' | 'developer' | 'assistant';
  content: string | Array<{ type: string; text?: string; [k: string]: any }>;
};

/** Flatten a content value (string or block array) to plain text. */
function flatten(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  return content.map(b => (typeof b === 'string' ? b : b.text || '')).join('\n');
}

/** Render a system prompt + optional message history into one Codex prompt. */
function renderPrompt(body: string, options: GPT5Options): string {
  const parts: string[] = [];
  if (options.instructions) {
    parts.push(`[System instructions]\n${options.instructions}`);
  }
  if (options.reasoning_effort) {
    parts.push(`[Reasoning effort: ${options.reasoning_effort}]`);
  }
  parts.push(body);
  return parts.join('\n\n');
}

/** Run codex exec with the given prompt; resolve with the final message text. */
function runCodex(prompt: string, model: string): Promise<{ content: string; usage?: any }> {
  return new Promise((resolve, reject) => {
    const dir = mkdtempSync(join(tmpdir(), 'gpt5mcp-'));
    const outFile = join(dir, 'last-message.txt');
    const args = [
      'exec',
      '-m', model,
      '--skip-git-repo-check',
      '--sandbox', 'read-only',
      '-o', outFile,
      prompt,
    ];

    console.error('Calling Codex:', JSON.stringify({ command: 'codex', model }));

    const child = spawn('codex', args, {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stdout?.on('data', () => { /* codex logs; the answer is in outFile */ });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      cleanup(dir);
      reject(new Error('Codex CLI timed out (3 minutes)'));
    }, CODEX_TIMEOUT_MS);

    child.on('error', (err) => {
      clearTimeout(timer);
      cleanup(dir);
      if ((err as any).code === 'ENOENT') {
        reject(new Error('Codex CLI not found. Install it and run `codex login`.'));
      } else {
        reject(new Error(`Codex CLI error: ${err.message}`));
      }
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      let content = '';
      try {
        content = readFileSync(outFile, 'utf8').trim();
      } catch {
        /* fall through to error handling below */
      }
      cleanup(dir);

      if (content) {
        resolve({ content });
      } else if (code === 0) {
        resolve({ content: '(Codex returned an empty response.)' });
      } else {
        const hint = /not logged in|login/i.test(stderr)
          ? ' (run `codex login`)'
          : '';
        reject(new Error(`Codex exec failed (exit ${code})${hint}: ${stderr.trim().slice(0, 400)}`));
      }
    });
  });
}

function cleanup(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

export async function callGPT5(
  _apiKey: string | undefined,
  input: string,
  options: GPT5Options = {}
): Promise<{ content: string; usage?: any }> {
  const model = options.model || DEFAULT_MODEL;
  return runCodex(renderPrompt(input, options), model);
}

export async function callGPT5WithMessages(
  _apiKey: string | undefined,
  messages: ChatMessage[],
  options: GPT5Options = {}
): Promise<{ content: string; usage?: any }> {
  const model = options.model || DEFAULT_MODEL;
  const transcript = messages
    .map(m => `${m.role.toUpperCase()}: ${flatten(m.content)}`)
    .join('\n\n');
  return runCodex(renderPrompt(transcript, options), model);
}

const IMAGE_TIMEOUT_MS = 240_000; // 4 min — gpt-image gen via codex is slow

/**
 * Generate an image via the Codex CLI's built-in image tool (ChatGPT OAuth /
 * gpt-image). No image flag exists; we prompt the agent to save a PNG to an
 * exact path and read it back. Returns the saved absolute path on success.
 */
export async function generateImage(
  scene: string,
  outPath: string,
  aspect: string = '9:16'
): Promise<{ content: string; error?: string }> {
  const prompt =
    `Generate ONE cinematic ${aspect} image and SAVE it as a PNG to the EXACT absolute path:\n` +
    `${outPath}\n` +
    `Scene: ${scene}. Photorealistic unless the scene says otherwise. Absolutely no readable ` +
    `text, captions, watermarks, brand names, or logos anywhere in the image.\n` +
    `After saving, print the absolute path of the saved file on its own line.`;

  console.error('Calling Codex (image):', JSON.stringify({ outPath, aspect }));

  return new Promise((resolve) => {
    // codex exec ... -  (prompt via stdin); bypass approvals/sandbox so the
    // agent can write the file. service_tier=fast keeps it responsive.
    const child = spawn(
      'codex',
      [
        'exec',
        '--skip-git-repo-check',
        '-c', 'service_tier=fast',
        '--dangerously-bypass-approvals-and-sandbox',
        '-',
      ],
      { env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] }
    );

    let stderr = '';
    child.stdout?.on('data', () => { /* codex logs; result is the saved file */ });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({ content: 'Codex image generation timed out (4 minutes)', error: 'timeout' });
    }, IMAGE_TIMEOUT_MS);

    child.on('error', (err) => {
      clearTimeout(timer);
      const msg = (err as any).code === 'ENOENT'
        ? 'Codex CLI not found. Install it and run `codex login`.'
        : `Codex CLI error: ${err.message}`;
      resolve({ content: msg, error: 'spawn_error' });
    });

    child.on('close', () => {
      clearTimeout(timer);
      if (existsSync(outPath)) {
        const bytes = statSync(outPath).size;
        resolve({ content: `Image saved: ${outPath} (${bytes} bytes)` });
      } else {
        const hint = /not logged in|login/i.test(stderr) ? ' (run `codex login`)' : '';
        resolve({
          content: `Codex produced no image file at ${outPath}${hint}.` +
            (stderr.trim() ? `\nLog tail: ${stderr.trim().slice(-400)}` : ''),
          error: 'no_output',
        });
      }
    });

    child.stdin?.write(prompt);
    child.stdin?.end();
  });
}
