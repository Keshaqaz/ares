// Builds the Homebrew release: the archive for the GitHub Release and the formula for the tap.
// The archive is `npm pack` of this package: `prepack` builds dist/worker.mjs and
// bundleDependencies put libsodium inside, so `brew install` needs no npm and no network.
// Release steps: docs/releasing.md.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import pkg from '../package.json' with { type: 'json' };

const root = fileURLToPath(new URL('..', import.meta.url));
const REPOSITORY = 'https://github.com/Keshaqaz/ares';

// The name `npm pack` gives the archive; the release asset keeps it.
export const archiveName = version => `codex-auto-resets-${version}.tgz`;
export const releaseUrl = version => `${REPOSITORY}/releases/download/v${version}/${archiveName(version)}`;

export function formula({ version, sha256 }) {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) throw new RangeError(`invalid version: ${version}`);
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new RangeError(`invalid sha256: ${sha256}`);
  return `class CodexAutoResets < Formula
  desc "Applies issued ChatGPT Codex resets from your own GitHub Actions worker"
  homepage "${REPOSITORY}"
  url "${releaseUrl(version)}"
  sha256 "${sha256}"
  license "MIT"

  depends_on "node"

  def install
    libexec.install Dir["*"]
    (bin/"codex-auto-resets").write <<~SH
      #!/bin/bash
      exec "#{formula_opt_bin("node")}/node" "#{libexec}/src/cli/main.mjs" "$@"
    SH
  end

  test do
    assert_equal version.to_s, shell_output("#{bin}/codex-auto-resets --version").strip
  end
end
`;
}

export async function packRelease(destination) {
  await promisify(execFile)('npm', ['pack', '--pack-destination', destination], { cwd: root });
  const file = join(destination, archiveName(pkg.version));
  return { file, sha256: createHash('sha256').update(await readFile(file)).digest('hex') };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dist = join(root, 'dist');
  await mkdir(dist, { recursive: true });
  const { file, sha256 } = await packRelease(dist);
  const formulaFile = join(dist, 'codex-auto-resets.rb');
  await writeFile(formulaFile, formula({ version: pkg.version, sha256 }));
  console.log(`${file}\n${formulaFile}\nsha256 ${sha256}`);
}
