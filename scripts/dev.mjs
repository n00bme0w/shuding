import { spawn } from 'node:child_process';
import readline from 'node:readline';

const env = {
  ...process.env,
  FONTCONFIG_FILE: `${process.cwd()}/fontconfig/fonts.conf`,
  FONTCONFIG_PATH: `${process.cwd()}/fontconfig`
};

const child = spawn('npx', ['electron-vite', 'dev'], {
  env,
  stdio: ['inherit', 'inherit', 'pipe']
});

const rl = readline.createInterface({ input: child.stderr });
rl.on('line', (line) => {
  const isFontconfigWarning = line.startsWith('Fontconfig');
  const isKnownGlibWarning = line.includes('GLib-GObject:') && line.includes('has no handler with id');
  if (!isFontconfigWarning && !isKnownGlibWarning) {
    process.stderr.write(`${line}\n`);
  }
});

child.on('close', (code, signal) => {
  rl.close();
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});
