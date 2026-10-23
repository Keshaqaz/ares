# Installation and use

**English** · [Русский](installation.md)

The CLI speaks English. For Russian press `l` on the screen or run `aures language ru`.

## What you need

- A Mac. The worker itself runs in the cloud — on GitHub Actions or in Google Apps Script; the Mac is for commands and, if you want it, for watching the weekly limit (see [The Mac check](#the-mac-check)).
- A GitHub or Google account — the worker lives there. The free GitHub plan is enough; any Google account works.
- A paid ChatGPT subscription that issues rate-limit resets.

## Install

```sh
brew install keshaqaz/tap/aures
```

From source (Node 26 required):

```sh
git clone https://github.com/Keshaqaz/aures.git && cd aures
npm ci && npm run build:worker
echo "alias aures='node $PWD/src/cli/main.ts'" >> ~/.zshrc && source ~/.zshrc
```

The last line sets up the `aures` command this guide uses. Without it, run `node src/cli/main.ts` from the project folder.

## First setup

```sh
aures setup
```

`setup` starts by asking where the worker will run:

```
Where the worker will run:
  1. GitHub Actions — runs once an hour, but GitHub skips many runs; the before-expiry rule starts 8 hours ahead.
  2. Google Apps Script — runs every 5 minutes, the before-expiry rule starts 1 hour ahead. Installing it shows two «unverified app» warnings and needs one switch in the settings; the script project you delete yourself on uninstall.
Type 1 or 2: 
```

Both platforms are clouds in your own account, with no servers and nothing to pay. What else differs between them is in [What it costs](#what-it-costs). The choice is kept on this Mac; the commands work with the worker the same way wherever it runs.

### Installing on GitHub

<img src="assets/setup-en.png" alt="aures setup: GitHub and ChatGPT sign-in, rules, the Mac check and a trial run">

1. **GitHub sign-in.** Open the link, enter the code and allow access. The sign-in is kept in the Keychain, so you won't be asked again.
2. **Repository.** A private repository `codex-auto-resets-worker` appears in your account. The worker lives there.
3. **ChatGPT sign-in.** Open the link, enter the code and sign in to the account with the resets. This sign-in belongs to the worker alone: Codex on your computer keeps working as before.
4. **Rules.** Choose when resets are applied (see below). Enter keeps the defaults.
5. **ChatGPT sign-in for this Mac.** Only if the rule "When the weekly limit runs out" is on. Open the link and enter one more code, for the same ChatGPT account. The CLI installs a launchd agent that watches the weekly limit:

   ```
   Sign in to ChatGPT for this Mac: it notices the end of the weekly limit (Codex is not affected).
   Open https://auth.openai.com/codex/device and enter the code ABCD-12345
   The check from this Mac is on.
   ```

6. **Check.** The CLI makes a trial run of the worker: it reads the quotas and resets and tells what the rules would do, but applies no reset. The result:

   ```
   The worker works. Resets: 2, the nearest expires 22 October 2026 at 15:00 UTC. Nothing to apply now.
   ```

   If the rules want a reset applied right away, the line ends with «Now the rules would apply the reset RES67F8 (before expiry).» instead; the next scheduled run applies it.

If `setup` is interrupted, run it again: it picks up where it stopped and loses nothing.

### Installing on Google Apps Script

The CLI installs the worker right into your Google account: a script project `aures-worker` appears in it. The CLI opens every page that is needed and goes on by itself once you are done — there is nothing to copy. Before it starts, it warns about what Google will show:

```
Google will show «Google hasn't verified this app» twice: when aures signs in to Google and when you let the worker script run. Both the app and the script are yours, Google has just not reviewed them.
To go on, click «Advanced», then «Go to … (unsafe)».
```

1. **Google sign-in.** The CLI prints "Sign in to Google in the browser. On the consent page tick every box, or press «Select all»." and opens the sign-in page. Pick your account and pass the first «Google hasn't verified this app» screen: «Advanced» → «Go to … (unsafe)». On the consent page tick both boxes — "your Google Apps Script projects" and "deployments of your Google Apps Script projects" — or press «Select all». The browser shows "aures: signed in to Google, go back to the terminal", and the CLI goes on by itself. If a box is left unticked, the CLI names the access that is missing and repeats the sign-in.
2. **The Apps Script API switch.** While the API is off, Google refuses to deploy the worker. The CLI prints "Turn on the Apps Script API: https://script.google.com/home/usersettings", opens that page and explains: "On that page close the welcome dialog if it shows, open the line «Google Apps Script API» and click the switch. aures goes on by itself." You need the switch once; the CLI checks it every 5 seconds and continues by itself.
3. **The project and the web app.** The project `aures-worker` appears in your account; the CLI deploys its web app and prints "The worker is deployed: …". The web app's URL is kept on this Mac.
4. **The script's consent.** The CLI prints "Let the worker script run: …", opens the web app's URL and asks: "Pick your account, pass «Google hasn't verified this app» through «Advanced» and click «Allow». aures goes on by itself." This is the second «unverified app» screen. Pick the same account and allow — the page shows "done, go back to the terminal", and the CLI goes on by itself.
5. **Rules.** The same two rules as on GitHub, only the before-expiry window is the last hour: "1. Before expiry (in the last hour) — on".
6. **ChatGPT sign-in.** As on GitHub: open the link, enter the code and sign in to the account with the resets. This sign-in belongs to the worker alone; Codex on your computer keeps working as before.
7. **The schedule.** "The worker runs every 5 minutes."
8. **The check.** "Checking the worker…" — a trial run, as on GitHub: the worker reads the quotas and resets and tells what the rules would do, but applies no reset.

An interrupted `setup` can simply be run again: it goes on in the same project and adds only what is missing. If you deleted the project in Google, the CLI creates a new one.

## Rules

| Rule | Default | What it does |
| --- | --- | --- |
| Before expiry (on GitHub — the last 8 hours, on Google — the last hour) | on | Applies a reset when less than 8 hours are left before it expires on GitHub, or less than one hour on Google. |
| When the weekly limit runs out | off | As soon as the worker sees the weekly limit is used up, applies the reset that expires first. On Google the worker itself notices the end of the limit every 5 minutes, even with the Mac off; on GitHub, while the Mac is awake, the Mac check notices the end of the limit, and the reset comes within minutes. |

The rules cover all resets at once and work independently. Change them any time on the `aures` screen or with `aures rules`; new rules take effect from the next worker run. On GitHub, turning the weekly rule on asks for a ChatGPT code for this Mac, as in step 5 of setup; turning it off removes the Mac check but keeps the Mac's ChatGPT sign-in, so turning it on again asks for no code. On Google no Mac check is installed: the worker watches the limit itself.

On GitHub the worker runs about once an hour, but GitHub sometimes delays runs by several hours, so the rules don't fire at an exact minute. On Google the worker runs every 5 minutes, and the rules fire more precisely.

## The Mac check

The Mac check belongs to the worker on GitHub: the agent is installed when the worker runs there. On Google it is not needed — the worker itself reads the limit every 5 minutes, even with the Mac off.

While the rule "When the weekly limit runs out" is on (on GitHub), a launchd agent runs `aures watch` every 2 minutes. It is a short pass with no windows and no questions:

1. It reads the weekly limit with the Mac's own ChatGPT sign-in. This spends neither the limit nor tokens. While less than 80% is used, the limit is read every 10 minutes; closer to the end, on every pass.
2. If the limit has run out, it starts the worker through GitHub with the same GitHub sign-in from the Keychain that the commands use. If the limit is still out 15 minutes later, it starts the worker again, and once more an hour after that: at most three runs per weekly window. It does not repeat when the worker sees no resets at all.
3. It writes the outcome as one timestamped line to `~/Library/Logs/codex-auto-resets/watch.log`.

The Mac never applies a reset itself. The worker reads the limit again with its own sign-in and decides by the rules, so a mistake on the Mac never spends a reset. The end of the limit is seen whichever client used it up: Codex, opencode, your phone, another computer.

The check works only while the Mac is awake and you are logged in to your macOS account. The rest of the time, the worker's scheduled run notices the end of the limit.

The agent asks nothing and signs in nowhere. If the Mac's ChatGPT sign-in is lost, the pass is skipped, and `status` says what to do. If there is no GitHub sign-in, the pass is skipped too; any command asks you to sign in again.

Lines in `watch.log` (after the time of the pass):

| Line | Meaning |
| --- | --- |
| `idle` | The limit has not run out, or the worker was already started for this weekly window. |
| `quiet` | The pass did not read the limit: its end is far off, or every run for this window has been made. |
| `dispatched` | The limit ran out; the worker was started. |
| `dispatched (2 of 3)`, `dispatched (3 of 3)` | The limit still has not renewed; the worker was started again. |
| `no_resets` | The limit still has not renewed, but there are no resets; the worker is not started again for this window. |
| `transient_error: …` | ChatGPT did not answer this time; the next pass retries. If `transient_error: wham_429` keeps repeating, ChatGPT is throttling the polling, and the reset will come later. |
| `reauth_required…` | The Mac's ChatGPT sign-in is lost. Run `aures setup`. |
| `no_session` | The Mac has no ChatGPT sign-in. If the weekly rule is on, run `aures setup`. |
| `no_github_token`, `github_error: unauthorized` | The GitHub sign-in is missing from the Keychain, has expired, or the Keychain is locked. Any command, such as `aures status`, asks you to sign in again. |
| `no_worker`, `foreign_repository`, `dispatch_refused`, `github_error: …` | There is no worker repository, it was not created by the CLI or is public, the workflow is disabled, or GitHub did not answer. `aures status` shows the details. |
| `error: …` | An unexpected error in the pass; the next pass starts over. |

A line ending in `(watch.json not saved)` means the pass could not write `watch.json`.

## Day to day

Open the screen:

```sh
aures
```

<img src="assets/status-en.png" alt="The aures screen: resets on top, rules below">

The resets and their deadlines are on top, the general rules below, and under them a line about the worker: when it last ran and what it last applied. "applies soon" next to a reset means it is in its last 8 hours on GitHub or its last hour on Google, and the before-expiry rule will apply it.

- `↑` `↓` — pick a reset or a rule.
- `Enter` on a reset — apply it now. The screen asks to confirm; `y` is yes. The CLI waits for the worker and reports the result; on GitHub this can take a few minutes, on Google it takes seconds. A reset is single-use, and applying it cannot be undone.
- `Enter` on a rule — switch it on or off. On GitHub, turning the weekly rule on shows a ChatGPT code for this Mac, as in step 5 of setup.
- `Tab` — the «Worker» screen: the platform, the accounts, the actions and the journal of runs (see below).
- `l` — switch the language (EN · RU in the header); the choice is kept.
- `r` — refresh, `q` — quit.

If something is wrong, a line starting with `!` at the bottom says what to do. On GitHub, the weekly rule shows whether the Mac check works: "Mac check works" or "Mac check is not working". In the latter case the agent is not running or the Mac's ChatGPT sign-in is lost, and the `!` line says what to do.

`aures status` prints the same once, without the controls. `apply-now` and `rules` do what `Enter` on the screen does, with questions in the terminal.

With the worker on Google, the screen and the commands are the same, with a few differences:

- The worker line shows the next run ("worker works · next run expected in 3m"), and the bottom holds the link to the script project.
- The commands talk to the worker directly at its web app's URL with the secret from the Keychain — no Google sign-in is needed for them.
- If the worker lost its ChatGPT sign-in, `aures status` says so ("The worker lost its ChatGPT sign-in. Sign in again: `aures login`."), and Google also emails you about the failed trigger.
- On a new Mac (or with the CLI's files deleted) any command asks where the worker is: "This Mac does not know where the worker runs" and "Where to look? Type 1 or 2". Pick Google, open the project `aures-worker` on script.google.com and paste the link from the address bar.

### The «Worker» screen

`Tab` on the resets screen opens the «Worker» screen; one more `Tab` goes back. The header is the same, with four blocks under it; `↑` `↓` pick a line, `Enter` runs it, and `l`, `r` and `q` work as on the resets screen.

**«WORKER».** The platform («GitHub Actions» or «Google Apps Script») and its state: "active"; a paused worker shows a yellow "paused", and while a switch of platform is not finished, the red "no active worker: the switch is not finished". Below is the link to the repository or the script project.

**«ACCOUNTS».** Two lines, each with the action "sign in again" on the right:

- "GitHub" or "Google" — the platform account: the GitHub login or, on Google, the email if a sign-in gave it; when the account is unknown, it says so. "Sign in again" renews the CLI's sign-in to the platform; on GitHub it must be the account of the worker repository, otherwise aures puts the previous sign-in back and asks for the right one.
- "ChatGPT" — the worker's account and its state: "signed in" or "sign-in lost". "Sign in again" opens a new ChatGPT session for the worker, as `aures login`.

**«ACTIONS».** The cursor opens on the first action.

- "Check now" — a trial run: the worker reads the quotas and resets and tells what the rules would do, but applies nothing. On GitHub it is an Actions run; the action is marked "~1 min of Actions".
- "Repair" — puts this version of the worker onto its platform again; with the cursor on the action, the caption under it reads: "Deploy the current version of the worker again and bring its schedule back on this platform. The resets, the rules, the ChatGPT sign-in and the journal are not touched. Helps when the worker stopped running or its files were changed by hand". On a paused worker it does not bring the schedule back.
- "Pause" or "Unpause" — the one shown fits the state of the worker (see «Pause» below).
- "Switch to …" — moves the worker to the other platform, GitHub Actions or Google Apps Script (see «Switching platform» below); a paused worker does not have this action.

While a switch of platform is not finished there are no other actions, only "Retry the switch".

**«JOURNAL».** The worker's live journal: up to 12 entries, newest on top. Each says when the worker ran, what started the run ("scheduled", "from the Mac", "trial", "apply now", "sign-in"), how the run ended ("nothing to apply", "reset applied", "the outcome of the application is not known yet", "temporary error", "lost the ChatGPT sign-in", "the data does not read (…)" and the rest) and how long it took. The actions of this screen land in the journal too, as "aures · …" lines.

While the screen is open, aures polls the worker: every 30 seconds on Google, every minute on GitHub. The line above the journal says "polled 12:04:31, answered in 2.1 s"; when there was no answer — "polled …, no answer: …" — and the journal keeps what the last poll read. `Tab` back and leaving the screen stop the poll.

### Pause

"Pause" takes the worker's schedule off and touches nothing else: on GitHub the workflow is disabled, on Google the trigger is taken off. The ChatGPT session, the state and the rules stay on the platform, so "Unpause" brings the schedule back to the same worker with no new ChatGPT sign-in: "The worker is off pause: its schedule is back."

On pause there are no scheduled runs, so the rules do not work and resets can expire. The resets screen shows the line "worker is paused" with the warning "The worker is paused: resets are not applied and each burns at its activation deadline. «Apply now» still works." and marks the resets "burns". "Apply now" and "Check now" work on pause too: on GitHub aures enables the workflow for one run and disables it again, on Google the run needs no schedule. The Mac check does not wake a paused worker. "Repair" puts the new version in but does not bring the schedule back: "The worker is paused, its schedule stays off."

A paused worker has no "Switch to …" action: take it off pause first.

### Switching platform

On the screen «Worker» (`Tab`) the action "Switch to …" moves the worker to the other platform without a reinstall. Each step goes into the journal on the screen:

1. If the worker has an application of a reset with an unknown outcome, the switch refuses and says why: a new worker with a clean state could spend a second reset. Wait for the worker's next run.
2. The new worker is prepared without a schedule while the old one keeps working: the GitHub or Google sign-in, the code of this version, the general rules, and a ChatGPT sign-in for the new worker session (the code shows on the screen).
3. The old worker is quenched: its ChatGPT session is revoked and its schedule taken off; its repository or project stays for a switch back. Right before that its status is read again: if an application with an unknown outcome appeared meanwhile, or a run of the worker on GitHub is under way, the switch is undone, the old worker stays active, and you switch again after its next run.
4. The new worker's schedule goes on, then a trial run.

`Esc` before step 3 stops the switch and leaves the old worker as it was. If the switch stops after step 3 began, no worker is active: `aures status` says so, `aures apply-now` and Enter on a reset refuse, and the screen «Worker» has one action, "Retry the switch". A paused worker is not switched: take it off pause first.

## When something breaks

When a worker run fails, the platform emails you: GitHub about an Actions failure, Google about a failed trigger. Run `aures status`: it shows the cause and the fix. Common cases:

| Message | What to do |
| --- | --- |
| The worker lost its ChatGPT sign-in | `aures login` and sign in again. Rules and history are kept. |
| The worker is disabled in GitHub | Open the link in the message and click **Enable workflow**. |
| The worker has not run for N h | Open the link in the message and check that GitHub Actions is working. Runs usually resume on their own. |
| GitHub has not run the worker on schedule for N h | Runs from the Mac and apply-now go through, but scheduled ones do not, and the before-expiry rule depends on them. Check GitHub Actions at the link in the message. |
| Google has not run the worker on schedule for N h | The same on Google: check the script's executions at the link in the message. |
| The worker has no schedule | Resets are not applied. Repair the worker: «Repair» on the «Worker» screen (`Tab` in `aures`) puts the schedule back. |
| The worker on Google does not answer (the script has no access, its web app is gone, this Mac's secret does not fit) | `aures setup` deploys the worker again. |
| The worker data in the Google project does not read (…) | `aures status` shows the reason. A reinstall helps: `aures uninstall`, then `aures setup`. |
| This is another ChatGPT account | Sign in to the account the worker was set up for. Switching accounts takes a reinstall: `uninstall`, then `setup`. |
| Setup is not finished | `aures setup`. |
| The worker is out of date | `aures upgrade`. |
| This Mac's ChatGPT sign-in is lost | `aures setup` and enter a ChatGPT code for this Mac again. |
| The check from this Mac is not running | `aures setup`: it installs the agent again. |

If `setup`, `rules` or `upgrade` prints "The check from this Mac did not start (launchctl …)", launchd did not take the agent. The rest of the command is done; run `aures setup` again.

## Upgrade

```sh
brew upgrade aures
aures upgrade
```

From source, in the project folder:

```sh
git pull && npm ci && npm run build:worker
aures upgrade
```

`aures upgrade` updates the worker in your repository; without it, the old version keeps running there. Rules, history and the ChatGPT sign-in are kept. With the weekly rule on, `upgrade` also reloads the Mac check agent when its plist changed.

With the worker on Google, `aures upgrade` puts the new version into the same project and the same deployment, so the web app keeps its URL; the rules, the worker's state and the run journal stay as they are. The upgrade needs the Google sign-in from the Keychain. Until aures' OAuth client is verified, a Google sign-in lives 7 days, so upgrade may open the sign-in again — pass it as in setup: tick every box, and on the «Google hasn't verified this app» screen click «Advanced» → «Go to … (unsafe)». The messages "The worker is updated, but the script has to be allowed to run again" and "The worker project or its deployment is gone from Google" mean the same thing: run `aures setup`, it deploys the worker anew.

Installed from source, the agent runs the `node` and the `src/cli/main.ts` you last ran `setup`, `rules` or `upgrade` with. If you move the folder or change Node, run `setup` again.

Installed with Homebrew, the agent runs the program through the link `$(brew --prefix)/opt/aures`, so after `brew upgrade` it runs the new version right away.

Before 0.3.0 the program was called `codex-auto-resets`. To move to the new name, upgrade once by the full name, then run `aures upgrade`:

```sh
brew update
brew upgrade keshaqaz/tap/aures
aures upgrade
```

Homebrew moves the installation to the new name by itself. The shorter forms do not work here: Homebrew 7 skips a plain `brew upgrade` and refuses `brew upgrade codex-auto-resets` until the new name is trusted. `aures upgrade` updates the worker and moves the Mac check agent to the `aures` command. The `codex-auto-resets-worker` repository, the GitHub sign-in and the files on the Mac keep their old names, so there is nothing to reinstall.

## Uninstall

```sh
aures uninstall
```

Then remove the program: `brew uninstall aures`. Installed from source, delete the project folder and the `alias aures=…` line in `~/.zshrc`.

`uninstall` asks you to confirm and removes the worker from the platform it runs on, together with everything of it on this Mac.

**On GitHub** `uninstall` asks you to sign in to GitHub once more: deleting a repository needs a separate permission, which the CLI does not keep. It then revokes the worker's ChatGPT sign-in and deletes the repository. Next it removes the Mac check agent, revokes the Mac's ChatGPT sign-in and deletes its files and log, and finally removes the GitHub sign-in from the Keychain. Open the GitHub page it links and click **Revoke** to close access completely.

**On Google** `uninstall` stops the worker — takes off its schedule, revokes its ChatGPT sign-in and the script's own access — deletes the web app, revokes aures' Google sign-in and removes the Google sign-in and the worker secret from the Keychain. After that nothing comes from the project (checked on the owner's account on 21 October 2026): the script's entry disappears from "Third-party apps" (myaccount.google.com/connections) by itself, a trigger left in the project's list no longer fires, and the web app, without the script's access, answers with a sign-in page only. The script project itself the CLI cannot delete: the Apps Script API has no call for it, and its Drive access (drive.file) does not extend to a standalone script project. So the last thing it prints are the manual steps:

```
Left to do by hand:
  1. Delete the project aures-worker on https://script.google.com/home/projects/…
  2. If https://myaccount.google.com/connections still lists aures-worker, remove its access.
```

Move the project to the trash on script.google.com yourself — or leave it: with no schedule, sign-in or access it does nothing.

If the program is already gone and the agent is still there, it's best to install the program again and run `uninstall`: only it revokes the Mac's ChatGPT sign-in. To remove the agent and the files by hand, without revoking the sign-in:

```sh
launchctl bootout gui/$(id -u)/com.github.keshaqaz.codex-auto-resets.watch
rm ~/Library/LaunchAgents/com.github.keshaqaz.codex-auto-resets.watch.plist
rm -r ~/Library/Application\ Support/codex-auto-resets ~/Library/Logs/codex-auto-resets
```

## What is stored where

| Where | What |
| --- | --- |
| Keychain on your Mac | the GitHub sign-in; with the worker on Google, also the Google sign-in and the web app secret (entries of service `codex-auto-resets`: `github`, `google`, `worker-secret`) |
| Repository `codex-auto-resets-worker` (GitHub) | the worker code, schedule, rules, an open summary (resets and their deadlines, no sign-in or account data) and the worker's encrypted ChatGPT sign-in |
| Secret `STATE_KEY` in the repository settings | the key that encrypts the worker's sign-in (GitHub) |
| Script project `aures-worker` (Google) | the worker code, schedule, the worker's ChatGPT sign-in, rules and the journal of the last 30 runs — all in the project's Script Properties |
| `~/Library/Application Support/codex-auto-resets/install.json` | the worker's platform, and on Google the URL of its web app |
| `~/Library/LaunchAgents/com.github.keshaqaz.codex-auto-resets.watch.plist` | the Mac check agent, while the weekly rule is on |
| `~/Library/Application Support/codex-auto-resets/chatgpt-session.json` | this Mac's ChatGPT sign-in, while the weekly rule is on |
| `~/Library/Application Support/codex-auto-resets/watch.json` | the weekly window the worker was already started for, and the outcome of the last check |
| `~/Library/Logs/codex-auto-resets/watch.log` | one line per Mac check, 20–35 KB a day, not rotated |

The GitHub sign-in gives the CLI access to all your repositories, like `gh`. The worker repository must stay private: if you make it public, the CLI refuses to work with it.

On Google the worker's ChatGPT sign-in lives in Script Properties unencrypted: a key would have to sit right next to it ([ADR-0007](adr/0007-two-worker-platforms.md)). The worker's web app is open at its URL, but it answers only requests with the secret from your Mac's Keychain and never returns tokens. The Google sign-in is needed by the CLI only to deploy or upgrade the worker.

The Mac's ChatGPT sign-in is kept in a `0600` file, not in the Keychain: it is longer than the CLI can safely pass to the Keychain (details in [ADR-0005](adr/0005-weekly-check-from-mac.md)). Any program running as your macOS user can read the file; that is the same level of access as the Codex sign-in. The sign-in is used only to read the limit, and `uninstall` revokes it.

## What it costs

Nothing — on either platform.

**GitHub.** GitHub Actions bills each worker run as at least one minute, which adds up to ~750 minutes a month. The Mac check adds at most one run per weekly window. The GitHub Free plan includes 2,000 minutes a month for private repositories. If your other private repositories use Actions too, keep the total in mind.

**Google.** The worker runs on Apps Script triggers. Google gives 90 minutes of total trigger runtime a day across all the scripts of your account; the aures worker takes about 5–10 of them. If your other scripts use Apps Script too, keep the total in mind.

Money is not the only price. On GitHub it is delayed scheduled runs, sometimes by hours, which is why the before-expiry window is 8 hours. On Google it is two «Google hasn't verified this app» screens, the API switch at install time and the script project you have to delete by hand on uninstall.
