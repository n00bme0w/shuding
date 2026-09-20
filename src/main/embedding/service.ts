import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';

type EmbeddingResponse = { data?: Array<{ embedding?: number[] }> };

const DEFAULT_PORT = 18_734;
const HEALTH_TIMEOUT_MS = 15_000;

let server: ChildProcess | null = null;
let serverPort = DEFAULT_PORT;
let stopping = false;

function platformBinaryName() {
  return process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
}

function resourceRoots() {
  const roots = [
    path.join(process.resourcesPath, 'llama'),
    path.join(app.getAppPath(), 'resources', 'llama'),
    path.join(process.cwd(), 'resources', 'llama')
  ];
  return Array.from(new Set(roots));
}

async function firstExisting(paths: string[]) {
  for (const candidate of paths) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Continue searching the platform-specific resource locations.
    }
  }
  return null;
}

function embeddingUrl(pathname: string) {
  return `http://127.0.0.1:${serverPort}${pathname}`;
}

async function waitForHealth() {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(embeddingUrl('/health'));
      if (response.ok) return true;
    } catch {
      // The process may still be loading the model.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

export async function startEmbeddingService() {
  if (server && !server.killed) return true;
  stopping = false;
  const roots = resourceRoots();
  const binary = process.env.SHUDING_LLAMA_SERVER ?? await firstExisting(roots.map((root) => path.join(root, platformBinaryName())));
  const model = process.env.SHUDING_BGE_M3_MODEL ?? await firstExisting(roots.map((root) => path.join(root, 'bge-m3.gguf')));
  if (!binary || !model) {
    console.warn('[embedding] llama-server or bge-m3.gguf is not bundled; semantic search is unavailable.');
    return false;
  }

  serverPort = Number(process.env.SHUDING_LLAMA_PORT ?? DEFAULT_PORT);
  const environment = { ...process.env };
  if (process.platform !== 'win32') {
    environment.LD_LIBRARY_PATH = [path.dirname(binary), environment.LD_LIBRARY_PATH].filter(Boolean).join(':');
  }
  server = spawn(binary, [
    '--model', model,
    '--embedding',
    '--pooling', 'mean',
    '--host', '127.0.0.1',
    '--port', String(serverPort),
    '--ctx-size', '2048'
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: environment });
  server.stderr?.on('data', (chunk: Buffer) => {
    if (!stopping) console.warn(`[embedding] ${chunk.toString().trim()}`);
  });
  server.once('exit', () => { server = null; });
  const healthy = await waitForHealth();
  if (!healthy) {
    await stopEmbeddingService();
    console.warn('[embedding] llama-server did not become healthy.');
    return false;
  }
  console.log(`[embedding] llama-server ready on ${embeddingUrl('')}`);
  return true;
}

export async function embedTexts(texts: string[]) {
  if (texts.length === 0) return [] as number[][];
  if (!server || server.killed) throw new Error('Local embedding service is unavailable');
  const response = await fetch(embeddingUrl('/v1/embeddings'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'bge-m3', input: texts })
  });
  if (!response.ok) throw new Error(`Embedding request failed (${response.status})`);
  const payload = await response.json() as EmbeddingResponse;
  const embeddings = payload.data?.map((item) => item.embedding).filter((item): item is number[] => Array.isArray(item)) ?? [];
  if (embeddings.length !== texts.length) throw new Error('Embedding response was incomplete');
  return embeddings;
}

export async function stopEmbeddingService() {
  if (!server) return;
  stopping = true;
  const child = server;
  server = null;
  child.kill();
  await new Promise<void>((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    child.once('exit', () => resolve());
    setTimeout(resolve, 1_000);
  });
}
