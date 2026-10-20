import { execFile } from 'node:child_process';

// Opens a page in the user's default browser. The CLI prints the address too, so a failure
// here leaves the user a way on.
export type OpenUrl = (url: string) => Promise<void>;
export const openInBrowser: OpenUrl = url => new Promise(resolve => {
  execFile('/usr/bin/open', [url], { timeout: 30_000 }, () => resolve());
});
