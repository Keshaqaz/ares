import { execFile } from 'node:child_process';

// Opens a page in the user's default browser. The CLI prints the address too, so a failure
// here leaves the user a way on.
export type OpenUrl = (url: string) => Promise<void>;
export const openInBrowser: OpenUrl = url => new Promise(resolve => {
  execFile('/usr/bin/open', [url], { timeout: 30_000 }, () => resolve());
});

// Puts text on the clipboard with pbcopy, the text going in through stdin. Resolves to whether
// it worked; the CLI prints what it copies too, so a failure here leaves the user a way on.
export type CopyText = (text: string) => Promise<boolean>;
export const copyToClipboard: CopyText = text => new Promise(resolve => {
  const child = execFile('/usr/bin/pbcopy', { timeout: 10_000 }, error => resolve(!error));
  child.stdin?.on('error', () => {});
  child.stdin?.end(text);
});
