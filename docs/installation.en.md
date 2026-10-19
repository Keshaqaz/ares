# Installation and use

**English** · [Русский](installation.md)

The CLI speaks English. For Russian press `l` on the screen or run `aures language ru`.

## What you need

- A Mac. The worker itself runs on GitHub; the Mac is for commands and, if you want it, for watching the weekly limit (see [The Mac check](#the-mac-check)).
- A GitHub account. The free plan is enough.
- A paid ChatGPT subscription that issues rate-limit resets.

## Install

```sh
brew install keshaqaz/tap/aures
```

From source (Node 26 required):

```sh
git clone https://github.com/Keshaqaz/ares.git && cd ares
npm ci && npm run build:worker
echo "alias aures='node $PWD/src/cli/main.mjs'" >> ~/.zshrc && source ~/.zshrc
```

The last line sets up the `aures` command this guide uses. Without it, run `node src/cli/main.mjs` from the project folder.

## First setup

```sh
aures setup
```

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

6. **Check.** The CLI runs the worker once and shows the result:

   ```
   The worker works. Resets: 2, the nearest expires 22 October 2026 at 15:00 UTC.
   ```

If `setup` is interrupted, run it again: it picks up where it stopped and loses nothing.

## Rules

| Rule | Default | What it does |
| --- | --- | --- |
| Before expiry (last 8 hours) | on | Applies a reset when less than 8 hours are left before it expires. |
| When the weekly limit runs out | off | As soon as the worker sees the weekly limit is used up, applies the reset that expires first. While the Mac is awake, the Mac check notices the end of the limit, and the reset comes within minutes. |

The rules cover all resets at once and work independently. Change them any time on the `aures` screen or with `aures rules`; new rules take effect from the next worker run. Turning the weekly rule on asks for a ChatGPT code for this Mac, as in step 5 of setup. Turning it off removes the Mac check and revokes the Mac's ChatGPT sign-in.

The worker runs about once an hour, but GitHub sometimes delays runs by several hours, so the rules don't fire at an exact minute.

## The Mac check

While the rule "When the weekly limit runs out" is on, a launchd agent runs `aures watch` every 2 minutes. It is a short pass with no windows and no questions:

1. It reads the weekly limit with the Mac's own ChatGPT sign-in. This spends neither the limit nor tokens.
2. If the limit has run out, it starts the worker through GitHub, once per weekly window, with the same GitHub sign-in from the Keychain that the commands use.
3. It writes the outcome as one timestamped line to `~/Library/Logs/codex-auto-resets/watch.log`.

The Mac never applies a reset itself. The worker reads the limit again with its own sign-in and decides by the rules, so a mistake on the Mac never spends a reset. The end of the limit is seen whichever client used it up: Codex, opencode, your phone, another computer.

The check works only while the Mac is awake and you are logged in to your macOS account. The rest of the time, the worker's scheduled run notices the end of the limit.

The agent asks nothing and signs in nowhere. If the Mac's ChatGPT sign-in is lost, the pass is skipped, and `status` says what to do. If there is no GitHub sign-in, the pass is skipped too; any command asks you to sign in again.

Lines in `watch.log` (after the time of the pass):

| Line | Meaning |
| --- | --- |
| `idle` | The limit has not run out, or the worker was already started for this weekly window. |
| `dispatched` | The limit ran out; the worker was started. |
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

The resets and their deadlines are on top, the general rules below, and under them a line about the worker: when it last ran and what it last applied. "applies soon" next to a reset means it is in its last 8 hours and the before-expiry rule will apply it.

- `↑` `↓` — pick a reset or a rule.
- `Enter` on a reset — apply it now. The screen asks to confirm; `y` is yes. The CLI waits for the worker and reports the result; this can take a few minutes. A reset is single-use, and applying it cannot be undone.
- `Enter` on a rule — switch it on or off. Turning the weekly rule on shows a ChatGPT code for this Mac, as in step 5 of setup.
- `l` — switch the language (EN · RU in the header); the choice is kept.
- `r` — refresh, `q` — quit.

If something is wrong, a line starting with `!` at the bottom says what to do. The weekly rule shows whether the Mac check works: "Mac check works" or "Mac check is not working". In the latter case the agent is not running or the Mac's ChatGPT sign-in is lost, and the `!` line says what to do.

`aures status` prints the same once, without the controls. `apply-now` and `rules` do what `Enter` on the screen does, with questions in the terminal.

## When something breaks

When a worker run fails, GitHub emails you. Run `aures status`: it shows the cause and the fix. Common cases:

| Message | What to do |
| --- | --- |
| The worker lost its ChatGPT sign-in | `aures login` and sign in again. Rules and history are kept. |
| The worker is disabled in GitHub | Open the link in the message and click **Enable workflow**. |
| The worker has not run for N h | Open the link in the message and check that GitHub Actions is working. Runs usually resume on their own. |
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

Installed from source, the agent runs the `node` and the `src/cli/main.mjs` you last ran `setup`, `rules` or `upgrade` with. If you move the folder or change Node, run `setup` again.

Installed with Homebrew, the agent runs the program through the link `$(brew --prefix)/opt/aures`, so after `brew upgrade` it runs the new version right away.

Before 0.3.0 the program was called `codex-auto-resets`. `brew upgrade` reinstalls it under the new name by itself; then run `aures upgrade`. It updates the worker and moves the Mac check agent to the `aures` command. The `codex-auto-resets-worker` repository, the GitHub sign-in and the files on the Mac keep their old names, so there is nothing to reinstall.

## Uninstall

```sh
aures uninstall
```

Then remove the program: `brew uninstall aures`. Installed from source, delete the project folder and the `alias aures=…` line in `~/.zshrc`.

`uninstall` asks you to sign in to GitHub once more: deleting a repository needs a separate permission, which the CLI does not keep. It then revokes the worker's ChatGPT sign-in and deletes the repository. Next it removes the Mac check agent, revokes the Mac's ChatGPT sign-in and deletes its files and log, and finally removes the GitHub sign-in from the Keychain. Open the GitHub page it links and click **Revoke** to close access completely.

If the program is already gone and the agent is still there, it's best to install the program again and run `uninstall`: only it revokes the Mac's ChatGPT sign-in. To remove the agent and the files by hand, without revoking the sign-in:

```sh
launchctl bootout gui/$(id -u)/com.github.keshaqaz.codex-auto-resets.watch
rm ~/Library/LaunchAgents/com.github.keshaqaz.codex-auto-resets.watch.plist
rm -r ~/Library/Application\ Support/codex-auto-resets ~/Library/Logs/codex-auto-resets
```

## What is stored where

| Where | What |
| --- | --- |
| Keychain on your Mac | the GitHub sign-in (entry `codex-auto-resets`) |
| Repository `codex-auto-resets-worker` | the worker code, schedule, rules, an open summary (resets and their deadlines, no sign-in or account data) and the worker's encrypted ChatGPT sign-in |
| Secret `STATE_KEY` in the repository settings | the key that encrypts the worker's sign-in |
| `~/Library/LaunchAgents/com.github.keshaqaz.codex-auto-resets.watch.plist` | the Mac check agent, while the weekly rule is on |
| `~/Library/Application Support/codex-auto-resets/chatgpt-session.json` | this Mac's ChatGPT sign-in, while the weekly rule is on |
| `~/Library/Application Support/codex-auto-resets/watch.json` | the weekly window the worker was already started for, and the outcome of the last check |
| `~/Library/Logs/codex-auto-resets/watch.log` | one line per Mac check, 20–35 KB a day, not rotated |

The GitHub sign-in gives the CLI access to all your repositories, like `gh`. The worker repository must stay private: if you make it public, the CLI refuses to work with it.

The Mac's ChatGPT sign-in is kept in a `0600` file, not in the Keychain: it is longer than the CLI can safely pass to the Keychain (details in [ADR-0005](adr/0005-weekly-check-from-mac.md)). Any program running as your macOS user can read the file; that is the same level of access as the Codex sign-in. The sign-in is used only to read the limit, and turning the weekly rule off or `uninstall` revokes it.

## What it costs

Nothing. GitHub Actions bills each worker run as at least one minute, which adds up to ~750 minutes a month. The Mac check adds at most one run per weekly window. The GitHub Free plan includes 2,000 minutes a month for private repositories. If your other private repositories use Actions too, keep the total in mind.
