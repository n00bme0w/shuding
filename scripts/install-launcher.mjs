import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const homeDir = os.homedir();
const binDir = path.join(homeDir, '.local', 'bin');
const applicationsDir = path.join(
  process.env.XDG_DATA_HOME || path.join(homeDir, '.local', 'share'),
  'applications',
);
const commandPath = path.join(binDir, 'shuding');
const desktopPath = path.join(applicationsDir, 'shuding-dev.desktop');
const execFileAsync = promisify(execFile);

if (process.argv.includes('--uninstall')) {
  await Promise.all([
    rm(commandPath, { force: true }),
    rm(desktopPath, { force: true }),
  ]);
  console.log('Removed shuding command and desktop launcher.');
  process.exit(0);
}

await mkdir(binDir, { recursive: true });
await mkdir(applicationsDir, { recursive: true });

const launcherScript = `#!/usr/bin/env bash
set -euo pipefail

cd ${shellQuote(projectDir)}

if [[ \${1:-} == --background ]]; then
  shift
  log_dir=\"\${XDG_CACHE_HOME:-\$HOME/.cache}/shuding\"
  mkdir -p \"\$log_dir\"
  if command -v fnm >/dev/null 2>&1; then
    runner=(fnm exec --using=22.20.0 npm run dev \"\$@\")
  else
    runner=(npm run dev \"\$@\")
  fi
  if command -v setsid >/dev/null 2>&1; then
    setsid \"\${runner[@]}\" </dev/null >>\"\$log_dir/dev.log\" 2>&1 &
  else
    nohup \"\${runner[@]}\" </dev/null >>\"\$log_dir/dev.log\" 2>&1 &
  fi
  exit 0
fi

# Use the project's development Node version when fnm is available. The
# fallback keeps the launcher usable on machines that use system Node.
if command -v fnm >/dev/null 2>&1; then
  exec fnm exec --using=22.20.0 npm run dev "$@"
fi

exec npm run dev "$@"
`;

const desktopEntry = `[Desktop Entry]
Type=Application
Name=Shuding (Dev)
Comment=Start the Shuding development app
Exec=${desktopQuote(commandPath)} --background
TryExec=${desktopQuote(commandPath)}
Path=${projectDir}
Icon=applications-development
Terminal=false
Categories=Development;
StartupWMClass=shuding
`;

await writeFile(commandPath, launcherScript, { mode: 0o755 });
await chmod(commandPath, 0o755);
await writeFile(desktopPath, desktopEntry, { mode: 0o644 });
await chmod(desktopPath, 0o755);
try {
  await execFileAsync('update-desktop-database', [applicationsDir]);
} catch {
  // The desktop database helper is optional; launchers can scan the file directly.
}

console.log(`Installed command: ${commandPath}`);
console.log(`Installed desktop launcher: ${desktopPath}`);
console.log('Run `shuding` from any terminal, or start “Shuding (Dev)” from your application launcher.');

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function desktopQuote(value) {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}
