import { app } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

type VoiceEvent = { type: 'partial' | 'commit' | 'final'; text: string };

let whisperProcess: ChildProcessWithoutNullStreams | null = null;
let listener: ((event: VoiceEvent) => void) | null = null;

async function existing(paths: string[]) {
  for (const candidate of paths) {
    try { await fs.access(candidate); return candidate; } catch { /* try next */ }
  }
  return null;
}

function writeMarker(marker: number) {
  if (!whisperProcess?.stdin.writable) throw new Error('Whisper 流式服务不可用');
  const packet = Buffer.allocUnsafe(4);
  packet.writeUInt32LE(marker);
  whisperProcess.stdin.write(packet);
}

export async function startVoiceStream(nextListener: (event: VoiceEvent) => void) {
  const root = await existing([
    process.env.SHUDING_WHISPER_DIR ?? '',
    path.join(process.resourcesPath, 'whisper'),
    path.join(app.getAppPath(), 'resources', 'whisper'),
    path.join(process.cwd(), 'resources', 'whisper')
  ]);
  if (!root) throw new Error('Whisper 语音模型未安装');
  const binary = path.join(root, 'whisper-stream');
  const model = path.join(root, 'ggml-large-v3-turbo-q8_0.bin');
  try { await Promise.all([fs.access(binary), fs.access(model)]); } catch { throw new Error('Whisper CUDA 流式运行时或 Q8 模型未安装'); }
  listener = nextListener;
  if (!whisperProcess || whisperProcess.killed) {
    whisperProcess = spawn(binary, [model], { cwd: root, env: { ...process.env, LD_LIBRARY_PATH: root }, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    whisperProcess.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as VoiceEvent;
          if ((event.type === 'partial' || event.type === 'commit' || event.type === 'final') && typeof event.text === 'string') listener?.(event);
        } catch { /* sidecar diagnostics are ignored */ }
      }
    });
    whisperProcess.stderr.on('data', (chunk: Buffer) => console.warn(`[whisper] ${chunk.toString().trim()}`));
    whisperProcess.once('exit', () => { whisperProcess = null; listener = null; });
  }
  writeMarker(0);
}

export function pushVoiceAudio(audio: ArrayBuffer) {
  if (!(audio instanceof ArrayBuffer) || audio.byteLength === 0 || audio.byteLength % 4 !== 0) throw new Error('无效的 PCM 音频帧');
  const count = audio.byteLength / 4;
  if (count > 16000 * 10) throw new Error('PCM 音频帧过大');
  if (!whisperProcess?.stdin.writable) throw new Error('Whisper 流式服务不可用');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(count);
  whisperProcess.stdin.write(header);
  whisperProcess.stdin.write(Buffer.from(audio));
}

export function stopVoiceStream() {
  writeMarker(0xffffffff);
}

export function stopVoiceService() {
  whisperProcess?.kill();
  whisperProcess = null;
  listener = null;
}
